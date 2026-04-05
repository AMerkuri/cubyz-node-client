import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import type dgram from "node:dgram";
import { writeInt32BE } from "./binary.js";

// MSB-first varint encoding (Zig BinaryWriter.writeVarInt format)
// This is the format used for framing messages sent over the TLS channel.
export function encodeMsbVarInt(value: number): Buffer {
  if (value === 0) return Buffer.from([0]);
  const bits = Math.floor(Math.log2(value)) + 1;
  const numBytes = Math.ceil(bits / 7);
  const result = Buffer.alloc(numBytes);
  for (let i = 0; i < numBytes; i++) {
    const shift = 7 * (numBytes - i - 1);
    result[i] = ((value >> shift) & 0x7f) | (i === numBytes - 1 ? 0 : 0x80);
  }
  return result;
}

// ---------------------------------------------------------------------------
// TLS 1.3 constants
// ---------------------------------------------------------------------------

const TLS_VERSION_12 = 0x0303; // used in legacy_version fields
const _TLS_VERSION_13 = 0x0304;
const CONTENT_HANDSHAKE = 0x16;
const CONTENT_CCS = 0x14;
const CONTENT_APP_DATA = 0x17;
const HS_CLIENT_HELLO = 1;
const HS_SERVER_HELLO = 2;
const HS_FINISHED = 20;
const EXT_SUPPORTED_VERSIONS = 0x002b;
const EXT_SUPPORTED_GROUPS = 0x000a;
const EXT_KEY_SHARE = 0x0033;
const EXT_SIG_ALGS = 0x000d;
const GROUP_X25519 = 0x001d;
const CIPHER_AES256GCM_SHA384 = 0x1302;
const CIPHER_AES128GCM_SHA256 = 0x1301;
const CIPHER_CHACHA20_SHA256 = 0x1303;

// ---------------------------------------------------------------------------
// TLS 1.3 key schedule helpers (RFC 8446)
// ---------------------------------------------------------------------------

// HKDF-Expand-Label: https://www.rfc-editor.org/rfc/rfc8446#section-7.1
// HKDF-Expand (RFC 5869 §2.3) — pure expand, no extract step.
// Needed because Node's hkdfSync does Extract+Expand combined.
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hashLen = 48; // SHA-384
  const n = Math.ceil(length / hashLen);
  const okm = Buffer.alloc(n * hashLen);
  let t = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    const input = Buffer.concat([t, info, Buffer.from([i])]);
    t = Buffer.from(createHmac("sha384", prk).update(input).digest());
    t.copy(okm, (i - 1) * hashLen);
  }
  return okm.slice(0, length);
}

function expandLabel(
  secret: Buffer,
  label: string,
  context: Buffer,
  length: number,
  _hash: string,
): Buffer {
  const labelBuf = Buffer.from(`tls13 ${label}`, "utf8");
  const hkdfLabelBuf = Buffer.alloc(
    2 + 1 + labelBuf.length + 1 + context.length,
  );
  let off = 0;
  hkdfLabelBuf.writeUInt16BE(length, off);
  off += 2;
  hkdfLabelBuf[off++] = labelBuf.length;
  labelBuf.copy(hkdfLabelBuf, off);
  off += labelBuf.length;
  hkdfLabelBuf[off++] = context.length;
  context.copy(hkdfLabelBuf, off);
  return hkdfExpand(secret, hkdfLabelBuf, length);
}

// HKDF-Extract
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha384", salt).update(ikm).digest();
}

// Derive-Secret(secret, label, messages)
function deriveSecret(
  secret: Buffer,
  label: string,
  transcript: Buffer,
): Buffer {
  const hashLen = 48; // SHA-384
  const h = createHash("sha384").update(transcript).digest();
  return expandLabel(secret, label, Buffer.from(h), hashLen, "sha384");
}

interface Tls13Keys {
  key: Buffer;
  iv: Buffer;
}

function deriveTrafficKeys(secret: Buffer): Tls13Keys {
  const key = expandLabel(secret, "key", Buffer.alloc(0), 32, "sha384"); // AES-256 = 32 bytes
  const iv = expandLabel(secret, "iv", Buffer.alloc(0), 12, "sha384");
  return { key, iv };
}

// Build per-record nonce: IV XOR seq (RFC 8446 §5.3)
function buildNonce(iv: Buffer, seq: bigint): Buffer {
  const nonce = Buffer.from(iv);
  for (let i = 0; i < 8; i++) {
    nonce[iv.length - 1 - i] ^= Number((seq >> BigInt(8 * i)) & 0xffn);
  }
  return nonce;
}

// Encrypt a TLS 1.3 record.  Appends the inner content type byte.
function encryptRecord(
  plaintext: Buffer,
  innerContentType: number,
  key: Buffer,
  iv: Buffer,
  seq: bigint,
): Buffer {
  const inner = Buffer.concat([plaintext, Buffer.from([innerContentType])]);
  const nonce = buildNonce(iv, seq);
  // Additional data: TLSCiphertext header (content_type=ApplicationData, version=TLS1.2, length=inner+16)
  const aad = Buffer.alloc(5);
  aad[0] = CONTENT_APP_DATA;
  aad.writeUInt16BE(TLS_VERSION_12, 1);
  aad.writeUInt16BE(inner.length + 16, 3);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(inner), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([aad, encrypted, authTag]);
}

// Decrypt a TLS 1.3 AppData record.  Returns { plaintext, innerContentType }.
function decryptRecord(
  record: Buffer, // full TLS record including 5-byte header
  key: Buffer,
  iv: Buffer,
  seq: bigint,
): { plaintext: Buffer; innerContentType: number } | null {
  if (record.length < 5 + 16) {
    return null;
  }
  const ciphertextWithTag = record.slice(5);
  const aad = record.slice(0, 5);
  const tagOff = ciphertextWithTag.length - 16;
  const ciphertext = ciphertextWithTag.slice(0, tagOff);
  const authTag = ciphertextWithTag.slice(tagOff);
  const nonce = buildNonce(iv, seq);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const inner = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    // Strip inner content type (last non-zero byte)
    let padEnd = inner.length - 1;
    while (padEnd > 0 && inner[padEnd] === 0) {
      padEnd--;
    }
    const innerContentType = inner[padEnd];
    const plaintext = inner.slice(0, padEnd);
    return { plaintext, innerContentType };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TLS record serialisation helpers
// ---------------------------------------------------------------------------

function makeTlsRecord(contentType: number, data: Buffer): Buffer {
  const rec = Buffer.alloc(5 + data.length);
  rec[0] = contentType;
  rec.writeUInt16BE(TLS_VERSION_12, 1);
  rec.writeUInt16BE(data.length, 3);
  data.copy(rec, 5);
  return rec;
}

function makeHandshakeMsg(handshakeType: number, body: Buffer): Buffer {
  const msg = Buffer.alloc(4 + body.length);
  msg[0] = handshakeType;
  msg[1] = (body.length >> 16) & 0xff;
  msg[2] = (body.length >> 8) & 0xff;
  msg[3] = body.length & 0xff;
  body.copy(msg, 4);
  return msg;
}

// ---------------------------------------------------------------------------
// ClientHello builder
// ---------------------------------------------------------------------------

function buildClientHello(clientRandom: Buffer, x25519PubKey: Buffer): Buffer {
  // Extensions
  const extSupportedVersions = (() => {
    const body = Buffer.from([0x02, 0x03, 0x04]); // list-len=2, TLS 1.3
    const ext = Buffer.alloc(4 + body.length);
    ext.writeUInt16BE(EXT_SUPPORTED_VERSIONS, 0);
    ext.writeUInt16BE(body.length, 2);
    body.copy(ext, 4);
    return ext;
  })();

  const extSupportedGroups = (() => {
    // x25519 only
    const body = Buffer.from([0x00, 0x02, 0x00, 0x1d]);
    const ext = Buffer.alloc(4 + body.length);
    ext.writeUInt16BE(EXT_SUPPORTED_GROUPS, 0);
    ext.writeUInt16BE(body.length, 2);
    body.copy(ext, 4);
    return ext;
  })();

  const extSigAlgs = (() => {
    // rsa_pss_rsae_sha256 (0x0804), ecdsa_secp256r1_sha256 (0x0403),
    // rsa_pkcs1_sha256 (0x0401), ed25519 (0x0807)
    const body = Buffer.from([
      0x00,
      0x08, // list length
      0x08,
      0x04, // rsa_pss_rsae_sha256
      0x08,
      0x05, // rsa_pss_rsae_sha384
      0x04,
      0x03, // ecdsa_secp256r1_sha256
      0x08,
      0x07, // ed25519
    ]);
    const ext = Buffer.alloc(4 + body.length);
    ext.writeUInt16BE(EXT_SIG_ALGS, 0);
    ext.writeUInt16BE(body.length, 2);
    body.copy(ext, 4);
    return ext;
  })();

  const extKeyShare = (() => {
    // key_share: one x25519 entry
    const entry = Buffer.concat([
      Buffer.from([0x00, GROUP_X25519 & 0xff]), // actually 0x00, 0x1d
      Buffer.from([0x00, 0x20]), // key length 32
      x25519PubKey,
    ]);
    const clientSharesLen = entry.length;
    const body = Buffer.alloc(2 + clientSharesLen);
    body.writeUInt16BE(clientSharesLen, 0);
    entry.copy(body, 2);
    const ext = Buffer.alloc(4 + body.length);
    ext.writeUInt16BE(EXT_KEY_SHARE, 0);
    ext.writeUInt16BE(body.length, 2);
    body.copy(ext, 4);
    return ext;
  })();

  const extensions = Buffer.concat([
    extSupportedVersions,
    extSupportedGroups,
    extSigAlgs,
    extKeyShare,
  ]);

  // Cipher suites: TLS_AES_256_GCM_SHA384, TLS_AES_128_GCM_SHA256, TLS_CHACHA20_POLY1305_SHA256
  const cipherSuites = Buffer.from([
    0x00,
    0x06, // length 6 = 3 suites
    (CIPHER_AES256GCM_SHA384 >> 8) & 0xff,
    CIPHER_AES256GCM_SHA384 & 0xff,
    (CIPHER_AES128GCM_SHA256 >> 8) & 0xff,
    CIPHER_AES128GCM_SHA256 & 0xff,
    (CIPHER_CHACHA20_SHA256 >> 8) & 0xff,
    CIPHER_CHACHA20_SHA256 & 0xff,
  ]);

  const sessionId = randomBytes(32);

  // Build ClientHello body
  const extLenBuf = Buffer.alloc(2);
  extLenBuf.writeUInt16BE(extensions.length, 0);

  const chBody = Buffer.concat([
    Buffer.from([0x03, 0x03]), // legacy_version = TLS 1.2
    clientRandom,
    Buffer.from([sessionId.length]),
    sessionId,
    cipherSuites,
    Buffer.from([0x01, 0x00]), // compression methods: [null]
    extLenBuf,
    extensions,
  ]);

  return makeHandshakeMsg(HS_CLIENT_HELLO, chBody);
}

// ---------------------------------------------------------------------------
// TLS 1.3 record stream parser
// ---------------------------------------------------------------------------

interface TlsRecord {
  contentType: number;
  data: Buffer;
}

class TlsRecordParser {
  private buf: Buffer = Buffer.alloc(0);

  feed(data: Buffer): TlsRecord[] {
    this.buf = Buffer.concat([this.buf, data]);
    const records: TlsRecord[] = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt16BE(3);
      if (this.buf.length < 5 + len) {
        break;
      }
      records.push({
        contentType: this.buf[0],
        data: this.buf.slice(5, 5 + len),
      });
      this.buf = this.buf.slice(5 + len);
    }
    return records;
  }
}

// ---------------------------------------------------------------------------
// ServerHello parser
// ---------------------------------------------------------------------------

interface ServerHelloInfo {
  serverRandom: Buffer;
  cipherSuite: number;
  serverX25519PubKey: Buffer | null;
}

function parseServerHello(data: Buffer): ServerHelloInfo | null {
  if (data.length < 38) {
    return null;
  }
  // handshake type (1) + len (3) = 4 bytes header
  if (data[0] !== HS_SERVER_HELLO) {
    return null;
  }
  // legacy_version (2) + random (32) = at offset 4
  const serverRandom = data.slice(4 + 2, 4 + 2 + 32);
  const sessionIdLen = data[4 + 2 + 32];
  const off = 4 + 2 + 32 + 1 + sessionIdLen;
  if (off + 4 > data.length) {
    return null;
  }
  const cipherSuite = data.readUInt16BE(off);
  // Skip compression (1 byte), then extensions
  const extTotalLen = data.readUInt16BE(off + 3);
  let eo = off + 5;
  let serverX25519PubKey: Buffer | null = null;
  while (eo + 4 <= off + 5 + extTotalLen && eo + 4 <= data.length) {
    const et = data.readUInt16BE(eo);
    const el = data.readUInt16BE(eo + 2);
    if (et === EXT_KEY_SHARE && eo + 8 <= data.length) {
      // group (2) + key_exchange_length (2) + key_exchange (...)
      const group = data.readUInt16BE(eo + 4);
      const kl = data.readUInt16BE(eo + 6);
      if (group === GROUP_X25519 && kl === 32 && eo + 8 + kl <= data.length) {
        serverX25519PubKey = data.slice(eo + 8, eo + 8 + kl);
      }
    }
    eo += 4 + el;
  }
  return { serverRandom, cipherSuite, serverX25519PubKey };
}

// ---------------------------------------------------------------------------
// Framed message decoder (same as before)
// ---------------------------------------------------------------------------

interface FramedMessage {
  protocolId: number;
  payload: Buffer;
}

class FramedMessageDecoder {
  private recvBuf: Buffer = Buffer.alloc(0);
  private partialProtocolId: number | null = null;
  private partialSize: number | null = null;

  onMessage: ((msg: FramedMessage) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  feed(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    this.drain();
  }

  private drain(): void {
    while (true) {
      if (this.partialProtocolId === null) {
        if (this.recvBuf.length < 1) {
          break;
        }
        this.partialProtocolId = this.recvBuf[0];
        this.partialSize = null;
        this.recvBuf = this.recvBuf.slice(1);
      }
      if (this.partialSize === null) {
        let size = 0;
        let bytesRead = 0;
        let found = false;
        while (bytesRead < this.recvBuf.length) {
          const byte = this.recvBuf[bytesRead];
          size = (size << 7) | (byte & 0x7f);
          bytesRead += 1;
          if ((byte & 0x80) === 0) {
            found = true;
            break;
          }
          if (bytesRead > 5) {
            this.onError?.(
              new Error("SecureChannel: varint size exceeds 5 bytes"),
            );
            return;
          }
        }
        if (!found) {
          break;
        }
        this.partialSize = size;
        this.recvBuf = this.recvBuf.slice(bytesRead);
      }
      if (this.recvBuf.length < this.partialSize) {
        break;
      }
      const payload = this.recvBuf.slice(0, this.partialSize);
      this.recvBuf = this.recvBuf.slice(this.partialSize);
      const protocolId = this.partialProtocolId;
      this.partialProtocolId = null;
      this.partialSize = null;
      this.onMessage?.({ protocolId, payload });
    }
  }
}

// ---------------------------------------------------------------------------
// SecureChannelHandler – manual TLS 1.3
// ---------------------------------------------------------------------------

/**
 * SecureChannelHandler drives a manual TLS 1.3 handshake over the Cubyz
 * UDP channel 1 (SECURE).
 *
 * We implement TLS 1.3 ourselves because the Cubyz server generates a
 * self-signed RSA-PSS certificate with an empty serialNumber (ASN.1
 * INTEGER of length 0), which OpenSSL 3 rejects even with
 * `rejectUnauthorized: false` — the error fires during record parsing,
 * not during certificate verification.
 *
 * We only support TLS_AES_256_GCM_SHA384 with X25519 key exchange, which
 * is what mbedTLS 3.x negotiates.  We do not validate the server
 * certificate at all (MITM is mitigated by the application-level
 * signature exchange that follows).
 *
 * verificationData = all bytes received from the server on channel 1
 * BEFORE `secureConnect` fires (i.e. every byte pushed via feedRawBytes
 * before the handshake completes).  This matches the Zig server's
 * definition on the client side.
 */
export class SecureChannelHandler {
  private readonly udpSocket: dgram.Socket;
  private readonly host: string;
  private readonly port: number;
  private readonly channelId: number;
  private readonly mtu: number;
  private sendSeq: number;

  // TLS state
  private state: "init" | "sentClientHello" | "handshakeComplete" | "error" =
    "init";
  private readonly recordParser = new TlsRecordParser();
  private readonly decoder = new FramedMessageDecoder();

  // Transcript hash accumulator (SHA-384 of all Handshake messages)
  private transcript: Buffer[] = [];

  // Key material (populated after ServerHello + key derivation)
  private serverHandshakeKey: Buffer | null = null;
  private serverHandshakeIv: Buffer | null = null;
  private serverHandshakeSeq = 0n;
  private clientHandshakeKey: Buffer | null = null;
  private clientHandshakeIv: Buffer | null = null;
  private clientHandshakeSeq = 0n;

  private serverAppKey: Buffer | null = null;
  private serverAppIv: Buffer | null = null;
  private serverAppSeq = 0n;
  private clientAppKey: Buffer | null = null;
  private clientAppIv: Buffer | null = null;
  private clientAppSeq = 0n;

  // verificationData = raw bytes received from server before handshake completes
  private verificationDataBufs: Buffer[] = [];
  private collectingVerificationData = true;

  // Client X25519 keys
  private readonly clientX25519PrivKey: ReturnType<
    typeof generateKeyPairSync
  >["privateKey"];
  private readonly clientX25519PubKeyBytes: Buffer;

  private readonly clientRandom: Buffer;

  // Callbacks
  onMessage: ((msg: FramedMessage) => void) | null = null;
  onSecureConnect: ((verificationData: Buffer) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor(options: {
    socket: dgram.Socket;
    host: string;
    port: number;
    channelId: number;
    mtu: number;
    initialSendSeq: number;
  }) {
    this.udpSocket = options.socket;
    this.host = options.host;
    this.port = options.port;
    this.channelId = options.channelId;
    this.mtu = options.mtu;
    this.sendSeq = options.initialSendSeq;

    // Generate ephemeral X25519 key pair for this handshake
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    this.clientX25519PrivKey = privateKey;
    // Export raw 32-byte public key from SPKI DER
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    this.clientX25519PubKeyBytes = Buffer.from(spki.slice(spki.length - 32));

    this.clientRandom = randomBytes(32);

    this.decoder.onMessage = (msg: FramedMessage) => {
      this.onMessage?.(msg);
    };
    this.decoder.onError = (err: Error) => {
      this.onError?.(err);
    };
  }

  /**
   * Trigger the TLS handshake.  Must be called after the UDP init-ACK packet
   * has been handed to the OS send queue so the server is guaranteed to be in
   * the .connected state before it receives the TLS ClientHello.
   */
  startHandshake(): void {
    if (this.state !== "init") {
      return;
    }
    this.state = "sentClientHello";
    const helloMsg = buildClientHello(
      this.clientRandom,
      this.clientX25519PubKeyBytes,
    );
    // Add to transcript BEFORE sending
    this.transcript.push(Buffer.from(helloMsg));
    const record = makeTlsRecord(CONTENT_HANDSHAKE, helloMsg);
    this.sendRawTlsRecord(record);
  }

  // Feed raw bytes from UDP into the TLS layer (called by connection.ts).
  feedRawBytes(data: Buffer): void {
    if (this.collectingVerificationData) {
      this.verificationDataBufs.push(Buffer.from(data));
    }
    if (this.state === "error") {
      return;
    }
    const records = this.recordParser.feed(data);
    for (const record of records) {
      this.handleRecord(record);
    }
  }

  private handleRecord(record: TlsRecord): void {
    switch (record.contentType) {
      case CONTENT_CCS:
        // ChangeCipherSpec compatibility message — ignore
        break;
      case CONTENT_HANDSHAKE:
        this.handlePlaintextHandshake(record.data);
        break;
      case CONTENT_APP_DATA:
        this.handleEncryptedRecord(record);
        break;
      default:
        break;
    }
  }

  private handlePlaintextHandshake(data: Buffer): void {
    // Only ServerHello comes as plaintext in TLS 1.3
    if (data.length < 4 || data[0] !== HS_SERVER_HELLO) {
      return;
    }
    this.transcript.push(Buffer.from(data));
    const info = parseServerHello(data);
    if (!info) {
      this.fail(new Error("TLS13: failed to parse ServerHello"));
      return;
    }
    if (info.cipherSuite !== CIPHER_AES256GCM_SHA384) {
      this.fail(
        new Error(
          `TLS13: unexpected cipher suite 0x${info.cipherSuite.toString(16)}`,
        ),
      );
      return;
    }
    if (!info.serverX25519PubKey) {
      this.fail(new Error("TLS13: no x25519 key share in ServerHello"));
      return;
    }
    this.deriveHandshakeKeys(info.serverX25519PubKey);
  }

  private deriveHandshakeKeys(serverPubKeyBytes: Buffer): void {
    // Build server's X25519 public key object from raw bytes.
    // The raw 32-byte public key has SPKI encoding:
    //   30 2a 30 05 06 03 2b 65 6e 03 21 00 <32 bytes>
    const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
    const serverPubKeyDer = Buffer.concat([spkiPrefix, serverPubKeyBytes]);
    const serverPublicKey = createPublicKey({
      key: serverPubKeyDer,
      format: "der",
      type: "spki",
    });

    // ECDH shared secret
    const sharedSecret = diffieHellman({
      privateKey: this.clientX25519PrivKey,
      publicKey: serverPublicKey,
    });

    // TLS 1.3 Key Schedule (RFC 8446 §7.1) using SHA-384
    const hashLen = 48;
    const _emptyHash = createHash("sha384").digest();

    // early_secret = HKDF-Extract(0, 0)  — RFC 8446 §7.1: IKM is HashLen zeroes
    const earlySecret = hkdfExtract(
      Buffer.alloc(hashLen, 0),
      Buffer.alloc(hashLen, 0),
    );

    // empty_hash = Hash("") for deriving binder_key etc.
    const derivedSecret = deriveSecret(earlySecret, "derived", Buffer.alloc(0));

    // handshake_secret = HKDF-Extract(derived_secret, DHE)
    const handshakeSecret = hkdfExtract(derivedSecret, sharedSecret);

    // Transcript hash up to and including ServerHello
    const transcriptSoFar = Buffer.concat(this.transcript);

    // client_handshake_traffic_secret
    const clientHsSecret = deriveSecret(
      handshakeSecret,
      "c hs traffic",
      transcriptSoFar,
    );
    // server_handshake_traffic_secret
    const serverHsSecret = deriveSecret(
      handshakeSecret,
      "s hs traffic",
      transcriptSoFar,
    );

    const clientHsKeys = deriveTrafficKeys(clientHsSecret);
    const serverHsKeys = deriveTrafficKeys(serverHsSecret);

    this.clientHandshakeKey = clientHsKeys.key;
    this.clientHandshakeIv = clientHsKeys.iv;
    this.serverHandshakeKey = serverHsKeys.key;
    this.serverHandshakeIv = serverHsKeys.iv;

    // Save for application key derivation later
    this._handshakeSecret = handshakeSecret;
    this._clientHsSecret = clientHsSecret;
    this._serverHsSecret = serverHsSecret;
  }

  // Stored for application key derivation (set in deriveHandshakeKeys)
  private _handshakeSecret: Buffer | null = null;
  private _clientHsSecret: Buffer | null = null;
  private _serverHsSecret: Buffer | null = null;

  private deriveApplicationKeys(): void {
    if (!this._handshakeSecret) {
      return;
    }
    const _hashLen = 48;
    const handshakeSecret = this._handshakeSecret;

    // master_secret = HKDF-Extract(derived, 0)
    const derivedFromHs = deriveSecret(
      handshakeSecret,
      "derived",
      Buffer.alloc(0),
    );
    const masterSecret = hkdfExtract(derivedFromHs, Buffer.alloc(48, 0));

    // Use full transcript including all handshake messages processed so far
    const transcriptAll = Buffer.concat(this.transcript);

    const clientAppSecret = deriveSecret(
      masterSecret,
      "c ap traffic",
      transcriptAll,
    );
    const serverAppSecret = deriveSecret(
      masterSecret,
      "s ap traffic",
      transcriptAll,
    );

    const clientAppKeys = deriveTrafficKeys(clientAppSecret);
    const serverAppKeys = deriveTrafficKeys(serverAppSecret);

    this.clientAppKey = clientAppKeys.key;
    this.clientAppIv = clientAppKeys.iv;
    this.serverAppKey = serverAppKeys.key;
    this.serverAppIv = serverAppKeys.iv;
  }

  private handleEncryptedRecord(record: TlsRecord): void {
    if (!this.serverHandshakeKey) {
      // Got encrypted record before key derivation — discard
      return;
    }

    // Try handshake decryption first, then application
    const fullRecord = Buffer.concat([
      (() => {
        const hdr = Buffer.alloc(5);
        hdr[0] = record.contentType;
        hdr.writeUInt16BE(TLS_VERSION_12, 1);
        hdr.writeUInt16BE(record.data.length, 3);
        return hdr;
      })(),
      record.data,
    ]);

    // Try server handshake keys
    if (
      this.state === "sentClientHello" &&
      this.serverHandshakeKey &&
      this.serverHandshakeIv
    ) {
      const dec = decryptRecord(
        fullRecord,
        this.serverHandshakeKey,
        this.serverHandshakeIv,
        this.serverHandshakeSeq,
      );
      if (dec) {
        this.serverHandshakeSeq++;
        this.handleDecryptedHandshakeMsg(dec.plaintext, dec.innerContentType);
        return;
      }
    }

    // Try server application keys (after handshake is done)
    if (
      this.state === "handshakeComplete" &&
      this.serverAppKey &&
      this.serverAppIv
    ) {
      const dec = decryptRecord(
        fullRecord,
        this.serverAppKey,
        this.serverAppIv,
        this.serverAppSeq,
      );
      if (dec && dec.innerContentType === CONTENT_APP_DATA) {
        this.serverAppSeq++;
        this.decoder.feed(dec.plaintext);
        return;
      }
      if (dec) {
        this.serverAppSeq++;
      }
    }
  }

  private handleDecryptedHandshakeMsg(data: Buffer, innerType: number): void {
    if (innerType !== CONTENT_HANDSHAKE) {
      return;
    }
    // May contain multiple handshake messages
    let off = 0;
    while (off + 4 <= data.length) {
      const hsType = data[off];
      const hsLen =
        (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
      if (off + 4 + hsLen > data.length) {
        break;
      }
      const hsMsg = data.slice(off, off + 4 + hsLen);
      this.transcript.push(Buffer.from(hsMsg));

      if (hsType === HS_FINISHED) {
        // Server Finished — verify it, derive app keys, send client Finished
        this.processServerFinished(data.slice(off + 4, off + 4 + hsLen));
      }
      // Other messages (EncryptedExtensions, Certificate, CertificateVerify)
      // are intentionally ignored — we don't validate the server certificate.

      off += 4 + hsLen;
    }
  }

  private processServerFinished(verifyData: Buffer): void {
    if (!this._serverHsSecret) {
      this.fail(new Error("TLS13: no server handshake secret for Finished"));
      return;
    }

    // Verify server Finished HMAC
    const transcriptBeforeFinished = Buffer.concat(
      this.transcript.slice(0, this.transcript.length - 1),
    );
    const expectedVerifyData = this.computeFinishedVerifyData(
      this._serverHsSecret,
      transcriptBeforeFinished,
    );
    if (!expectedVerifyData.equals(verifyData)) {
      this.fail(new Error("TLS13: server Finished verify_data mismatch"));
      return;
    }

    // Derive application keys (transcript now includes server Finished)
    this.deriveApplicationKeys();

    // Send client Finished
    this.sendClientFinished();

    // Handshake complete
    this.state = "handshakeComplete";
    this.collectingVerificationData = false;
    const verificationData = Buffer.concat(this.verificationDataBufs);
    this.onSecureConnect?.(verificationData);
  }

  private computeFinishedVerifyData(
    hsTrafficSecret: Buffer,
    transcriptHash: Buffer,
  ): Buffer {
    const finishedKey = expandLabel(
      hsTrafficSecret,
      "finished",
      Buffer.alloc(0),
      48,
      "sha384",
    );
    const h = createHash("sha384").update(transcriptHash).digest();
    return createHmac("sha384", finishedKey).update(h).digest();
  }

  private sendClientFinished(): void {
    if (
      !this._clientHsSecret ||
      !this.clientHandshakeKey ||
      !this.clientHandshakeIv
    ) {
      return;
    }
    const transcriptBeforeClientFinished = Buffer.concat(this.transcript);
    const verifyData = this.computeFinishedVerifyData(
      this._clientHsSecret,
      transcriptBeforeClientFinished,
    );
    const finishedMsg = makeHandshakeMsg(HS_FINISHED, verifyData);
    this.transcript.push(Buffer.from(finishedMsg));
    // Send encrypted with client handshake key
    const encrypted = encryptRecord(
      finishedMsg,
      CONTENT_HANDSHAKE,
      this.clientHandshakeKey,
      this.clientHandshakeIv,
      this.clientHandshakeSeq,
    );
    this.clientHandshakeSeq++;
    this.sendRawTlsRecord(encrypted);
  }

  // Send a framed message over the TLS-encrypted application channel.
  // Frame format: [protocolId u8][MSB-varint length][payload]
  sendMessage(protocolId: number, payload: Buffer): void {
    if (!this.clientAppKey || !this.clientAppIv) {
      this.onError?.(
        new Error("SecureChannel: sendMessage before handshake complete"),
      );
      return;
    }
    const sizeVarInt = encodeMsbVarInt(payload.length);
    const frame = Buffer.concat([
      Buffer.from([protocolId]),
      sizeVarInt,
      payload,
    ]);
    const encrypted = encryptRecord(
      frame,
      CONTENT_APP_DATA,
      this.clientAppKey,
      this.clientAppIv,
      this.clientAppSeq,
    );
    this.clientAppSeq++;
    this.sendRawTlsRecord(encrypted);
  }

  // Send a pre-built TLS record (or encrypted wrapper) over UDP.
  private sendRawTlsRecord(record: Buffer): void {
    const maxPayload = this.mtu - 5;
    let offset = 0;
    while (offset < record.length) {
      const end = Math.min(offset + maxPayload, record.length);
      const slice = record.slice(offset, end);
      const packet = Buffer.alloc(5 + slice.length);
      packet[0] = this.channelId;
      writeInt32BE(packet, 1, this.sendSeq);
      slice.copy(packet, 5);
      this.udpSocket.send(packet, this.port, this.host);
      this.sendSeq = (this.sendSeq + slice.length) | 0;
      offset = end;
    }
  }

  private fail(err: Error): void {
    this.state = "error";
    this.onError?.(err);
  }
}
