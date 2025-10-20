import { Buffer } from "node:buffer";
import { randomInt } from "node:crypto";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { readInt32BE, writeInt32BE } from "./binary.js";
import {
  CHANNEL,
  CONFIRMATION_BATCH_SIZE,
  DEFAULT_VERSION,
  HANDSHAKE_STATE,
  type HandshakeState,
  INIT_RESEND_INTERVAL_MS,
  KEEP_ALIVE_INTERVAL_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  PROTOCOL,
  type SequencedChannelId,
} from "./constants.js";
import { parseChannelPacket, ReceiveChannel } from "./receiveChannel.js";
import { SendChannel } from "./sendChannel.js";
import { parseZon, type ZonValue } from "./zon.js";

const DEG_TO_RAD = Math.PI / 180;

const LOG_LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_ORDER;

function randomSequence(): number {
  return randomInt(0, 0x7fffffff);
}

function escapeZonString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildHandshakePayload(name: string, version: string): Buffer {
  const safeName = escapeZonString(name);
  const safeVersion = escapeZonString(version);
  const zon = `.{.version = "${safeVersion}", .name = "${safeName}"}`;
  const prefix = Buffer.from([HANDSHAKE_STATE.USER_DATA]);
  return Buffer.concat([prefix, Buffer.from(zon, "utf8")]);
}

interface HandshakeMessage {
  state: HandshakeState;
  data: Buffer;
}

function parseHandshake(payload: Buffer): HandshakeMessage {
  if (!payload || payload.length === 0) {
    throw new Error("Handshake payload empty");
  }
  const state = payload[0] as HandshakeState;
  return { state, data: payload.slice(1) };
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface PlayerState {
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
}

export interface ProtocolEvent {
  channelId: number;
  protocolId: number;
  payload: Buffer;
}

export interface CubyzConnectionLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface CubyzConnectionOptions {
  host: string;
  port: number;
  name: string;
  version?: string;
  logger?: CubyzConnectionLogger;
  logLevel?: LogLevel;
}

export interface CloseOptions {
  notify?: boolean;
}

type ConnectionState = "awaitingServer" | "connected" | "closing" | "closed";

interface PendingConfirmation {
  channelId: number;
  start: number;
  timestamp: number;
}

type CubyzConnectionEvents = {
  connected: [];
  handshakeComplete: [string];
  chat: [string];
  players: [string[]];
  protocol: [ProtocolEvent];
  disconnect: [DisconnectEvent];
};

export interface DisconnectEvent {
  reason: "server" | "timeout";
}

export class CubyzConnection extends EventEmitter {
  public readonly host: string;
  public readonly port: number;
  public readonly name: string;
  public readonly version: string;
  private readonly baseLogger: CubyzConnectionLogger;
  private readonly logLevel: LogLevel;
  private readonly socket: dgram.Socket;
  private readonly connectionId: bigint;
  private remoteConnectionId: bigint | null = null;
  private state: ConnectionState = "awaitingServer";
  private handshakeComplete = false;
  private readonly sendChannels: Record<SequencedChannelId, SendChannel>;
  private readonly receiveChannels = new Map<
    SequencedChannelId,
    ReceiveChannel
  >();
  private readonly pendingConfirmations: PendingConfirmation[] = [];
  private readonly playerMap = new Map<number | string, string | null>();
  private lastKeepAliveSent = Date.now();
  private lastInbound = Date.now();
  private lastInitSent = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private playerStateTimer: NodeJS.Timeout | null = null;
  private readonly playerState: PlayerState = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
  private lastPlayerStateSent = 0;
  private disconnectSent = false;
  private disconnectEmitted = false;
  private initSent = false;
  private handshakeQueued = false;

  constructor({
    host,
    port,
    name,
    version = DEFAULT_VERSION,
    logger = console,
    logLevel = "error",
  }: CubyzConnectionOptions) {
    super();
    this.host = host;
    this.port = port;
    this.name = name;
    this.version = version;
    this.baseLogger = logger ?? console;
    this.logLevel = (
      logLevel in LOG_LEVEL_ORDER ? logLevel : "error"
    ) as LogLevel;

    this.socket = dgram.createSocket("udp4");
    this.connectionId = BigInt.asIntN(
      64,
      (BigInt(Date.now()) << 20n) | BigInt(randomInt(0, 0xfffff)),
    );

    this.sendChannels = {
      [CHANNEL.LOSSY]: new SendChannel(CHANNEL.LOSSY, randomSequence()),
      [CHANNEL.FAST]: new SendChannel(CHANNEL.FAST, randomSequence()),
      [CHANNEL.SLOW]: new SendChannel(CHANNEL.SLOW, randomSequence()),
    } as Record<SequencedChannelId, SendChannel>;

    this.socket.on("message", (msg: Buffer) => {
      try {
        const maybePromise = this.handlePacket(msg);
        if (maybePromise instanceof Promise) {
          maybePromise.catch((err) => {
            this.log("error", "Failed to process packet:", err);
          });
        }
      } catch (err) {
        this.log("error", "Failed to process packet:", err);
      }
    });

    this.socket.on("error", (err: Error) => {
      this.log("error", "Socket error:", err);
    });
  }

  private log(level: LogLevel, ...args: unknown[]): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.logLevel]) {
      return;
    }
    if (level === "silent") {
      return;
    }
    const method =
      level === "debug"
        ? this.baseLogger.debug
        : level === "info"
          ? this.baseLogger.info
          : level === "warn"
            ? this.baseLogger.warn
            : this.baseLogger.error;
    method?.(...args);
  }

  private emitDisconnect(reason: DisconnectEvent["reason"]): void {
    if (this.disconnectEmitted) {
      return;
    }
    this.disconnectEmitted = true;
    this.emit("disconnect", { reason });
  }

  on<K extends keyof CubyzConnectionEvents>(
    event: K,
    listener: (...args: CubyzConnectionEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  once<K extends keyof CubyzConnectionEvents>(
    event: K,
    listener: (...args: CubyzConnectionEvents[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  off<K extends keyof CubyzConnectionEvents>(
    event: K,
    listener: (...args: CubyzConnectionEvents[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  emit<K extends keyof CubyzConnectionEvents>(
    event: K,
    ...args: CubyzConnectionEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.socket.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.socket.off("error", onError);
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("listening", onListening);
      this.socket.bind(0);
    });
    const address = this.socket.address();
    this.log("info", `UDP socket bound on ${address.address}:${address.port}`);
    this.tickTimer = setInterval(() => this.tick(), 20);
    this.sendInit();
  }

  close(options: CloseOptions = {}): void {
    const { notify = true } = options;
    if (this.state === "closed" || this.state === "closing") {
      return;
    }
    this.state = "closing";

    const finalize = () => {
      if (this.state === "closed") {
        return;
      }
      if (this.tickTimer !== null) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      if (this.playerStateTimer !== null) {
        clearInterval(this.playerStateTimer);
        this.playerStateTimer = null;
      }
      this.state = "closed";
      this.socket.close();
    };

    if (notify) {
      this.sendDisconnectPacket(finalize);
    } else {
      finalize();
    }
  }

  private tick(): void {
    const now = Date.now();

    if (
      this.state === "awaitingServer" &&
      (!this.initSent || now - this.lastInitSent >= INIT_RESEND_INTERVAL_MS)
    ) {
      this.sendInit();
    }

    if (
      this.state === "connected" &&
      now - this.lastInbound >= KEEP_ALIVE_TIMEOUT_MS
    ) {
      this.log("warn", "Connection timed out due to inactivity");
      this.emitDisconnect("timeout");
      this.close({ notify: false });
      return;
    }

    if (now - this.lastKeepAliveSent >= KEEP_ALIVE_INTERVAL_MS) {
      this.sendKeepAlive();
    }

    this.flushConfirmations();
    this.flushSendQueues(now);
  }

  private flushSendQueues(now: number): void {
    for (const channel of Object.values(this.sendChannels)) {
      if (!channel.hasWork()) {
        continue;
      }
      const packet = channel.getPacket(now);
      if (!packet) {
        continue;
      }
      const buffer = Buffer.alloc(5 + packet.payload.length);
      buffer[0] = channel.channelId;
      writeInt32BE(buffer, 1, packet.start);
      packet.payload.copy(buffer, 5);
      this.socket.send(buffer, this.port, this.host);
    }
  }

  private queueConfirmation(channelId: number, start: number): void {
    this.pendingConfirmations.push({ channelId, start, timestamp: Date.now() });
  }

  private flushConfirmations(): void {
    if (this.pendingConfirmations.length === 0) {
      return;
    }
    const batch = this.pendingConfirmations.splice(0, CONFIRMATION_BATCH_SIZE);
    const buffer = Buffer.alloc(1 + batch.length * (1 + 2 + 4));
    buffer[0] = CHANNEL.CONFIRMATION;
    let offset = 1;
    const now = Date.now();
    for (const entry of batch) {
      buffer[offset] = entry.channelId;
      offset += 1;
      const dt = now - entry.timestamp;
      const half = Math.max(0, Math.min(0xffff, Math.floor(dt / 2)));
      buffer.writeUInt16BE(half, offset);
      offset += 2;
      writeInt32BE(buffer, offset, entry.start);
      offset += 4;
    }
    this.socket.send(buffer, this.port, this.host);
  }

  private sendKeepAlive(): void {
    this.lastKeepAliveSent = Date.now();
    const packet = Buffer.from([CHANNEL.KEEP_ALIVE]);
    this.socket.send(packet, this.port, this.host);
  }

  private sendInit(): void {
    this.lastInitSent = Date.now();
    const payload = Buffer.alloc(1 + 8 + 12);
    payload[0] = CHANNEL.INIT;
    payload.writeBigInt64BE(this.connectionId, 1);
    writeInt32BE(payload, 9, this.sendChannels[CHANNEL.LOSSY].initialSequence);
    writeInt32BE(payload, 13, this.sendChannels[CHANNEL.FAST].initialSequence);
    writeInt32BE(payload, 17, this.sendChannels[CHANNEL.SLOW].initialSequence);
    this.socket.send(payload, this.port, this.host);
    this.initSent = true;
  }

  private sendInitAck(): void {
    const buffer = Buffer.alloc(1 + 8);
    buffer[0] = CHANNEL.INIT;
    buffer.writeBigInt64BE(this.connectionId, 1);
    this.socket.send(buffer, this.port, this.host);
  }

  private ensureReceiveChannels(
    lossyStart: number,
    fastStart: number,
    slowStart: number,
  ): void {
    if (!this.receiveChannels.has(CHANNEL.LOSSY)) {
      this.receiveChannels.set(
        CHANNEL.LOSSY,
        new ReceiveChannel(CHANNEL.LOSSY, lossyStart),
      );
    }
    if (!this.receiveChannels.has(CHANNEL.FAST)) {
      this.receiveChannels.set(
        CHANNEL.FAST,
        new ReceiveChannel(CHANNEL.FAST, fastStart),
      );
    }
    if (!this.receiveChannels.has(CHANNEL.SLOW)) {
      this.receiveChannels.set(
        CHANNEL.SLOW,
        new ReceiveChannel(CHANNEL.SLOW, slowStart),
      );
    }
  }

  private handlePacket(buffer: Buffer): void | Promise<void> {
    if (!buffer || buffer.length === 0) {
      return;
    }
    const channelId = buffer[0];
    this.lastInbound = Date.now();
    switch (channelId) {
      case CHANNEL.INIT:
        this.handleInitPacket(buffer);
        break;
      case CHANNEL.CONFIRMATION:
        this.handleConfirmation(buffer.slice(1));
        break;
      case CHANNEL.KEEP_ALIVE:
        break;
      case CHANNEL.DISCONNECT:
        this.log("warn", "Server requested disconnect");
        this.emitDisconnect("server");
        this.close({ notify: false });
        break;
      default:
        return this.handleSequencedPacket(buffer);
    }
  }

  private handleInitPacket(buffer: Buffer): void {
    if (buffer.length === 1 + 8) {
      const remoteId = buffer.readBigInt64BE(1);
      if (this.remoteConnectionId === null && remoteId === this.connectionId) {
        this.log("debug", "Server acknowledged init");
      }
      return;
    }
    if (buffer.length < 1 + 8 + 12) {
      return;
    }
    const remoteId = buffer.readBigInt64BE(1);
    this.remoteConnectionId = remoteId;
    const lossyStart = readInt32BE(buffer, 9);
    const fastStart = readInt32BE(buffer, 13);
    const slowStart = readInt32BE(buffer, 17);
    this.ensureReceiveChannels(lossyStart, fastStart, slowStart);
    if (this.state !== "connected") {
      this.state = "connected";
      this.lastInbound = Date.now();
      this.log("info", "Channel handshake completed with server");
      this.sendInitAck();
      this.queueHandshake();
      this.emit("connected");
    }
  }

  private queueHandshake(): void {
    if (this.handshakeQueued) {
      return;
    }
    const payload = buildHandshakePayload(this.name, this.version);
    this.sendChannels[CHANNEL.FAST].queue(PROTOCOL.HANDSHAKE, payload);
    this.handshakeQueued = true;
  }

  private async handleSequencedPacket(buffer: Buffer): Promise<void> {
    const parsed = parseChannelPacket(buffer);
    const channel = this.receiveChannels.get(parsed.channelId);
    if (!channel) {
      return;
    }
    const result = channel.handlePacket(parsed.start, parsed.payload);
    if (!result.accepted) {
      return;
    }
    this.queueConfirmation(parsed.channelId, result.ackStart);
    for (const message of result.messages) {
      try {
        await this.handleProtocol(
          parsed.channelId,
          message.protocolId,
          message.payload,
        );
      } catch (err) {
        this.log("error", `Protocol ${message.protocolId} failed:`, err);
      }
    }
  }

  private handleConfirmation(buffer: Buffer): void {
    let offset = 0;
    while (offset + 7 <= buffer.length) {
      const channelId = buffer[offset];
      offset += 1;
      offset += 2;
      const start = buffer.readInt32BE(offset);
      offset += 4;
      const channel = this.sendChannels[channelId as SequencedChannelId];
      if (channel) {
        channel.handleAck(start);
      }
    }
  }

  private async handleProtocol(
    channelId: number,
    protocolId: number,
    payload: Buffer,
  ): Promise<void> {
    switch (protocolId) {
      case PROTOCOL.HANDSHAKE:
        await this.handleHandshake(payload);
        break;
      case PROTOCOL.ENTITY:
        this.handleEntityUpdate(payload);
        this.emit("protocol", { channelId, protocolId, payload });
        break;
      case PROTOCOL.CHAT:
        this.emit("chat", payload.toString("utf8"));
        break;
      default:
        this.emit("protocol", { channelId, protocolId, payload });
    }
  }

  private async handleHandshake(payload: Buffer): Promise<void> {
    const { state, data } = parseHandshake(payload);
    switch (state) {
      case HANDSHAKE_STATE.ASSETS: {
        // Assets are compressed with zlib's raw DEFLATE
        // Skipping asset storage for brevity
        break;
      }
      case HANDSHAKE_STATE.SERVER_DATA: {
        this.handshakeComplete = true;
        const zonText = data.toString("utf8");
        let selfInserted = false;
        try {
          const parsed = parseZon(zonText);
          const playerId =
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, ZonValue>).player_id
              : null;
          if (typeof playerId === "number") {
            this.playerMap.set(playerId, this.name);
            selfInserted = true;
          }
          const playerData =
            typeof parsed === "object" && parsed !== null
              ? (parsed as Record<string, ZonValue>).player
              : null;
          if (playerData && typeof playerData === "object") {
            const position = Array.isArray(
              (playerData as Record<string, ZonValue>).position,
            )
              ? ((playerData as Record<string, ZonValue>)
                  .position as ZonValue[])
              : null;
            if (position && position.length >= 3) {
              this.playerState.position = {
                x: Number(position[0]) || 0,
                y: Number(position[1]) || 0,
                z: Number(position[2]) || 0,
              };
            } else if (
              Array.isArray((parsed as Record<string, ZonValue>).spawn) &&
              ((parsed as Record<string, ZonValue>).spawn as ZonValue[])
                .length >= 3
            ) {
              const spawn = (parsed as Record<string, ZonValue>)
                .spawn as ZonValue[];
              this.playerState.position = {
                x: Number(spawn[0]) || 0,
                y: Number(spawn[1]) || 0,
                z: Number(spawn[2]) || 0,
              };
            }
            const velocity = Array.isArray(
              (playerData as Record<string, ZonValue>).velocity,
            )
              ? ((playerData as Record<string, ZonValue>)
                  .velocity as ZonValue[])
              : null;
            if (velocity && velocity.length >= 3) {
              this.playerState.velocity = {
                x: Number(velocity[0]) || 0,
                y: Number(velocity[1]) || 0,
                z: Number(velocity[2]) || 0,
              };
            }
            const rotation = Array.isArray(
              (playerData as Record<string, ZonValue>).rotation,
            )
              ? ((playerData as Record<string, ZonValue>)
                  .rotation as ZonValue[])
              : null;
            if (rotation && rotation.length >= 3) {
              this.playerState.rotation = {
                x: Number(rotation[0]) || 0,
                y: Number(rotation[1]) || 0,
                z: Number(rotation[2]) || 0,
              };
            }
          } else if (
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as Record<string, ZonValue>).spawn)
          ) {
            const spawn = (parsed as Record<string, ZonValue>)
              .spawn as ZonValue[];
            if (spawn.length >= 3) {
              this.playerState.position = {
                x: Number(spawn[0]) || 0,
                y: Number(spawn[1]) || 0,
                z: Number(spawn[2]) || 0,
              };
            }
          }
        } catch (err) {
          this.log("warn", "Failed to parse server data handshake:", err);
        }
        if (!selfInserted && !this.playerMap.has(`self:${this.name}`)) {
          this.playerMap.set(`self:${this.name}`, this.name);
        }
        this.emitPlayers();
        this.startPlayerStateLoop();
        this.publishPlayerState(true);
        this.emit("handshakeComplete", zonText);
        break;
      }
      case HANDSHAKE_STATE.USER_DATA:
        this.log("debug", "Server echoed user data");
        break;
      default:
        this.log("debug", `Unhandled handshake state ${state}`);
    }
  }

  private handleEntityUpdate(payload: Buffer): void {
    const text = payload.toString("utf8");
    let parsed: ZonValue;
    try {
      parsed = parseZon(text);
      this.log("debug", "Entity payload parsed successfully:", parsed);
    } catch (err) {
      this.log("warn", "Failed to parse entity payload:", err);
      this.log("debug", "Entity payload raw:", text);
      return;
    }
    if (!Array.isArray(parsed)) {
      return;
    }
    let changed = false;
    for (const entry of parsed) {
      if (entry === null) {
        break;
      }
      if (typeof entry === "number") {
        if (this.playerMap.delete(entry)) {
          changed = true;
        }
        continue;
      }
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, ZonValue>).id === "number"
      ) {
        const incomingName =
          typeof (entry as Record<string, ZonValue>).name === "string"
            ? ((entry as Record<string, ZonValue>).name as string)
            : null;
        const id = (entry as Record<string, ZonValue>).id as number;
        const previous = this.playerMap.get(id);
        if (incomingName !== previous) {
          this.playerMap.set(id, incomingName);
          changed = true;
        }
      }
    }
    if (changed) {
      if (this.playerMap.has(`self:${this.name}`)) {
        const placeholderName = this.playerMap.get(`self:${this.name}`);
        if (typeof placeholderName === "string") {
          for (const [key, value] of this.playerMap) {
            if (key === `self:${this.name}`) {
              continue;
            }
            if (value === placeholderName) {
              this.playerMap.delete(`self:${this.name}`);
              break;
            }
          }
        } else {
          this.playerMap.delete(`self:${this.name}`);
        }
      }
      this.emitPlayers();
    }
  }

  private emitPlayers(): void {
    const players = this.getPlayerNames();
    this.emit("players", players);
  }

  getPlayerNames(): string[] {
    const names: string[] = [];
    for (const value of this.playerMap.values()) {
      if (typeof value === "string" && value.length > 0) {
        names.push(value);
      }
    }
    return names;
  }

  sendChat(message: string): void {
    const payload = Buffer.from(message, "utf8");
    this.sendChannels[CHANNEL.LOSSY].queue(PROTOCOL.CHAT, payload);
  }

  teleport(x: number, y: number, z: number): void {
    const coords = [x, y, z].map((value) => Number(value));
    if (
      coords.some((value) => Number.isNaN(value) || !Number.isFinite(value))
    ) {
      this.log("warn", "Ignoring teleport with invalid coordinates", {
        x,
        y,
        z,
      });
      return;
    }
    this.log("info", "Updating position via state packet", {
      x: coords[0],
      y: coords[1],
      z: coords[2],
    });
    this.setPosition(coords[0], coords[1], coords[2]);
  }

  setRotation(yawDeg: number, pitchDeg = 0, rollDeg = 0): void {
    const yaw = Number(yawDeg);
    const pitch = Number(pitchDeg);
    const roll = Number(rollDeg);
    if (
      [yaw, pitch, roll].some(
        (value) => Number.isNaN(value) || !Number.isFinite(value),
      )
    ) {
      this.log("warn", "Ignoring rotation with invalid values", {
        yaw: yawDeg,
        pitch: pitchDeg,
        roll: rollDeg,
      });
      return;
    }
    this.playerState.rotation = {
      x: pitch * DEG_TO_RAD,
      y: roll * DEG_TO_RAD,
      z: yaw * DEG_TO_RAD,
    };
    this.log("info", "Updated rotation", {
      yaw,
      pitch,
      roll,
      mapping: "pitch→x, roll→y, yaw→z",
    });
    this.publishPlayerState(true);
  }

  setPosition(x: number, y: number, z: number): void {
    this.playerState.position = { x, y, z };
    this.playerState.velocity = { x: 0, y: 0, z: 0 };
    this.publishPlayerState(true);
  }

  publishPlayerState(force = false): void {
    if (!this.handshakeComplete) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastPlayerStateSent < 50) {
      return;
    }
    this.lastPlayerStateSent = now;
    const payload = this.encodePlayerStatePacket(this.playerState);
    this.sendChannels[CHANNEL.LOSSY].queue(PROTOCOL.PLAYER_STATE, payload);
  }

  private encodePlayerStatePacket(state: PlayerState): Buffer {
    const buffer = Buffer.alloc(62);
    let offset = 0;
    const writeDouble = (value: number) => {
      buffer.writeDoubleBE(Number.isFinite(value) ? value : 0, offset);
      offset += 8;
    };
    const writeFloat = (value: number) => {
      buffer.writeFloatBE(Number.isFinite(value) ? value : 0, offset);
      offset += 4;
    };

    writeDouble(state.position.x ?? 0);
    writeDouble(state.position.y ?? 0);
    writeDouble(state.position.z ?? 0);

    writeDouble(state.velocity.x ?? 0);
    writeDouble(state.velocity.y ?? 0);
    writeDouble(state.velocity.z ?? 0);

    writeFloat(state.rotation.x ?? 0);
    writeFloat(state.rotation.y ?? 0);
    writeFloat(state.rotation.z ?? 0);

    buffer.writeUInt16BE(Date.now() & 0xffff, offset);
    return buffer;
  }

  private startPlayerStateLoop(): void {
    if (this.playerStateTimer !== null) {
      return;
    }
    this.playerStateTimer = setInterval(() => {
      this.publishPlayerState();
    }, 100);
  }

  private sendDisconnectPacket(done?: () => void): void {
    if (this.disconnectSent) {
      done?.();
      return;
    }
    this.disconnectSent = true;
    const buffer = Buffer.from([CHANNEL.DISCONNECT]);
    try {
      this.socket.send(buffer, this.port, this.host, (err: Error | null) => {
        if (err) {
          this.log("warn", "Failed to send disconnect packet:", err);
        }
        done?.();
      });
    } catch (err) {
      this.log("warn", "Failed to queue disconnect packet:", err);
      done?.();
    }
  }
}
