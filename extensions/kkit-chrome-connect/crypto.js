/**
 * KithKit Chrome Connect — WebCrypto Crypto Module
 *
 * WebCrypto mirror of the daemon's Node.js cowork-crypto.ts module.
 * Uses crypto.subtle exclusively — zero external dependencies.
 *
 * Produces byte-identical outputs to the daemon for all shared operations:
 *   - X25519 ECDH key exchange
 *   - PSK-authenticated HKDF key derivation (salt = HMAC-SHA256(PSK, "kkit-cowork-e2e-v1"))
 *   - AES-256-GCM authenticated encryption (AAD = "cowork:<seq>")
 *   - SHA-256 fingerprinting (first 16 hex chars)
 */

'use strict';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Encode a string to Uint8Array (UTF-8). */
function encodeUtf8(str) {
  return new TextEncoder().encode(str);
}

/** Decode a Uint8Array to string (UTF-8). */
function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Base64-encode an ArrayBuffer or Uint8Array. */
function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Base64-decode a string to Uint8Array. */
function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Hex-decode a string to Uint8Array. */
function fromHex(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encode a Uint8Array to lowercase hex string. */
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Key Generation
// ---------------------------------------------------------------------------

/**
 * Generate an ephemeral X25519 keypair for ECDH key exchange.
 * Returns { publicKey: CryptoKey, privateKey: CryptoKey }
 * where publicKey is extractable (needed for exportPublicKey).
 *
 * @returns {Promise<{ publicKey: CryptoKey, privateKey: CryptoKey }>}
 */
async function generateKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'X25519' },
    true, // extractable — we need to export the public key
    ['deriveBits'],
  );
}

// ---------------------------------------------------------------------------
// Public Key Export
// ---------------------------------------------------------------------------

/**
 * Export an X25519 public key as a base64-encoded raw 32-byte string.
 * This matches the daemon's publicKeyB64 format exactly.
 *
 * @param {{ publicKey: CryptoKey }} keyPair
 * @returns {Promise<string>} base64-encoded 32-byte raw public key
 */
async function exportPublicKey(keyPair) {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return toBase64(raw);
}

// ---------------------------------------------------------------------------
// ECDH Shared Secret
// ---------------------------------------------------------------------------

/**
 * Perform X25519 ECDH to derive shared bits (256 bits = 32 bytes).
 * theirPublicKeyB64 is the base64-encoded raw 32-byte X25519 public key
 * (same format as daemon's publicKeyB64).
 *
 * @param {CryptoKey} privateKey  Our X25519 private CryptoKey
 * @param {string} theirPublicKeyB64  Their base64-encoded raw public key
 * @returns {Promise<ArrayBuffer>} 32-byte shared secret
 */
async function deriveBits(privateKey, theirPublicKeyB64) {
  const theirRaw = fromBase64(theirPublicKeyB64);
  const theirPublicKey = await crypto.subtle.importKey(
    'raw',
    theirRaw,
    { name: 'X25519' },
    false,
    [], // public key — no usages needed
  );

  return crypto.subtle.deriveBits(
    { name: 'X25519', public: theirPublicKey },
    privateKey,
    256, // 32 bytes
  );
}

// ---------------------------------------------------------------------------
// Session Key Derivation
// ---------------------------------------------------------------------------

/**
 * Derive AES-256-GCM session key from ECDH shared bits + PSK.
 *
 * Matches daemon's deriveSessionKey exactly:
 *   salt = HMAC-SHA256(key: PSK bytes from hex, data: "kkit-cowork-e2e-v1")
 *   info = sorted([extensionPubKeyB64, daemonPubKeyB64]).join(":")
 *   output = HKDF-SHA256(IKM: sharedBits, salt, info, 32 bytes)
 *
 * @param {ArrayBuffer} sharedBits  32-byte shared secret from ECDH deriveBits
 * @param {string} pskHex  PSK as hex string (64 hex chars = 256-bit key)
 * @param {string} extensionPubKeyB64  Extension's base64 raw public key
 * @param {string} daemonPubKeyB64  Daemon's base64 raw public key
 * @returns {Promise<CryptoKey>} AES-256-GCM CryptoKey with encrypt+decrypt usages
 */
async function deriveSessionKey(sharedBits, pskHex, extensionPubKeyB64, daemonPubKeyB64) {
  // Step 1: Compute PSK-authenticated salt via HMAC-SHA256
  const pskBytes = fromHex(pskHex);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    pskBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const saltBuffer = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    encodeUtf8('kkit-cowork-e2e-v1'),
  );

  // Step 2: Sort public keys alphabetically for deterministic info (order-independent)
  // This matches daemon: const sortedKeys = [extensionPubKeyB64, daemonPubKeyB64].sort();
  const sortedKeys = [extensionPubKeyB64, daemonPubKeyB64].sort();
  const info = encodeUtf8(`${sortedKeys[0]}:${sortedKeys[1]}`);

  // Step 3: Import shared bits as HKDF key material
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  // Step 4: Derive AES-256-GCM key via HKDF
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBuffer,
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable (security)
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * AAD is "cowork:<seq>" bound to the sequence number.
 *
 * WebCrypto AES-GCM returns ciphertext || 16-byte auth tag concatenated,
 * so payload = base64(encrypt_output) already includes the tag.
 *
 * @param {CryptoKey} sessionKey  AES-256-GCM CryptoKey
 * @param {string} plaintext  UTF-8 plaintext
 * @param {number} seq  Sequence number
 * @returns {Promise<{ type: 'encrypted', seq: number, payload: string, nonce: string }>}
 */
async function encrypt(sessionKey, plaintext, seq) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeUtf8(`cowork:${seq}`);
  const plaintextBytes = encodeUtf8(plaintext);

  // WebCrypto AES-GCM: returns ciphertext + 16-byte auth tag appended
  const ciphertextWithTag = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128, // 16 bytes — matches daemon's default
    },
    sessionKey,
    plaintextBytes,
  );

  return {
    type: 'encrypted',
    seq,
    payload: toBase64(ciphertextWithTag),
    nonce: toBase64(nonce),
  };
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 * Throws if authentication tag verification fails.
 *
 * WebCrypto AES-GCM decrypt expects ciphertext+tag concatenated (same as
 * what we receive from the daemon or produced by encrypt() above).
 *
 * @param {CryptoKey} sessionKey  AES-256-GCM CryptoKey
 * @param {{ payload: string, nonce: string, seq: number }} envelope
 * @returns {Promise<string>} Decrypted UTF-8 plaintext
 */
async function decrypt(sessionKey, envelope) {
  const { payload, nonce: nonceB64, seq } = envelope;
  const nonce = fromBase64(nonceB64);
  const ciphertextWithTag = fromBase64(payload);
  const aad = encodeUtf8(`cowork:${seq}`);

  const plaintextBytes = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: aad,
      tagLength: 128,
    },
    sessionKey,
    ciphertextWithTag,
  );

  return decodeUtf8(plaintextBytes);
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute TOFU fingerprint of a public key.
 * Returns the first 16 hex characters of SHA-256(raw public key bytes).
 * Matches daemon's computeFingerprint exactly.
 *
 * @param {string} publicKeyB64  Base64-encoded raw 32-byte public key
 * @returns {Promise<string>} 16-character lowercase hex fingerprint
 */
async function computeFingerprint(publicKeyB64) {
  const raw = fromBase64(publicKeyB64);
  const hashBuffer = await crypto.subtle.digest('SHA-256', raw);
  const hex = toHex(new Uint8Array(hashBuffer));
  return hex.substring(0, 16);
}

// ---------------------------------------------------------------------------
// Exports (module pattern for service worker / ES module contexts)
// ---------------------------------------------------------------------------

// Export as named properties for use in background.js via import or globalThis
const KKitCrypto = {
  generateKeyPair,
  exportPublicKey,
  deriveBits,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeFingerprint,
};

// Support both ES module import (if manifest uses type=module) and
// globalThis assignment (for classic service workers).
if (typeof globalThis !== 'undefined') {
  globalThis.KKitCrypto = KKitCrypto;
}

// ES module export — Chrome MV3 service workers support top-level export
// when loaded as a module. For classic workers, use globalThis.KKitCrypto.
export {
  generateKeyPair,
  exportPublicKey,
  deriveBits,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeFingerprint,
};
