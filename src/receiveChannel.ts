import { Buffer } from "node:buffer";
import { addSeq, readInt32BE, seqLessThan } from "./binary.js";
import { CHANNEL, type SequencedChannelId } from "./constants.js";

interface Chunk {
  buffer: Buffer;
  offset: number;
}

interface PendingEntryResult {
  accepted: boolean;
  ackStart: number;
  messages: ReceivedMessage[];
}

export interface ReceivedMessage {
  protocolId: number;
  payload: Buffer;
}

interface HeaderInfo {
  protocolId: number;
  size: number;
  headerLength: number;
}

interface PartialHeader {
  protocolId: number;
  size: number;
}

export interface SequencedChannelPacket {
  channelId: SequencedChannelId;
  start: number;
  payload: Buffer;
}

export class ReceiveChannel {
  public readonly channelId: SequencedChannelId;
  private expected: number;
  private readonly pending = new Map<number, Buffer>();
  private readonly chunks: Chunk[] = [];
  private bufferedLength = 0;
  private partialHeader: PartialHeader | null = null;

  constructor(channelId: SequencedChannelId, initialSequence: number) {
    this.channelId = channelId;
    this.expected = initialSequence;
  }

  handlePacket(start: number, payload: Buffer): PendingEntryResult {
    const responses: PendingEntryResult = {
      accepted: true,
      ackStart: start,
      messages: [],
    };

    if (seqLessThan(start, this.expected)) {
      return responses;
    }
    if (this.pending.has(start)) {
      return responses;
    }
    this.pending.set(start, payload);
    this.flushPending(responses.messages);

    return responses;
  }

  private flushPending(collectedMessages: ReceivedMessage[]): void {
    let progressed = false;
    while (true) {
      const chunk = this.pending.get(this.expected);
      if (!chunk) {
        break;
      }
      progressed = true;
      this.pending.delete(this.expected);
      this.enqueueChunk(chunk);
      this.expected = addSeq(this.expected, chunk.length);
    }
    if (progressed) {
      this.drainMessages(collectedMessages);
    }
  }

  private enqueueChunk(chunk: Buffer): void {
    this.chunks.push({ buffer: chunk, offset: 0 });
    this.bufferedLength += chunk.length;
  }

  private drainMessages(collectedMessages: ReceivedMessage[]): void {
    while (true) {
      if (this.partialHeader === null) {
        const header = this.peekHeader();
        if (!header) {
          break;
        }
        this.consumeBytes(header.headerLength);
        this.partialHeader = {
          protocolId: header.protocolId,
          size: header.size,
        };
      }
      if (this.bufferedLength < this.partialHeader.size) {
        break;
      }
      const payload = this.consumeBytes(this.partialHeader.size);
      collectedMessages.push({
        protocolId: this.partialHeader.protocolId,
        payload,
      });
      this.partialHeader = null;
    }
  }

  private peekHeader(): HeaderInfo | null {
    if (this.bufferedLength < 1) {
      return null;
    }
    const protocolId = this.peekByte(0);
    let size = 0;
    let bytesRead = 0;
    while (true) {
      const byteOffset = 1 + bytesRead;
      if (byteOffset >= this.bufferedLength) {
        return null;
      }
      const byte = this.peekByte(byteOffset);
      size = (size << 7) | (byte & 0x7f);
      bytesRead += 1;
      if ((byte & 0x80) === 0) {
        break;
      }
      if (bytesRead > 5) {
        throw new Error("Protocol length varint exceeds expected size");
      }
      if (1 + bytesRead > this.bufferedLength) {
        return null;
      }
    }
    return {
      protocolId,
      size,
      headerLength: 1 + bytesRead,
    };
  }

  private peekByte(offset: number): number {
    let remaining = offset;
    for (const chunk of this.chunks) {
      const available = chunk.buffer.length - chunk.offset;
      if (remaining < available) {
        return chunk.buffer[chunk.offset + remaining];
      }
      remaining -= available;
    }
    throw new RangeError("Peek offset beyond buffered data");
  }

  private consumeBytes(length: number): Buffer {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (length > this.bufferedLength) {
      throw new RangeError("consumeBytes length exceeds buffered data");
    }
    const segments: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      const available = chunk.buffer.length - chunk.offset;
      const take = Math.min(available, remaining);
      segments.push(chunk.buffer.slice(chunk.offset, chunk.offset + take));
      chunk.offset += take;
      if (chunk.offset === chunk.buffer.length) {
        this.chunks.shift();
      }
      this.bufferedLength -= take;
      remaining -= take;
    }
    return segments.length === 1 ? segments[0] : Buffer.concat(segments);
  }
}

export function parseChannelPacket(buffer: Buffer): SequencedChannelPacket {
  const channelId = buffer[0];
  if (
    channelId === CHANNEL.INIT ||
    channelId === CHANNEL.KEEP_ALIVE ||
    channelId === CHANNEL.DISCONNECT
  ) {
    throw new Error("parseChannelPacket received control channel");
  }
  if (buffer.length < 5) {
    throw new Error("Packet too small for sequenced data");
  }
  const start = readInt32BE(buffer, 1);
  const payload = buffer.slice(5);
  return { channelId: channelId as SequencedChannelId, start, payload };
}
