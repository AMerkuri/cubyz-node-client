export const CHANNEL = {
  LOSSY: 0,
  FAST: 1,
  SLOW: 2,
  CONFIRMATION: 3,
  INIT: 4,
  KEEP_ALIVE: 5,
  DISCONNECT: 6,
} as const;

export type ChannelId = (typeof CHANNEL)[keyof typeof CHANNEL];
export type SequencedChannelId =
  | typeof CHANNEL.LOSSY
  | typeof CHANNEL.FAST
  | typeof CHANNEL.SLOW;

export const PROTOCOL = {
  HANDSHAKE: 1,
  PLAYER_STATE: 4,
  ENTITY_POSITION: 6,
  BLOCK_UPDATE: 7,
  ENTITY: 8,
  CHAT: 10,
} as const;

export type ProtocolId = (typeof PROTOCOL)[keyof typeof PROTOCOL];

export const HANDSHAKE_STATE = {
  START: 0,
  USER_DATA: 1,
  ASSETS: 2,
  SERVER_DATA: 3,
  COMPLETE: 255,
} as const;

export type HandshakeState =
  (typeof HANDSHAKE_STATE)[keyof typeof HANDSHAKE_STATE];

export const DEFAULT_PORT = 47649;
export const DEFAULT_VERSION = "0.0.0";

export const RESEND_TIMEOUT_MS = 500;
export const INIT_RESEND_INTERVAL_MS = 100;
export const CONFIRMATION_BATCH_SIZE = 16;
export const KEEP_ALIVE_INTERVAL_MS = 2000;
export const KEEP_ALIVE_TIMEOUT_MS = KEEP_ALIVE_INTERVAL_MS * 4;
export const AWAITING_SERVER_TIMEOUT_MS = 15_000;
export const MTU = 548; // matches minMtu from the Zig implementation
