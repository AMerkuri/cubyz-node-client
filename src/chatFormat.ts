import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

// Chat message limits
// Note: The server allows up to 10,000 bytes and 1,000 visible characters,
// but the client must respect MTU constraints for LOSSY channel packets.
// MTU = 548 bytes:
//   - Channel ID + Sequence: 5 bytes
//   - Protocol ID: 1 byte
//   - VarInt size (2 bytes for messages under ~16KB): 2 bytes
//   - Maximum payload: 548 - 5 - 1 - 2 = 540 bytes
const MAX_VISIBLE_CHARACTERS = 1000;
const MAX_MESSAGE_BYTES = 540;

interface CodePoint {
  value: number;
  size: number;
}

function readCodePoint(
  text: string,
  cursor: { index: number },
): CodePoint | null {
  if (cursor.index >= text.length) {
    return null;
  }
  const value = text.codePointAt(cursor.index);
  if (value === undefined) {
    return null;
  }
  const size = value > 0xffff ? 2 : 1;
  cursor.index += size;
  return { value, size };
}

export function countVisibleCharacters(text: string): number {
  const cursor = { index: 0 };
  let current = readCodePoint(text, cursor);
  let count = 0;
  outer: while (current !== null) {
    switch (current.value) {
      case 0x2a: {
        // '*'
        current = readCodePoint(text, cursor);
        continue outer;
      }
      case 0x5f: {
        // '_'
        const next = readCodePoint(text, cursor);
        if (next === null) {
          break outer;
        }
        if (next.value === 0x5f) {
          current = readCodePoint(text, cursor);
          continue outer;
        }
        count += 1;
        current = next;
        continue outer;
      }
      case 0x7e: {
        // '~'
        const next = readCodePoint(text, cursor);
        if (next === null) {
          break outer;
        }
        if (next.value === 0x7e) {
          current = readCodePoint(text, cursor);
          continue outer;
        }
        count += 1;
        current = next;
        continue outer;
      }
      case 0x5c: {
        // '\'
        const escaped = readCodePoint(text, cursor);
        if (escaped === null) {
          count += 1;
          break outer;
        }
        count += 1;
        current = readCodePoint(text, cursor);
        continue outer;
      }
      case 0x23: {
        // '#'
        let next: CodePoint | null = null;
        for (let i = 0; i < 7; i += 1) {
          next = readCodePoint(text, cursor);
          if (next === null) {
            current = null;
            break outer;
          }
        }
        current = next;
        continue outer;
      }
      case 0xa7: {
        // '§'
        current = readCodePoint(text, cursor);
        continue outer;
      }
      default: {
        count += 1;
        current = readCodePoint(text, cursor);
        continue outer;
      }
    }
  }
  return count;
}

function assertNoInvalidUtf8(bytes: Buffer): void {
  try {
    textDecoder.decode(bytes);
  } catch (_error) {
    throw new RangeError("Chat message contains invalid UTF-8 encoding");
  }
}

export function prepareChatMessage(rawMessage: string): Buffer {
  let normalized = rawMessage.replace(/\r\n?/g, "\n");

  if (countVisibleCharacters(normalized) === 0) {
    throw new RangeError("Chat message cannot be empty");
  }

  let payload = Buffer.from(normalized, "utf8");
  assertNoInvalidUtf8(payload);

  // Trim message if it exceeds byte limit
  if (payload.length > MAX_MESSAGE_BYTES) {
    // Binary search for the right cut point (UTF-8 safe)
    let low = 0;
    let high = normalized.length;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      const testBuf = Buffer.from(`${normalized.slice(0, mid)}...`, "utf8");
      if (testBuf.length <= MAX_MESSAGE_BYTES) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    normalized = `${normalized.slice(0, low)}...`;
    payload = Buffer.from(normalized, "utf8");
  }

  // Trim if visible character count exceeds limit
  const visibleCharacters = countVisibleCharacters(normalized);
  if (visibleCharacters > MAX_VISIBLE_CHARACTERS) {
    // Trim character by character until we're under the limit
    let trimmed = normalized;
    while (
      countVisibleCharacters(`${trimmed}...`) > MAX_VISIBLE_CHARACTERS &&
      trimmed.length > 0
    ) {
      // Remove one character at a time (UTF-8 safe)
      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8");
      const bytes = encoder.encode(trimmed);
      let cutPoint = bytes.length - 1;
      // Skip continuation bytes (0x80-0xBF)
      while (cutPoint > 0 && (bytes[cutPoint] & 0xc0) === 0x80) {
        cutPoint--;
      }
      trimmed = decoder.decode(bytes.slice(0, cutPoint));
    }
    normalized = `${trimmed}...`;
    payload = Buffer.from(normalized, "utf8");
  }

  // Final validation
  for (const byte of payload) {
    if (byte === 0xff || byte === 0xfe) {
      throw new Error("Chat message contains invalid UTF-8 sentinel bytes");
    }
  }

  return payload;
}
