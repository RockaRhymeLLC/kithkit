/**
 * Cowork Crypto — all cryptographic operations for the cowork bridge.
 *
 * Implements X25519 ECDH key exchange, PSK-authenticated HKDF key derivation,
 * and AES-256-GCM authenticated encryption.
 *
 * Zero external dependencies — uses Node.js built-in `node:crypto` only.
 */

import {
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createHmac,
  createHash,
  type KeyObject,
} from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────

export interface EphemeralKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicKeyRaw: Buffer;  // 32-byte raw X25519 public key
  publicKeyB64: string;  // base64-encoded raw public key
}

export interface EncryptedEnvelope {
  type: 'encrypted';
  seq: number;
  payload: string;  // base64 of ciphertext + auth tag
  nonce: string;    // base64 of 12-byte nonce
}

// ── X25519 SPKI DER prefix ────────────────────────────────────

/**
 * SubjectPublicKeyInfo DER header for X25519 (OID 1.3.101.110).
 * Encoding: SEQUENCE { SEQUENCE { OID 1.3.101.110 }, BIT STRING { <32 bytes> } }
 * The 12-byte prefix is: 30 2a 30 05 06 03 2b 65 6e 03 21 00
 */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

// ── Key Generation ────────────────────────────────────────────

/**
 * Generate an ephemeral X25519 keypair for ECDH key exchange.
 * The raw 32-byte public key is extracted from the SPKI DER export.
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');

  // Export as DER-encoded SPKI; the last 32 bytes are the raw X25519 key.
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const publicKeyRaw = Buffer.from(spkiDer.subarray(spkiDer.length - 32));
  const publicKeyB64 = publicKeyRaw.toString('base64');

  return { publicKey, privateKey, publicKeyRaw, publicKeyB64 };
}

// ── ECDH + Key Derivation ─────────────────────────────────────

/**
 * Compute ECDH shared secret between our private key and their public key.
 * theirPublicKeyB64 is the base64-encoded raw 32-byte X25519 public key.
 */
export function computeSharedSecret(
  ourPrivateKey: KeyObject,
  theirPublicKeyB64: string,
): Buffer {
  // Wrap the raw 32-byte key in a SPKI DER envelope for node:crypto.
  const theirRaw = Buffer.from(theirPublicKeyB64, 'base64');
  const theirDer = Buffer.concat([X25519_SPKI_PREFIX, theirRaw]);
  const theirPublicKey = createPublicKey({ key: theirDer, format: 'der', type: 'spki' });

  return diffieHellman({ privateKey: ourPrivateKey, publicKey: theirPublicKey }) as Buffer;
}

/**
 * Derive AES-256 session key from ECDH shared secret + PSK.
 *
 * The PSK is mixed into the HKDF salt via HMAC-SHA256:
 *   salt = HMAC-SHA256(key: PSK, data: "kkit-cowork-e2e-v1")
 *
 * The info field contains sorted public keys:
 *   info = "<key1_b64>:<key2_b64>" where key1 < key2 alphabetically
 *
 * This ensures:
 * 1. Both sides derive the same key regardless of who is "extension" vs "daemon"
 * 2. Without the correct PSK, a MITM derives a different session key
 */
export function deriveSessionKey(
  sharedSecret: Buffer,
  pskHex: string,
  extensionPubKeyB64: string,
  daemonPubKeyB64: string,
): Buffer {
  // PSK-authenticated salt
  const pskBuffer = Buffer.from(pskHex, 'hex');
  const salt = createHmac('sha256', pskBuffer).update('kkit-cowork-e2e-v1').digest();

  // Sort keys alphabetically for deterministic info (order-independent)
  const sortedKeys = [extensionPubKeyB64, daemonPubKeyB64].sort();
  const info = `${sortedKeys[0]}:${sortedKeys[1]}`;

  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 32));
}

// ── Encryption / Decryption ───────────────────────────────────

/**
 * Encrypt a plaintext message using AES-256-GCM.
 * AAD is "cowork:<seq>" to bind the ciphertext to the sequence number.
 * The returned payload is base64(ciphertext || 16-byte auth tag).
 */
export function encrypt(
  sessionKey: Buffer,
  plaintext: string,
  seq: number,
): { payload: string; nonce: string } {
  const nonce = randomBytes(12);
  const aad = Buffer.from(`cowork:${seq}`);

  const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
  cipher.setAAD(aad);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(), // 16 bytes
  ]);

  return {
    payload: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

/**
 * Decrypt an AES-256-GCM ciphertext.
 * Throws if auth tag verification fails (wrong key, tampered data, or wrong seq/AAD).
 */
export function decrypt(
  sessionKey: Buffer,
  payloadB64: string,
  nonceB64: string,
  seq: number,
): string {
  const nonce = Buffer.from(nonceB64, 'base64');
  const combined = Buffer.from(payloadB64, 'base64');
  const aad = Buffer.from(`cowork:${seq}`);

  // Last 16 bytes are the GCM auth tag
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(0, combined.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', sessionKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

// ── Envelope Helpers ──────────────────────────────────────────

/** Build an EncryptedEnvelope from a plaintext message and sequence number. */
export function encryptEnvelope(
  sessionKey: Buffer,
  message: unknown,
  seq: number,
): EncryptedEnvelope {
  const plaintext = JSON.stringify(message);
  const { payload, nonce } = encrypt(sessionKey, plaintext, seq);
  return { type: 'encrypted', seq, payload, nonce };
}

/** Decrypt an EncryptedEnvelope, returning the parsed JSON message. */
export function decryptEnvelope(
  sessionKey: Buffer,
  envelope: EncryptedEnvelope,
): unknown {
  const plaintext = decrypt(sessionKey, envelope.payload, envelope.nonce, envelope.seq);
  return JSON.parse(plaintext);
}

// ── Fingerprint ───────────────────────────────────────────────

/**
 * Compute TOFU fingerprint of a public key.
 * Returns the first 16 hex characters of SHA-256(raw public key).
 */
export function computeFingerprint(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64');
  const hash = createHash('sha256').update(raw).digest('hex');
  return hash.substring(0, 16);
}

// ── Token/PSK Generation ──────────────────────────────────────

/** Generate a random 256-bit token as a hex string (64 characters). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}
