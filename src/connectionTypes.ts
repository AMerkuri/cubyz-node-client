import type { Buffer } from "node:buffer";

export const DEG_TO_RAD = Math.PI / 180;

export const LOG_LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
} as const;

export const ENTITY_POSITION_TYPE = {
  NO_VELOCITY_ENTITY: 0,
  F16_VELOCITY_ENTITY: 1,
  F32_VELOCITY_ENTITY: 2,
  NO_VELOCITY_ITEM: 3,
  F16_VELOCITY_ITEM: 4,
  F32_VELOCITY_ITEM: 5,
} as const;

export type EntityPositionType =
  (typeof ENTITY_POSITION_TYPE)[keyof typeof ENTITY_POSITION_TYPE];

export type LogLevel = keyof typeof LOG_LEVEL_ORDER;

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

export interface EntitySnapshot {
  id: number;
  position: Vector3;
  velocity: Vector3;
  rotation: Vector3;
  timestamp: number;
}

export interface ItemSnapshot {
  index: number;
  position: Vector3;
  velocity: Vector3;
  timestamp: number;
}

export interface EntityPositionPacket {
  timestamp: number;
  basePosition: Vector3;
  entities: EntitySnapshot[];
  items: ItemSnapshot[];
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

export type ConnectionState =
  | "awaitingServer"
  | "connected"
  | "closing"
  | "closed";

export interface PendingConfirmation {
  channelId: number;
  start: number;
  timestamp: number;
}

export type CubyzConnectionEvents = {
  connected: [];
  handshakeComplete: [string];
  chat: [string];
  players: [PlayersEvent];
  entityPositions: [EntityPositionPacket];
  protocol: [ProtocolEvent];
  disconnect: [DisconnectEvent];
};

export interface DisconnectEvent {
  reason: "server" | "timeout";
}

export type PlayersEvent = PlayerData[];

export interface PlayerData {
  id: number;
  name: string;
}
