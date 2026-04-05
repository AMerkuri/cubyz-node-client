import { Buffer } from "node:buffer";
import { randomInt } from "node:crypto";
import type { Identity } from "./authentication.js";
import { buildPublicKeysZon } from "./authentication.js";
import { HANDSHAKE_STATE, type HandshakeState } from "./constants.js";

export function randomSequence(): number {
  return randomInt(0, 0x7fffffff);
}

export function escapeZonString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function buildHandshakePayload(
  name: string,
  version: string,
  identity?: Identity,
): Buffer {
  const safeName = escapeZonString(name);
  const safeVersion = escapeZonString(version);
  let zon: string;
  if (identity) {
    const keysZon = buildPublicKeysZon(identity.keys);
    zon = `.{.version = "${safeVersion}", .name = "${safeName}", .keys = ${keysZon}}`;
  } else {
    zon = `.{.version = "${safeVersion}", .name = "${safeName}"}`;
  }
  const prefix = Buffer.from([HANDSHAKE_STATE.USER_DATA]);
  return Buffer.concat([prefix, Buffer.from(zon, "utf8")]);
}

export interface HandshakeMessage {
  state: HandshakeState;
  data: Buffer;
}

export function parseHandshake(payload: Buffer): HandshakeMessage {
  if (!payload || payload.length === 0) {
    throw new Error("Handshake payload empty");
  }
  const state = payload[0] as HandshakeState;
  return { state, data: payload.slice(1) };
}
