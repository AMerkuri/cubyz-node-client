import { Buffer } from "node:buffer";
import { addSeq, encodeVarInt, toInt32 } from "./binary.js";
import {
  MTU,
  RESEND_TIMEOUT_MS,
  type SequencedChannelId,
} from "./constants.js";

function concatBuffers(chunks: Buffer[]): Buffer {
  if (chunks.length === 1) {
    return chunks[0];
  }
  return Buffer.concat(chunks);
}

interface InFlightEntry {
  payload: Buffer;
  timestamp: number;
  len: number;
  retries: number;
}

export interface QueuedPacket {
  start: number;
  payload: Buffer;
  resend: boolean;
}

export class SendChannel {
  public readonly channelId: SequencedChannelId;
  public readonly initialSequence: number;
  private nextIndex: number;
  private fullyConfirmed: number;
  private readonly pendingMessages: Buffer[] = [];
  private readonly inFlight = new Map<number, InFlightEntry>();
  private readonly acked = new Map<number, number>();

  constructor(channelId: SequencedChannelId, initialSequence: number) {
    this.channelId = channelId;
    this.initialSequence = toInt32(initialSequence);
    this.nextIndex = this.initialSequence;
    this.fullyConfirmed = this.initialSequence;
  }

  queue(protocolId: number, payload: Buffer): void {
    const header = Buffer.from([protocolId]);
    const size = encodeVarInt(payload.length);
    const message = concatBuffers([header, size, payload]);
    this.pendingMessages.push(message);
  }

  hasWork(): boolean {
    return this.pendingMessages.length > 0 || this.inFlight.size > 0;
  }

  getPacket(now: number): QueuedPacket | null {
    for (const [start, entry] of this.inFlight) {
      if (now - entry.timestamp >= RESEND_TIMEOUT_MS) {
        entry.timestamp = now;
        entry.retries += 1;
        return {
          start,
          payload: entry.payload,
          resend: true,
        };
      }
    }

    if (this.pendingMessages.length === 0) {
      return null;
    }
    const message = this.pendingMessages.shift();
    if (!message) {
      return null;
    }
    if (message.length > MTU - 5) {
      throw new Error("Message exceeds MTU allowance for a single packet");
    }
    const start = this.nextIndex;
    const entry: InFlightEntry = {
      payload: message,
      timestamp: now,
      len: message.length,
      retries: 0,
    };
    this.inFlight.set(start, entry);
    this.nextIndex = addSeq(this.nextIndex, entry.len);
    return {
      start,
      payload: message,
      resend: false,
    };
  }

  handleAck(start: number): void {
    const entry = this.inFlight.get(start);
    if (entry) {
      this.inFlight.delete(start);
      this.acked.set(start, entry.len);
      this.advanceAcks();
      return;
    }
    if (!this.acked.has(start)) {
      this.acked.set(start, 0);
    }
    this.advanceAcks();
  }

  private advanceAcks(): void {
    while (this.acked.has(this.fullyConfirmed)) {
      const len = this.acked.get(this.fullyConfirmed);
      if (len === undefined) {
        break;
      }
      this.acked.delete(this.fullyConfirmed);
      if (len <= 0) {
        break;
      }
      this.fullyConfirmed = addSeq(this.fullyConfirmed, len);
    }
  }
}
