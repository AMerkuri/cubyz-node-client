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

export interface BlockUpdate {
  position: Vector3;
  block: number;
  blockEntityData: Buffer;
}

export const GENERIC_UPDATE_TYPE = {
  GAMEMODE: 0,
  TELEPORT: 1,
  WORLD_EDIT_POS: 2,
  TIME: 3,
  BIOME: 4,
} as const;

export type GenericUpdateType =
  (typeof GENERIC_UPDATE_TYPE)[keyof typeof GENERIC_UPDATE_TYPE];

export const GAMEMODE = {
  SURVIVAL: 0,
  CREATIVE: 1,
} as const;

export type Gamemode = (typeof GAMEMODE)[keyof typeof GAMEMODE];

export const WORLD_EDIT_POSITION = {
  SELECTED_POS1: 0,
  SELECTED_POS2: 1,
  CLEAR: 2,
} as const;

export type WorldEditPositionType =
  (typeof WORLD_EDIT_POSITION)[keyof typeof WORLD_EDIT_POSITION];

export interface GamemodeUpdate {
  type: "gamemode";
  gamemode: Gamemode;
}

export interface TeleportUpdate {
  type: "teleport";
  position: Vector3;
}

export interface WorldEditPosUpdate {
  type: "worldEditPos";
  positionType: WorldEditPositionType;
  position: Vector3 | null;
}

export interface TimeUpdate {
  type: "time";
  time: bigint;
}

export interface BiomeUpdate {
  type: "biome";
  biomeId: number;
}

export type GenericUpdate =
  | GamemodeUpdate
  | TeleportUpdate
  | WorldEditPosUpdate
  | TimeUpdate
  | BiomeUpdate;

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
  blockUpdate: [BlockUpdate[]];
  players: [PlayersEvent];
  entityPositions: [EntityPositionPacket];
  genericUpdate: [GenericUpdate];
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
