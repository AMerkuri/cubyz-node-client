import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { WORDLIST } from "./wordlist.js";

// Key salts from authentication.zig lines 59-63
const KEY_SALTS = [
  "n59zw0qz53q05b73q9a50vmso",
  "4t7z3592a09p85z4piotfh7z",
  "u89564epogz1qi9up5zc94309",
] as const;

// PKCS8 DER prefix for Ed25519 private key (32-byte seed appended after)
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

// PKCS8 DER prefix for P-256 private key (32-byte seed appended at offset 36)
const P256_PKCS8_PREFIX = Buffer.from(
  "3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420",
  "hex",
);

export interface KeySet {
  ed25519PrivKey: Buffer; // 32-byte seed
  ed25519PubKey: Buffer; // 32-byte public key
  p256PrivKey: Buffer; // 32-byte private scalar
  p256PubKey: Buffer; // 65-byte uncompressed SEC1 point
  mlDsa44PrivKey: Uint8Array; // ML-DSA-44 secret key
  mlDsa44PubKey: Buffer; // 1312-byte public key
}

function deriveKeyMaterial(accountCodeText: string, saltIndex: number): Buffer {
  const salt = KEY_SALTS[saltIndex];
  let hashedResult: Buffer = Buffer.alloc(64);
  for (let j = 0; j < 2048; j++) {
    const input =
      j === 0 ? Buffer.from(accountCodeText + salt, "utf8") : hashedResult;
    hashedResult = createHash("sha512").update(input).digest();
  }
  return hashedResult.slice(0, 32);
}

function deriveEd25519(seed: Buffer): {
  privKey: Buffer;
  pubKey: Buffer;
} {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pubDer = createPublicKey(privKey)
    .export({ format: "der", type: "spki" })
    .slice(-32);
  return { privKey: seed, pubKey: Buffer.from(pubDer) };
}

function deriveP256(seed: Buffer): {
  privKey: Buffer;
  pubKey: Buffer;
} {
  const der = Buffer.concat([P256_PKCS8_PREFIX, seed]);
  const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const pubDer = createPublicKey(privKey)
    .export({ format: "der", type: "spki" })
    .slice(-65);
  return { privKey: seed, pubKey: Buffer.from(pubDer) };
}

export function derToCompact(derSig: Buffer): Buffer {
  // Parse DER SEQUENCE { INTEGER r, INTEGER s }
  // Structure: 30 <total-len> 02 <r-len> <r-bytes> 02 <s-len> <s-bytes>
  let offset = 0;
  if (derSig[offset++] !== 0x30) {
    throw new Error("Expected SEQUENCE tag 0x30");
  }
  // Skip length (may be 1 or 2 bytes)
  if (derSig[offset] & 0x80) {
    offset += (derSig[offset] & 0x7f) + 1;
  } else {
    offset += 1;
  }
  if (derSig[offset++] !== 0x02) {
    throw new Error("Expected INTEGER tag 0x02 for r");
  }
  const rLen = derSig[offset++];
  const rBytes = derSig.slice(offset, offset + rLen);
  offset += rLen;
  if (derSig[offset++] !== 0x02) {
    throw new Error("Expected INTEGER tag 0x02 for s");
  }
  const sLen = derSig[offset++];
  const sBytes = derSig.slice(offset, offset + sLen);

  // Strip leading zero padding and left-pad to 32 bytes
  const rStripped = rBytes[0] === 0 ? rBytes.slice(1) : rBytes;
  const sStripped = sBytes[0] === 0 ? sBytes.slice(1) : sBytes;

  const compact = Buffer.alloc(64, 0);
  rStripped.copy(compact, 32 - rStripped.length);
  sStripped.copy(compact, 64 - sStripped.length);
  return compact;
}

export function signEd25519(seed: Buffer, message: Buffer): Buffer {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return sign(null, message, privKey);
}

export function signP256(seed: Buffer, message: Buffer): Buffer {
  const der = Buffer.concat([P256_PKCS8_PREFIX, seed]);
  const privKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const derSig = sign("sha256", message, privKey);
  return derToCompact(derSig);
}

export async function signMlDsa44(
  secretKey: Uint8Array,
  message: Buffer,
): Promise<Buffer> {
  // Lazy import to avoid top-level dependency issue
  const { ml_dsa44 } = await import("@noble/post-quantum/ml-dsa");
  const sig = ml_dsa44.sign(secretKey, message);
  return Buffer.from(sig);
}

export async function deriveKeys(accountCodeText: string): Promise<KeySet> {
  const { ml_dsa44 } = await import("@noble/post-quantum/ml-dsa");

  const ed25519Seed = deriveKeyMaterial(accountCodeText, 0);
  const p256Seed = deriveKeyMaterial(accountCodeText, 1);
  const mldsaSeed = deriveKeyMaterial(accountCodeText, 2);

  const ed25519 = deriveEd25519(ed25519Seed);
  const p256 = deriveP256(p256Seed);

  // ML-DSA-44: generateDeterministic from 32-byte seed
  const mldsaKeyPair = ml_dsa44.keygen(mldsaSeed);

  return {
    ed25519PrivKey: ed25519.privKey,
    ed25519PubKey: ed25519.pubKey,
    p256PrivKey: p256.privKey,
    p256PubKey: p256.pubKey,
    mlDsa44PrivKey: mldsaKeyPair.secretKey,
    mlDsa44PubKey: Buffer.from(mldsaKeyPair.publicKey),
  };
}

export interface Identity {
  accountCode: string;
  keys: KeySet;
}

function generateAccountCode(): string {
  // Generate 20 random bytes + checksum byte = 21 bytes
  const bits = Buffer.alloc(21, 0);
  randomBytes(20).copy(bits, 0);
  const sha256 = createHash("sha256").update(bits.slice(0, 20)).digest();
  bits[20] = sha256[0];

  const words: string[] = [];
  for (let i = 0; i < 15; i++) {
    const bitIndex = i * 11;
    const byteIndex = Math.floor(bitIndex / 8);
    const b0 = bits[byteIndex];
    const b1 = bits[byteIndex + 1];
    const b2 = byteIndex + 2 < bits.length ? bits[byteIndex + 2] : 0;
    const containingRegion = (b0 << 16) | (b1 << 8) | b2;
    const shift = 24 - 11 - (bitIndex % 8);
    const wordIndex = (containingRegion >> shift) & 0x7ff;
    words.push(WORDLIST[wordIndex]);
  }
  return words.join(" ");
}

export async function loadOrCreateIdentity(
  filePath: string,
): Promise<Identity> {
  let accountCode: string | null = null;
  try {
    const contents = await readFile(filePath, "utf8");
    accountCode = contents.trim();
  } catch {
    // File does not exist; generate a new identity
  }

  if (!accountCode) {
    accountCode = generateAccountCode();
    await writeFile(filePath, `${accountCode}\n`, "utf8");
  }

  const keys = await deriveKeys(accountCode);
  return { accountCode, keys };
}

export function buildPublicKeysZon(keys: KeySet): string {
  const ed25519B64 = keys.ed25519PubKey.toString("base64");
  const p256B64 = keys.p256PubKey.toString("base64");
  const mldsaB64 = keys.mlDsa44PubKey.toString("base64");
  return `{.ed25519 = "${ed25519B64}", .ecdsaP256Sha256 = "${p256B64}", .mldsa44 = "${mldsaB64}"}`;
}
