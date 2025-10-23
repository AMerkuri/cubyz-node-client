import { Buffer } from "node:buffer";

export function encodeVarInt(value: number): Buffer {
  if (value < 0) {
    throw new RangeError("VarInt cannot encode negative values");
  }
  // Cubyz uses big-endian varint encoding (MSB first)
  const bytes: number[] = [];
  const val = value >>> 0;

  if (val === 0) {
    return Buffer.from([0]);
  }

  // Calculate number of bits needed
  const bits = val === 0 ? 1 : Math.floor(Math.log2(val)) + 1;
  // Calculate number of 7-bit chunks needed
  const numBytes = Math.ceil(bits / 7);

  // Encode big-endian (most significant byte first)
  for (let i = 0; i < numBytes; i++) {
    const shift = 7 * (numBytes - i - 1);
    let byte = (val >>> shift) & 0x7f;
    // Set continuation bit on all bytes except the last
    if (i < numBytes - 1) {
      byte |= 0x80;
    }
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}

export function decodeVarInt(
  buffer: Buffer,
  offset = 0,
): { value: number; consumed: number } {
  // Cubyz uses big-endian varint decoding (MSB first)
  let value = 0;
  let consumed = 0;

  while (offset + consumed < buffer.length) {
    const byte = buffer[offset + consumed];
    value = (value << 7) | (byte & 0x7f);
    consumed += 1;

    // Last byte has no continuation bit
    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, consumed };
    }

    if (consumed >= 5) {
      throw new Error("VarInt decoding failed: value too large");
    }
  }
  throw new Error("VarInt decoding failed: reached end of buffer");
}

export function toInt32(value: number): number {
  return (value << 0) | 0;
}

export function addSeq(base: number, delta: number): number {
  return toInt32((base + delta) | 0);
}

export function seqLessThan(a: number, b: number): boolean {
  return toInt32(a - b) < 0;
}

export function writeInt32BE(
  buffer: Buffer,
  offset: number,
  value: number,
): void {
  buffer.writeInt32BE(toInt32(value), offset);
}

export function readInt32BE(buffer: Buffer, offset: number): number {
  return buffer.readInt32BE(offset);
}

export function readFloat16BE(buffer: Buffer, offset: number): number {
  const raw = buffer.readUInt16BE(offset);
  const sign = (raw & 0x8000) !== 0 ? -1 : 1;
  const exponent = (raw >> 10) & 0x1f;
  const fraction = raw & 0x3ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign * 0;
    }
    return sign * 2 ** -14 * (fraction / 0x400);
  }

  if (exponent === 0x1f) {
    return fraction === 0 ? sign * Infinity : Number.NaN;
  }

  return sign * 2 ** (exponent - 15) * (1 + fraction / 0x400);
}
