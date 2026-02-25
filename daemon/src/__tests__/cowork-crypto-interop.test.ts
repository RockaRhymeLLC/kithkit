/**
 * t-004: Cowork crypto interop — WebCrypto (extension) ↔ Node.js (daemon)
 *
 * Verifies that the extension's crypto.js (WebCrypto API) produces byte-identical
 * outputs to the daemon's cowork-crypto.ts (Node.js crypto module).
 *
 * Since Node 22+ exposes the same WebCrypto API via `webcrypto.subtle`, we can
 * replicate extension crypto operations inline and cross-validate against daemon.
 *
 * Approach (Option A): Implement WebCrypto operations inline in the test,
 * matching what extension crypto.js does, then compare against daemon calls.
 * This avoids module import complications with the plain JS extension file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import type { webcrypto as WebCryptoTypes } from 'node:crypto';
import {
  generateEphemeralKeyPair,
  computeSharedSecret,
  deriveSessionKey as daemonDeriveSessionKey,
  encrypt as daemonEncrypt,
  decrypt as daemonDecrypt,
  computeFingerprint as daemonFingerprint,
} from '../extensions/cowork-crypto.js';

// ── WebCrypto subtle shorthand ─────────────────────────────────────────────

const subtle = webcrypto.subtle;

// ── Type helpers ──────────────────────────────────────────────────────────

/** Convert anything buffer-like to a plain ArrayBuffer (no SharedArrayBuffer). */
function toArrayBuffer(src: ArrayBuffer | Buffer | Uint8Array): ArrayBuffer {
  if (src instanceof ArrayBuffer) return src;
  // Buffer/Uint8Array: copy into a fresh ArrayBuffer
  const arr = src instanceof Buffer ? new Uint8Array(src) : src;
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
}

// ── Extension-side WebCrypto implementations (mirrors crypto.js) ──────────

/** Encode a string to a plain ArrayBuffer (UTF-8). */
function encodeUtf8(str: string): ArrayBuffer {
  return toArrayBuffer(Buffer.from(str, 'utf-8'));
}

/** Decode an ArrayBuffer to string (UTF-8). */
function decodeUtf8(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('utf-8');
}

/** Base64-encode an ArrayBuffer. */
function toBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64');
}

/** Base64-decode a string to a plain ArrayBuffer. */
function fromBase64(b64: string): ArrayBuffer {
  return toArrayBuffer(Buffer.from(b64, 'base64'));
}

/** Hex-decode a string to a plain ArrayBuffer. */
function fromHex(hex: string): ArrayBuffer {
  return toArrayBuffer(Buffer.from(hex, 'hex'));
}

/** Encode an ArrayBuffer to lowercase hex string. */
function toHex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('hex');
}

/** Extension: generateKeyPair — X25519 via WebCrypto */
async function extGenerateKeyPair(): Promise<WebCryptoTypes.CryptoKeyPair> {
  // generateKey with 'deriveBits' usage returns CryptoKeyPair for asymmetric keys
  return subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits'],
  ) as unknown as Promise<WebCryptoTypes.CryptoKeyPair>;
}

/** Extension: exportPublicKey — export as base64 raw bytes */
async function extExportPublicKey(keyPair: WebCryptoTypes.CryptoKeyPair): Promise<string> {
  const raw = await subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer;
  return toBase64(raw);
}

/** Extension: deriveBits — X25519 ECDH shared secret (256 bits) */
async function extDeriveBits(
  privateKey: WebCryptoTypes.CryptoKey,
  theirPublicKeyB64: string,
): Promise<ArrayBuffer> {
  const theirRaw = fromBase64(theirPublicKeyB64);
  const theirPublicKey = await subtle.importKey(
    'raw',
    theirRaw,
    { name: 'X25519' },
    false,
    [],
  );
  return subtle.deriveBits(
    { name: 'X25519', public: theirPublicKey },
    privateKey,
    256,
  ) as unknown as Promise<ArrayBuffer>;
}

/** Extension: deriveSessionKey — HMAC-salt HKDF → AES-256-GCM key */
async function extDeriveSessionKey(
  sharedBits: ArrayBuffer,
  pskHex: string,
  extensionPubKeyB64: string,
  daemonPubKeyB64: string,
): Promise<WebCryptoTypes.CryptoKey> {
  // PSK-authenticated salt: HMAC-SHA256(PSK, "kkit-cowork-e2e-v1")
  const pskBytes = fromHex(pskHex);
  const hmacKey = await subtle.importKey(
    'raw',
    pskBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const saltBuffer = await subtle.sign('HMAC', hmacKey, encodeUtf8('kkit-cowork-e2e-v1')) as ArrayBuffer;

  // Sort keys alphabetically (same as daemon)
  const sortedKeys = [extensionPubKeyB64, daemonPubKeyB64].sort();
  const info = encodeUtf8(`${sortedKeys[0]}:${sortedKeys[1]}`);

  // Import shared bits as HKDF material
  const hkdfKey = await subtle.importKey(
    'raw',
    sharedBits,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );

  // Derive AES-256-GCM key — extractable so we can compare raw bytes
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBuffer,
      info,
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/** Extension: encrypt — AES-256-GCM with AAD "cowork:<seq>" */
async function extEncrypt(
  sessionKey: WebCryptoTypes.CryptoKey,
  plaintext: string,
  seq: number,
): Promise<{ type: 'encrypted'; seq: number; payload: string; nonce: string }> {
  const nonceBytes = webcrypto.getRandomValues(new Uint8Array(12));
  const nonce = toArrayBuffer(nonceBytes);
  const aad = encodeUtf8(`cowork:${seq}`);
  const ciphertextWithTag = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    sessionKey,
    encodeUtf8(plaintext),
  ) as ArrayBuffer;
  return {
    type: 'encrypted',
    seq,
    payload: toBase64(ciphertextWithTag),
    nonce: toBase64(nonce),
  };
}

/** Extension: decrypt — AES-256-GCM with AAD "cowork:<seq>" */
async function extDecrypt(
  sessionKey: WebCryptoTypes.CryptoKey,
  envelope: { payload: string; nonce: string; seq: number },
): Promise<string> {
  const { payload, nonce: nonceB64, seq } = envelope;
  const nonce = fromBase64(nonceB64);
  const ciphertextWithTag = fromBase64(payload);
  const aad = encodeUtf8(`cowork:${seq}`);
  const plaintextBytes = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    sessionKey,
    ciphertextWithTag,
  ) as ArrayBuffer;
  return decodeUtf8(plaintextBytes);
}

/** Extension: computeFingerprint — first 16 hex chars of SHA-256(raw key) */
async function extComputeFingerprint(publicKeyB64: string): Promise<string> {
  const raw = fromBase64(publicKeyB64);
  const hashBuffer = await subtle.digest('SHA-256', raw) as ArrayBuffer;
  return toHex(hashBuffer).substring(0, 16);
}

// ── Test PSK ──────────────────────────────────────────────────────────────

const TEST_PSK = 'd'.repeat(64); // 256-bit PSK as hex

// ── Tests ─────────────────────────────────────────────────────────────────

describe('cowork-crypto interop: session key derivation (t-004a)', () => {
  it('daemon and extension derive identical session key from same inputs', async () => {
    // Generate daemon keypair (Node.js)
    const daemonKp = generateEphemeralKeyPair();
    // Generate extension keypair (WebCrypto)
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    // --- Daemon side: compute shared secret and derive key ---
    const daemonSharedSecret = computeSharedSecret(daemonKp.privateKey, extPubKeyB64);
    const daemonKey = daemonDeriveSessionKey(
      daemonSharedSecret,
      TEST_PSK,
      extPubKeyB64,
      daemonKp.publicKeyB64,
    );

    // --- Extension side: compute shared secret and derive key ---
    const extSharedBits = await extDeriveBits(extKp.privateKey, daemonKp.publicKeyB64);
    const extSessionKey = await extDeriveSessionKey(
      extSharedBits,
      TEST_PSK,
      extPubKeyB64,
      daemonKp.publicKeyB64,
    );

    // Extract raw bytes from the WebCrypto key to compare with daemon's Buffer
    const extKeyRaw = await subtle.exportKey('raw', extSessionKey) as ArrayBuffer;
    const extKeyBytes = Buffer.from(extKeyRaw);

    assert.ok(
      daemonKey.equals(extKeyBytes),
      `Session keys must match.\nDaemon: ${daemonKey.toString('hex')}\nExt:    ${extKeyBytes.toString('hex')}`,
    );
  });

  it('key derivation is order-independent on extension side', async () => {
    const daemonKp = generateEphemeralKeyPair();
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    const extSharedBits = await extDeriveBits(extKp.privateKey, daemonKp.publicKeyB64);

    // Order 1: (extension, daemon)
    const key1 = await extDeriveSessionKey(extSharedBits, TEST_PSK, extPubKeyB64, daemonKp.publicKeyB64);
    // Order 2: (daemon, extension) — reversed
    const key2 = await extDeriveSessionKey(extSharedBits, TEST_PSK, daemonKp.publicKeyB64, extPubKeyB64);

    const raw1 = Buffer.from(await subtle.exportKey('raw', key1) as ArrayBuffer);
    const raw2 = Buffer.from(await subtle.exportKey('raw', key2) as ArrayBuffer);

    assert.ok(raw1.equals(raw2), 'Extension key derivation must be order-independent');
  });

  it('different PSK produces different session key on extension side', async () => {
    const daemonKp = generateEphemeralKeyPair();
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    const extSharedBits = await extDeriveBits(extKp.privateKey, daemonKp.publicKeyB64);

    const key1 = await extDeriveSessionKey(extSharedBits, TEST_PSK, extPubKeyB64, daemonKp.publicKeyB64);
    const key2 = await extDeriveSessionKey(extSharedBits, 'e'.repeat(64), extPubKeyB64, daemonKp.publicKeyB64);

    const raw1 = Buffer.from(await subtle.exportKey('raw', key1) as ArrayBuffer);
    const raw2 = Buffer.from(await subtle.exportKey('raw', key2) as ArrayBuffer);

    assert.ok(!raw1.equals(raw2), 'Different PSK must produce different session key');
  });
});

describe('cowork-crypto interop: cross-encrypt/decrypt (t-004b)', () => {
  /**
   * Set up shared session between daemon (Node.js) and extension (WebCrypto).
   */
  async function setupSharedSession(): Promise<{
    daemonKey: Buffer;
    extKey: WebCryptoTypes.CryptoKey;
  }> {
    const daemonKp = generateEphemeralKeyPair();
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);
    const daemonPubKeyB64 = daemonKp.publicKeyB64;

    // Daemon side
    const daemonShared = computeSharedSecret(daemonKp.privateKey, extPubKeyB64);
    const daemonKey = daemonDeriveSessionKey(daemonShared, TEST_PSK, extPubKeyB64, daemonPubKeyB64);

    // Extension side
    const extShared = await extDeriveBits(extKp.privateKey, daemonPubKeyB64);
    const extKey = await extDeriveSessionKey(extShared, TEST_PSK, extPubKeyB64, daemonPubKeyB64);

    return { daemonKey, extKey };
  }

  it('daemon-encrypted message decrypted by extension', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const plaintext = JSON.stringify({ type: 'cdp', method: 'Page.navigate', params: { url: 'https://example.com' } });
    const seq = 1;

    // Daemon encrypts
    const { payload, nonce } = daemonEncrypt(daemonKey, plaintext, seq);
    const envelope = { type: 'encrypted' as const, seq, payload, nonce };

    // Extension decrypts
    const decrypted = await extDecrypt(extKey, envelope);
    assert.equal(decrypted, plaintext, 'Extension must decrypt daemon-encrypted message correctly');
  });

  it('extension-encrypted message decrypted by daemon', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const plaintext = JSON.stringify({ type: 'hello', userAgent: 'Chrome/145.0' });
    const seq = 2;

    // Extension encrypts
    const envelope = await extEncrypt(extKey, plaintext, seq);

    // Daemon decrypts
    const decrypted = daemonDecrypt(daemonKey, envelope.payload, envelope.nonce, seq);
    assert.equal(decrypted, plaintext, 'Daemon must decrypt extension-encrypted message correctly');
  });

  it('daemon encrypt then extension decrypt roundtrip with multiple messages', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const messages = [
      { type: 'hello', userAgent: 'TestAgent' },
      { type: 'cdp', method: 'Runtime.evaluate', params: { expression: '6*7' } },
      { type: 'tab-changed', tabId: 42, title: 'Test', url: 'https://test.com' },
    ];

    for (let i = 0; i < messages.length; i++) {
      const seq = i + 1;
      const plaintext = JSON.stringify(messages[i]);

      const { payload, nonce } = daemonEncrypt(daemonKey, plaintext, seq);
      const decrypted = await extDecrypt(extKey, { payload, nonce, seq });
      assert.equal(decrypted, plaintext, `Message ${seq} must decrypt correctly`);
    }
  });

  it('extension encrypt then daemon decrypt roundtrip with multiple messages', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const messages = [
      { type: 'cdp-result', id: 1, result: { value: 42 } },
      { type: 'tab-list', id: 2, tabs: [{ tabId: 1, title: 'Home', url: 'https://home.com' }] },
      { type: 'pong' },
    ];

    for (let i = 0; i < messages.length; i++) {
      const seq = i + 10;
      const plaintext = JSON.stringify(messages[i]);

      const envelope = await extEncrypt(extKey, plaintext, seq);
      const decrypted = daemonDecrypt(daemonKey, envelope.payload, envelope.nonce, seq);
      assert.equal(decrypted, plaintext, `Message seq=${seq} must decrypt correctly`);
    }
  });

  it('wrong seq causes decryption failure (AAD mismatch) — daemon decrypt', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const plaintext = 'test message';
    const envelope = await extEncrypt(extKey, plaintext, 1);

    // Daemon tries to decrypt with wrong seq
    assert.throws(
      () => daemonDecrypt(daemonKey, envelope.payload, envelope.nonce, 99),
      /Unsupported state|authentication|tag/i,
      'Wrong seq must cause daemon decryption to fail',
    );
  });

  it('wrong seq causes decryption failure (AAD mismatch) — extension decrypt', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const plaintext = 'test message';
    const { payload, nonce } = daemonEncrypt(daemonKey, plaintext, 1);

    // Extension tries to decrypt with wrong seq
    await assert.rejects(
      () => extDecrypt(extKey, { payload, nonce, seq: 99 }),
      'Wrong seq must cause extension decryption to fail',
    );
  });

  it('tampered ciphertext detected by extension', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const { payload, nonce } = daemonEncrypt(daemonKey, 'hello world', 1);

    // Flip a byte in the middle of the payload
    const buf = Buffer.from(payload, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const tampered = buf.toString('base64');

    await assert.rejects(
      () => extDecrypt(extKey, { payload: tampered, nonce, seq: 1 }),
      'Tampered ciphertext must be detected by extension',
    );
  });

  it('tampered ciphertext detected by daemon', async () => {
    const { daemonKey, extKey } = await setupSharedSession();

    const envelope = await extEncrypt(extKey, 'hello world', 1);

    // Flip a byte
    const buf = Buffer.from(envelope.payload, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const tampered = buf.toString('base64');

    assert.throws(
      () => daemonDecrypt(daemonKey, tampered, envelope.nonce, 1),
      /Unsupported state|authentication|tag/i,
      'Tampered ciphertext must be detected by daemon',
    );
  });
});

describe('cowork-crypto interop: fingerprint (t-004c)', () => {
  it('daemon and extension produce identical fingerprint for same key', async () => {
    const kp = generateEphemeralKeyPair();
    const pubKeyB64 = kp.publicKeyB64;

    const daemonFp = daemonFingerprint(pubKeyB64);
    const extFp = await extComputeFingerprint(pubKeyB64);

    assert.equal(extFp, daemonFp, `Fingerprints must match.\nDaemon: ${daemonFp}\nExt:    ${extFp}`);
  });

  it('fingerprint is 16 hex chars', async () => {
    const kp = generateEphemeralKeyPair();
    const fp = await extComputeFingerprint(kp.publicKeyB64);

    assert.equal(fp.length, 16, 'Fingerprint must be 16 characters');
    assert.match(fp, /^[0-9a-f]{16}$/, 'Fingerprint must be lowercase hex');
  });

  it('fingerprint is deterministic for extension', async () => {
    const kp = generateEphemeralKeyPair();
    const fp1 = await extComputeFingerprint(kp.publicKeyB64);
    const fp2 = await extComputeFingerprint(kp.publicKeyB64);
    assert.equal(fp1, fp2, 'Fingerprint must be deterministic');
  });

  it('different keys produce different fingerprints', async () => {
    const kp1 = generateEphemeralKeyPair();
    const kp2 = generateEphemeralKeyPair();

    const fp1 = await extComputeFingerprint(kp1.publicKeyB64);
    const fp2 = await extComputeFingerprint(kp2.publicKeyB64);

    assert.notEqual(fp1, fp2, 'Different keys must produce different fingerprints');
  });
});

describe('cowork-crypto interop: X25519 ECDH cross-derive (t-004d)', () => {
  it('daemon keypair + extension keypair derive same shared secret via cross-ECDH', async () => {
    // Daemon generates keypair (Node.js)
    const daemonKp = generateEphemeralKeyPair();

    // Extension generates keypair (WebCrypto)
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    // Daemon computes shared secret: daemon_private × ext_public
    const daemonShared = computeSharedSecret(daemonKp.privateKey, extPubKeyB64);

    // Extension computes shared secret: ext_private × daemon_public
    const extSharedBits = await extDeriveBits(extKp.privateKey, daemonKp.publicKeyB64);
    const extSharedBytes = Buffer.from(extSharedBits);

    assert.ok(
      daemonShared.equals(extSharedBytes),
      `Shared secrets must match via cross-ECDH.\nDaemon: ${daemonShared.toString('hex')}\nExt:    ${extSharedBytes.toString('hex')}`,
    );
  });

  it('extension public key is valid raw 32-byte X25519 key', async () => {
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    const rawBytes = Buffer.from(fromBase64(extPubKeyB64));
    assert.equal(rawBytes.length, 32, 'Extension public key must be 32 bytes');

    // Verify daemon can use it for ECDH (would throw if invalid)
    const daemonKp = generateEphemeralKeyPair();
    const shared = computeSharedSecret(daemonKp.privateKey, extPubKeyB64);
    assert.equal(shared.length, 32, 'ECDH result must be 32 bytes');
  });

  it('daemon public key (publicKeyB64) is valid raw 32-byte key importable by extension', async () => {
    const daemonKp = generateEphemeralKeyPair();
    const rawBytes = Buffer.from(fromBase64(daemonKp.publicKeyB64));
    assert.equal(rawBytes.length, 32, 'Daemon public key must be 32 bytes');

    // Extension can import and use it
    const extKp = await extGenerateKeyPair();
    const extSharedBits = await extDeriveBits(extKp.privateKey, daemonKp.publicKeyB64);
    assert.equal(extSharedBits.byteLength, 32, 'Extension ECDH result must be 32 bytes');
  });

  it('full handshake simulation: both sides end up with same session key', async () => {
    // Simulates the cowork bridge handshake:
    //   1. Extension sends its public key
    //   2. Daemon responds with its public key
    //   3. Both derive session key from shared ECDH secret + PSK

    // Extension side
    const extKp = await extGenerateKeyPair();
    const extPubKeyB64 = await extExportPublicKey(extKp);

    // Daemon side
    const daemonKp = generateEphemeralKeyPair();
    const daemonPubKeyB64 = daemonKp.publicKeyB64;

    // Daemon derives session key
    const daemonShared = computeSharedSecret(daemonKp.privateKey, extPubKeyB64);
    const daemonSessionKey = daemonDeriveSessionKey(daemonShared, TEST_PSK, extPubKeyB64, daemonPubKeyB64);

    // Extension derives session key
    const extShared = await extDeriveBits(extKp.privateKey, daemonPubKeyB64);
    const extSessionKey = await extDeriveSessionKey(extShared, TEST_PSK, extPubKeyB64, daemonPubKeyB64);

    // Verify keys match
    const extKeyRaw = await subtle.exportKey('raw', extSessionKey) as ArrayBuffer;
    const extKeyBytes = Buffer.from(extKeyRaw);
    assert.ok(
      daemonSessionKey.equals(extKeyBytes),
      `Full handshake: session keys must match.\nDaemon: ${daemonSessionKey.toString('hex')}\nExt:    ${extKeyBytes.toString('hex')}`,
    );

    // Verify bidirectional encryption works
    const plaintext = 'Hello from the extension!';
    const seq = 1;

    const extEnvelope = await extEncrypt(extSessionKey, plaintext, seq);
    const daemonDecrypted = daemonDecrypt(daemonSessionKey, extEnvelope.payload, extEnvelope.nonce, seq);
    assert.equal(daemonDecrypted, plaintext);

    const { payload, nonce } = daemonEncrypt(daemonSessionKey, 'Hello from daemon!', seq + 1);
    const extDecrypted = await extDecrypt(extSessionKey, { payload, nonce, seq: seq + 1 });
    assert.equal(extDecrypted, 'Hello from daemon!');
  });
});
