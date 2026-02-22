import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateCatalogAuthority } from '../src/keygen.ts';
import { signFile } from '../src/sign.ts';
import { verifyFile } from '../src/verify.ts';

// ── t-063: Ed25519 sign and verify round-trip ──────────────────────────────

describe('t-063 — Ed25519 sign and verify round-trip', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kithkit-sign-t063-'));
  const testFile = join(tmpDir, 'payload.bin');

  // 1. Generate keypair
  const { publicKey, privateKey } = generateCatalogAuthority();

  it('generates base64-encoded public and private keys', () => {
    assert.ok(typeof publicKey === 'string', 'publicKey should be a string');
    assert.ok(typeof privateKey === 'string', 'privateKey should be a string');
    // Valid base64: can be decoded without error
    assert.ok(Buffer.from(publicKey, 'base64').length > 0, 'publicKey should decode to non-empty buffer');
    assert.ok(Buffer.from(privateKey, 'base64').length > 0, 'privateKey should decode to non-empty buffer');
  });

  it('signs a test file and returns a base64 signature string', async () => {
    writeFileSync(testFile, 'Hello, Kithkit!');
    const sig = await signFile(testFile, privateKey);
    assert.ok(typeof sig === 'string', 'signature should be a string');
    assert.ok(sig.length > 0, 'signature should be non-empty');
    // Should decode cleanly from base64
    assert.ok(Buffer.from(sig, 'base64').length > 0, 'signature should be valid base64');
  });

  it('verifies the signature against the original file → true', async () => {
    const sig = await signFile(testFile, privateKey);
    const valid = await verifyFile(testFile, sig, publicKey);
    assert.equal(valid, true, 'signature should verify against original file');
  });

  it('returns false when file content is modified after signing', async () => {
    const sig = await signFile(testFile, privateKey);
    // Modify the file
    writeFileSync(testFile, 'Tampered content!');
    const valid = await verifyFile(testFile, sig, publicKey);
    assert.equal(valid, false, 'signature should NOT verify against modified file');
    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });
});

// ── t-064: Dual-signing for key rotation ──────────────────────────────────

describe('t-064 — Dual-signing for key rotation', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kithkit-sign-t064-'));
  const testFile = join(tmpDir, 'payload.bin');
  writeFileSync(testFile, 'Stable content for rotation test');

  const oldKeys = generateCatalogAuthority();
  const newKeys = generateCatalogAuthority();

  it('generates two distinct keypairs', () => {
    assert.notEqual(oldKeys.publicKey, newKeys.publicKey, 'public keys should differ');
    assert.notEqual(oldKeys.privateKey, newKeys.privateKey, 'private keys should differ');
  });

  it('produces two different signatures for the same file', async () => {
    const sigOld = await signFile(testFile, oldKeys.privateKey);
    const sigNew = await signFile(testFile, newKeys.privateKey);
    assert.notEqual(sigOld, sigNew, 'signatures from different keys should differ');
  });

  it('verifies old signature with old public key → true', async () => {
    const sigOld = await signFile(testFile, oldKeys.privateKey);
    const valid = await verifyFile(testFile, sigOld, oldKeys.publicKey);
    assert.equal(valid, true, 'old signature should verify with old public key');
  });

  it('verifies new signature with new public key → true', async () => {
    const sigNew = await signFile(testFile, newKeys.privateKey);
    const valid = await verifyFile(testFile, sigNew, newKeys.publicKey);
    assert.equal(valid, true, 'new signature should verify with new public key');
  });

  it('old public key rejects new signature → false', async () => {
    const sigNew = await signFile(testFile, newKeys.privateKey);
    const valid = await verifyFile(testFile, sigNew, oldKeys.publicKey);
    assert.equal(valid, false, 'old public key should NOT verify signature made by new private key');
    // Cleanup
    rmSync(tmpDir, { recursive: true });
  });
});
