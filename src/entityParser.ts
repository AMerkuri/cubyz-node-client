import type { Buffer } from "node:buffer";
import { readFloat16BE } from "./binary.js";
import {
  ENTITY_POSITION_TYPE,
  type EntityPositionPacket,
  type EntityPositionType,
  type EntitySnapshot,
  type ItemSnapshot,
  type LogLevel,
  type Vector3,
} from "./connectionTypes.js";

export type EntityParserLogger = (level: LogLevel, ...args: unknown[]) => void;

export function parseEntityPositionPacket(
  payload: Buffer,
  log: EntityParserLogger,
): EntityPositionPacket | null {
  const headerSize = 2 + 8 * 3;
  if (payload.length < headerSize) {
    log("warn", "Entity position payload too short", {
      length: payload.length,
    });
    return null;
  }

  let offset = 0;
  const ensure = (size: number) => {
    if (offset + size > payload.length) {
      throw new Error(
        `Entity position packet truncated, needed ${size} bytes at offset ${offset}`,
      );
    }
  };

  const readVec3f32 = (): Vector3 => {
    ensure(12);
    const vector: Vector3 = {
      x: payload.readFloatBE(offset),
      y: payload.readFloatBE(offset + 4),
      z: payload.readFloatBE(offset + 8),
    };
    offset += 12;
    return vector;
  };

  const readVec3f16 = (): Vector3 => {
    ensure(6);
    const vector: Vector3 = {
      x: readFloat16BE(payload, offset),
      y: readFloat16BE(payload, offset + 2),
      z: readFloat16BE(payload, offset + 4),
    };
    offset += 6;
    return vector;
  };

  try {
    ensure(2);
    const timestamp = payload.readInt16BE(offset);
    offset += 2;
    ensure(24);
    const basePosition: Vector3 = {
      x: payload.readDoubleBE(offset),
      y: payload.readDoubleBE(offset + 8),
      z: payload.readDoubleBE(offset + 16),
    };
    offset += 24;

    const nextEntityStates = new Map<number, EntitySnapshot>();
    const nextItemStates = new Map<number, ItemSnapshot>();
    const entitiesForEvent: EntitySnapshot[] = [];
    const itemsForEvent: ItemSnapshot[] = [];

    while (offset < payload.length) {
      ensure(1);
      const type = payload[offset] as EntityPositionType;
      offset += 1;

      let velocity: Vector3 = { x: 0, y: 0, z: 0 };

      if (
        type === ENTITY_POSITION_TYPE.F16_VELOCITY_ENTITY ||
        type === ENTITY_POSITION_TYPE.F16_VELOCITY_ITEM
      ) {
        velocity = readVec3f16();
      } else if (
        type === ENTITY_POSITION_TYPE.F32_VELOCITY_ENTITY ||
        type === ENTITY_POSITION_TYPE.F32_VELOCITY_ITEM
      ) {
        velocity = readVec3f32();
      }

      switch (type) {
        case ENTITY_POSITION_TYPE.NO_VELOCITY_ENTITY:
        case ENTITY_POSITION_TYPE.F16_VELOCITY_ENTITY:
        case ENTITY_POSITION_TYPE.F32_VELOCITY_ENTITY: {
          ensure(4);
          const id = payload.readUInt32BE(offset);
          offset += 4;
          const delta = readVec3f32();
          const rotation = readVec3f32();
          const position: Vector3 = {
            x: basePosition.x + delta.x,
            y: basePosition.y + delta.y,
            z: basePosition.z + delta.z,
          };
          const state: EntitySnapshot = {
            id,
            position,
            velocity,
            rotation,
            timestamp,
          };
          nextEntityStates.set(id, state);
          entitiesForEvent.push({
            id,
            position: { ...position },
            velocity: { ...velocity },
            rotation: { ...rotation },
            timestamp,
          });
          break;
        }
        case ENTITY_POSITION_TYPE.NO_VELOCITY_ITEM:
        case ENTITY_POSITION_TYPE.F16_VELOCITY_ITEM:
        case ENTITY_POSITION_TYPE.F32_VELOCITY_ITEM: {
          ensure(2);
          const index = payload.readUInt16BE(offset);
          offset += 2;
          const delta = readVec3f32();
          const position: Vector3 = {
            x: basePosition.x + delta.x,
            y: basePosition.y + delta.y,
            z: basePosition.z + delta.z,
          };
          const state: ItemSnapshot = {
            index,
            position,
            velocity,
            timestamp,
          };
          nextItemStates.set(index, state);
          itemsForEvent.push({
            index,
            position: { ...position },
            velocity: { ...velocity },
            timestamp,
          });
          break;
        }
        default: {
          log("warn", "Unknown entity position entry type", { type });
          return null;
        }
      }
    }

    return {
      timestamp,
      basePosition: { ...basePosition },
      entities: entitiesForEvent,
      items: itemsForEvent,
      _entityStates: nextEntityStates,
      _itemStates: nextItemStates,
    } as EntityPositionPacket & {
      _entityStates: Map<number, EntitySnapshot>;
      _itemStates: Map<number, ItemSnapshot>;
    };
  } catch (err) {
    log("warn", "Failed to decode entity position payload", err);
    return null;
  }
}
