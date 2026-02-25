/**
 * t-002: Cowork crypto — X25519 key generation, ECDH, HKDF key derivation
 * t-003: Cowork crypto — AES-256-GCM encrypt/decrypt
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEphemeralKeyPair,
  computeSharedSecret,
  deriveSessionKey,
  encrypt,
  decrypt,
  encryptEnvelope,
  decryptEnvelope,
  computeFingerprint,
  generateToken,
} from '../extensions/cowork-crypto.js';

describe('cowork-crypto: key generation and derivation (t-002)', () => {
  it('generateEphemeralKeyPair returns 32-byte public key', () => {
    const kp = generateEphemeralKeyPair();
    assert.ok(kp.publicKeyRaw instanceof Buffer);
    assert.equal(kp.publicKeyRaw.length, 32);
    assert.ok(kp.publicKeyB64.length > 0);
    assert.ok(kp.publicKey);
    assert.ok(kp.privateKey);
  });

  it('ECDH produces identical shared secrets from both directions', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();

    const secretAB = computeSharedSecret(alice.privateKey, bob.publicKeyB64);
    const secretBA = computeSharedSecret(bob.privateKey, alice.publicKeyB64);

    assert.ok(secretAB.equals(secretBA), 'Shared secrets must match');
    assert.equal(secretAB.length, 32);
  });

  it('deriveSessionKey returns 32-byte key', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKeyB64);
    const psk = 'a'.repeat(64); // test PSK

    const key = deriveSessionKey(shared, psk, alice.publicKeyB64, bob.publicKeyB64);
    assert.equal(key.length, 32);
  });

  it('deriveSessionKey is order-independent (keys sorted)', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKeyB64);
    const psk = 'b'.repeat(64);

    const key1 = deriveSessionKey(shared, psk, alice.publicKeyB64, bob.publicKeyB64);
    const key2 = deriveSessionKey(shared, psk, bob.publicKeyB64, alice.publicKeyB64);

    assert.ok(key1.equals(key2), 'Session key must be the same regardless of key order');
  });

  it('different PSK produces different session key', () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKeyB64);

    const key1 = deriveSessionKey(shared, 'a'.repeat(64), alice.publicKeyB64, bob.publicKeyB64);
    const key2 = deriveSessionKey(shared, 'b'.repeat(64), alice.publicKeyB64, bob.publicKeyB64);

    assert.ok(!key1.equals(key2), 'Different PSK must produce different session key');
  });

  it('computeFingerprint returns 16 hex chars, deterministic', () => {
    const kp = generateEphemeralKeyPair();
    const fp1 = computeFingerprint(kp.publicKeyB64);
    const fp2 = computeFingerprint(kp.publicKeyB64);

    assert.equal(fp1.length, 16);
    assert.match(fp1, /^[0-9a-f]{16}$/);
    assert.equal(fp1, fp2, 'Fingerprint must be deterministic');
  });
});

describe('cowork-crypto: AES-256-GCM encrypt/decrypt (t-003)', () => {
  // Helper to get a session key for testing
  function getTestSessionKey(): Buffer {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const shared = computeSharedSecret(alice.privateKey, bob.publicKeyB64);
    return deriveSessionKey(shared, 'c'.repeat(64), alice.publicKeyB64, bob.publicKeyB64);
  }

  it('encrypt then decrypt roundtrips correctly', () => {
    const key = getTestSessionKey();
    const msg = JSON.stringify({ type: 'cdp', method: 'Page.navigate', params: { url: 'https://example.com' } });

    const { payload, nonce } = encrypt(key, msg, 1);
    assert.ok(payload.length > 0);
    assert.ok(nonce.length > 0);

    const decrypted = decrypt(key, payload, nonce, 1);
    assert.equal(decrypted, msg);
  });

  it('decrypt with wrong key throws', () => {
    const key1 = getTestSessionKey();
    const key2 = getTestSessionKey();
    const msg = 'test message';

    const { payload, nonce } = encrypt(key1, msg, 1);

    assert.throws(() => {
      decrypt(key2, payload, nonce, 1);
    }, /Unsupported state|authentication|tag/i);
  });

  it('decrypt with wrong seq (AAD mismatch) throws', () => {
    const key = getTestSessionKey();
    const msg = 'test message';

    const { payload, nonce } = encrypt(key, msg, 1);

    assert.throws(() => {
      decrypt(key, payload, nonce, 2); // wrong seq
    }, /Unsupported state|authentication|tag/i);
  });

  it('different seq produces different AAD (different ciphertexts are expected)', () => {
    const key = getTestSessionKey();
    const msg = 'same message';

    const e1 = encrypt(key, msg, 1);
    const e2 = encrypt(key, msg, 2);

    // Different nonces guarantee different ciphertexts
    assert.notEqual(e1.nonce, e2.nonce);
  });

  it('tampered ciphertext is detected', () => {
    const key = getTestSessionKey();
    const { payload, nonce } = encrypt(key, 'hello world', 1);

    // Flip a byte in the middle of the payload
    const buf = Buffer.from(payload, 'base64');
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    const tampered = buf.toString('base64');

    assert.throws(() => {
      decrypt(key, tampered, nonce, 1);
    }, /Unsupported state|authentication|tag/i);
  });

  it('encryptEnvelope/decryptEnvelope roundtrip', () => {
    const key = getTestSessionKey();
    const msg = { type: 'hello', userAgent: 'Test/1.0' };

    const envelope = encryptEnvelope(key, msg, 1);
    assert.equal(envelope.type, 'encrypted');
    assert.equal(envelope.seq, 1);
    assert.ok(envelope.payload);
    assert.ok(envelope.nonce);

    const decrypted = decryptEnvelope(key, envelope) as Record<string, unknown>;
    assert.equal(decrypted['type'], 'hello');
    assert.equal(decrypted['userAgent'], 'Test/1.0');
  });

  it('generateToken returns 64-char hex string', () => {
    const token = generateToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);

    // Two tokens should be different
    const token2 = generateToken();
    assert.notEqual(token, token2);
  });
});
