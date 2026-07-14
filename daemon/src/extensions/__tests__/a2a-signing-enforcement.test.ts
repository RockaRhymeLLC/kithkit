/**
 * A2A signing enforcement tests (#584).
 *
 * Coverage:
 *   _checkA2ASignatureEnforcement — core verification logic (real crypto.createHmac)
 *   _handleAgentP2PForTesting     — HTTP-level reject/accept for /agent/p2p
 *   _handleAgentMessageRouteForTesting — HTTP-level reject/accept for /agent/message
 *
 * The HMAC verification code path (crypto.createHmac) is NEVER mocked — it runs
 * with real keys and bodies on every test. Only the Keychain reader is injectable
 * so tests can supply a known secret without touching macOS Keychain.
 *
 * Mutation-kill property:
 *   If the enforce-posture reject logic is removed (action always returns 'accept'),
 *   the "rejects unsigned" and "rejects on keychain failure" tests go RED.
 *   Red output is captured in the PR description after applying each mutation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type http from 'node:http';
import {
  _checkA2ASignatureEnforcement,
  _setKeychainReaderForTesting,
  _resetKeychainReaderForTesting,
  _setConfigForTesting,
  _handleAgentP2PForTesting,
  _handleAgentMessageRouteForTesting,
} from '../index.js';
import type { AgentConfig } from '../config.js';

// ── Helpers ───────────────────────────────────────────────────

const TEST_SECRET = 'test-hmac-secret-for-584-enforcement';
const TEST_BODY = JSON.stringify({ from: 'bmo', type: 'text', text: 'hello', messageId: 'msg-1', timestamp: new Date().toISOString() });

/** Compute the correct HMAC for a body+secret pair. */
function computeHmac(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return hmac.digest('hex');
}

/** A keychain reader that returns a known secret (no macOS Keychain access). */
const keychainWithSecret = async (_service: string): Promise<string | null> => TEST_SECRET;

/** A keychain reader that returns null (key not configured). */
const keychainEmpty = async (_service: string): Promise<string | null> => null;

/** A keychain reader that throws (Keychain locked/inaccessible). */
const keychainLocked = async (_service: string): Promise<string | null> => {
  throw new Error('Keychain locked');
};

/** Build a minimal AgentConfig with a given a2a.security posture. */
function makeConfig(p2p: 'enforce' | 'permissive', message: 'enforce' | 'permissive'): AgentConfig {
  return { a2a: { security: { p2p, message } } } as unknown as AgentConfig;
}

// ── Mock HTTP helpers ─────────────────────────────────────────

interface CapturedResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeReq(body: string, extraHeaders: Record<string, string> = {}, remoteAddress = '127.0.2.1'): http.IncomingMessage {
  const readable = new Readable({ read() {} });
  readable.push(body);
  readable.push(null);
  const raw = Buffer.from(body);
  return Object.assign(readable, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    socket: { remoteAddress },
    _rawBody: raw, // pre-buffer so parseBodyRaw short-circuits stream reading
  }) as unknown as http.IncomingMessage;
}

function makeRes(): { res: http.ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: {} };
  const res = {
    writeHead(status: number) { captured.status = status; },
    end(b: string) { try { captured.body = JSON.parse(b); } catch { captured.body = {}; } },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

// ── Tests: _checkA2ASignatureEnforcement (core logic) ─────────

describe('_checkA2ASignatureEnforcement', () => {
  beforeEach(() => { _setKeychainReaderForTesting(keychainWithSecret); });
  afterEach(() => { _resetKeychainReaderForTesting(); });

  // ── enforce posture ───────────────────────────────────────

  it('rejects unsigned when key is configured + enforce posture', async () => {
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'enforce');
    assert.strictEqual(result.action, 'reject', 'Must reject unsigned with enforce posture');
    assert.ok(result.reason, 'Must provide a rejection reason');
  });

  it('rejects with keychain failure when enforce posture', async () => {
    _setKeychainReaderForTesting(keychainLocked);
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'enforce');
    assert.strictEqual(result.action, 'reject', 'Keychain failure + enforce must fail-closed');
    assert.ok(result.reason?.includes('Keychain'), 'Reason must mention Keychain');
  });

  it('accepts a correctly signed request under enforce posture', async () => {
    const sig = computeHmac(TEST_BODY, TEST_SECRET);
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, sig, 'enforce');
    assert.strictEqual(result.action, 'accept', 'Valid signature must be accepted');
  });

  it('rejects an incorrectly signed request under enforce posture', async () => {
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, 'deadbeef', 'enforce');
    assert.strictEqual(result.action, 'reject', 'Bad signature must be rejected regardless of posture');
  });

  // ── permissive posture ────────────────────────────────────

  it('warns (does not reject) unsigned when key is configured + permissive posture', async () => {
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'permissive');
    // action must NOT be 'reject' — the outcome is DISTINCT from enforce
    assert.notStrictEqual(result.action, 'reject', 'Permissive posture must not reject unsigned');
    assert.strictEqual(result.action, 'warn', 'Permissive unsigned must return warn (not silently accept)');
  });

  it('warns (does not reject) on keychain failure when permissive posture', async () => {
    _setKeychainReaderForTesting(keychainLocked);
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'permissive');
    assert.notStrictEqual(result.action, 'reject', 'Permissive keychain failure must not reject');
    assert.strictEqual(result.action, 'warn');
  });

  it('accepts a correctly signed request under permissive posture', async () => {
    const sig = computeHmac(TEST_BODY, TEST_SECRET);
    const result = await _checkA2ASignatureEnforcement(TEST_BODY, sig, 'permissive');
    assert.strictEqual(result.action, 'accept');
  });

  // ── no key configured ─────────────────────────────────────

  it('accepts unsigned when no key is configured, regardless of posture', async () => {
    _setKeychainReaderForTesting(keychainEmpty);
    const enforceResult = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'enforce');
    assert.strictEqual(enforceResult.action, 'accept', 'No-key-configured enforce: must accept (preserve current behaviour)');

    const permissiveResult = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'permissive');
    assert.strictEqual(permissiveResult.action, 'accept', 'No-key-configured permissive: must accept');
  });
});

// ── Tests: /agent/p2p HTTP handler ────────────────────────────

describe('/agent/p2p signing enforcement (HTTP layer)', () => {
  // Use a unique IP range per describe to avoid rate-limiter interference
  let testIpCounter = 100;
  const nextIp = () => `198.51.${++testIpCounter}.1`;

  beforeEach(() => {
    _setKeychainReaderForTesting(keychainWithSecret);
    // Set enforce posture (the default)
    _setConfigForTesting(makeConfig('enforce', 'permissive'));
  });
  afterEach(() => {
    _resetKeychainReaderForTesting();
    _setConfigForTesting(null);
  });

  it('rejects unsigned request (HTTP 401) when key configured + enforce', async () => {
    const { res, captured } = makeRes();
    const req = makeReq(TEST_BODY, {}, nextIp());
    await _handleAgentP2PForTesting(req, res, '/agent/p2p', new URLSearchParams());
    assert.strictEqual(captured.status, 401, 'Must return 401 for unsigned request under enforce');
    assert.strictEqual(captured.body.ok, false);
  });

  it('rejects on keychain failure (HTTP 401) — fails closed under enforce', async () => {
    _setKeychainReaderForTesting(keychainLocked);
    const { res, captured } = makeRes();
    const req = makeReq(TEST_BODY, {}, nextIp());
    await _handleAgentP2PForTesting(req, res, '/agent/p2p', new URLSearchParams());
    assert.strictEqual(captured.status, 401, 'Keychain failure + enforce must fail-closed (HTTP 401)');
    assert.strictEqual(captured.body.ok, false);
  });

  it('accepts a correctly signed request under enforce', async () => {
    const sig = computeHmac(TEST_BODY, TEST_SECRET);
    const { res, captured } = makeRes();
    // Provide a valid P2P envelope — handler passes to handleIncomingP2P after auth.
    // SDK is not initialised in tests so we expect a 503 (transient SDK unavailable),
    // NOT a 401 (auth rejected). HTTP 503 proves auth passed.
    const envelopeBody = JSON.stringify({
      version: '1', type: 'direct', messageId: 'm1', sender: 'bmo',
      recipient: 'skippy', timestamp: new Date().toISOString(),
      payload: { ciphertext: 'abc', nonce: 'xyz' }, signature: sig,
    });
    const envReq = makeReq(envelopeBody, { 'x-signature': computeHmac(envelopeBody, TEST_SECRET) }, nextIp());
    await _handleAgentP2PForTesting(envReq, res, '/agent/p2p', new URLSearchParams());
    // Auth passed → response is NOT 401 (auth failure); SDK-layer may return 503 or 422
    assert.notStrictEqual(captured.status, 401, 'Valid signature must pass auth — response must not be 401');
  });

  it('posture toggle: permissive config warns but accepts unsigned (not 401)', async () => {
    _setConfigForTesting(makeConfig('permissive', 'permissive'));
    const { res, captured } = makeRes();
    const envelopeBody = JSON.stringify({
      version: '1', type: 'direct', messageId: 'm2', sender: 'bmo',
      recipient: 'skippy', timestamp: new Date().toISOString(),
      payload: { ciphertext: 'abc', nonce: 'xyz' }, signature: 'ignored',
    });
    const req = makeReq(envelopeBody, {}, nextIp()); // no x-signature header
    await _handleAgentP2PForTesting(req, res, '/agent/p2p', new URLSearchParams());
    // With permissive posture, an unsigned request must NOT be rejected with 401
    assert.notStrictEqual(captured.status, 401, 'Permissive posture must not return 401 for unsigned request');
  });
});

// ── Tests: /agent/message HTTP handler ───────────────────────

describe('/agent/message signing enforcement (HTTP layer)', () => {
  let testIpCounter = 200;
  const nextIp = () => `203.0.${++testIpCounter}.1`;

  const validMessage = JSON.stringify({
    from: 'bmo', type: 'text', text: 'hello',
    messageId: 'msg-test-1', timestamp: new Date().toISOString(),
  });

  beforeEach(() => {
    _setKeychainReaderForTesting(keychainWithSecret);
  });
  afterEach(() => {
    _resetKeychainReaderForTesting();
    _setConfigForTesting(null);
  });

  it('accepts unsigned under DEFAULT config (permissive, no config set)', async () => {
    _setConfigForTesting(null); // null config → posture defaults to permissive
    const { res, captured } = makeRes();
    const req = makeReq(validMessage, {}, nextIp());
    await _handleAgentMessageRouteForTesting(req, res, '/agent/message', new URLSearchParams());
    // Not 401 — permissive default must allow unsigned messages
    assert.notStrictEqual(captured.status, 401, 'Default (permissive) must accept unsigned — got 401');
  });

  it('accepts unsigned when message posture explicitly set to permissive', async () => {
    _setConfigForTesting(makeConfig('enforce', 'permissive'));
    const { res, captured } = makeRes();
    const req = makeReq(validMessage, {}, nextIp());
    await _handleAgentMessageRouteForTesting(req, res, '/agent/message', new URLSearchParams());
    assert.notStrictEqual(captured.status, 401, 'Explicit permissive must not reject unsigned');
  });

  it('rejects unsigned (HTTP 401) when message posture flipped to enforce', async () => {
    _setConfigForTesting(makeConfig('permissive', 'enforce'));
    const { res, captured } = makeRes();
    const req = makeReq(validMessage, {}, nextIp());
    await _handleAgentMessageRouteForTesting(req, res, '/agent/message', new URLSearchParams());
    assert.strictEqual(captured.status, 401, 'enforce posture must reject unsigned — got non-401');
    assert.strictEqual(captured.body.ok, false);
  });

  it('accepts correctly signed request under enforce posture', async () => {
    _setConfigForTesting(makeConfig('permissive', 'enforce'));
    const sig = computeHmac(validMessage, TEST_SECRET);
    const { res, captured } = makeRes();
    const req = makeReq(validMessage, { 'x-signature': sig }, nextIp());
    await _handleAgentMessageRouteForTesting(req, res, '/agent/message', new URLSearchParams());
    // Auth passed → NOT 401
    assert.notStrictEqual(captured.status, 401, 'Valid signature must pass auth gate');
  });

  it('config knob toggles outcome: same body + no sig → 401 enforce vs non-401 permissive', async () => {
    // enforce → reject
    _setConfigForTesting(makeConfig('permissive', 'enforce'));
    const { res: resEnforce, captured: capEnforce } = makeRes();
    await _handleAgentMessageRouteForTesting(makeReq(validMessage, {}, nextIp()), resEnforce, '/agent/message', new URLSearchParams());
    assert.strictEqual(capEnforce.status, 401, 'enforce must produce 401');

    // permissive → accept (same body, same key, no signature)
    _setConfigForTesting(makeConfig('permissive', 'permissive'));
    const { res: resPerm, captured: capPerm } = makeRes();
    await _handleAgentMessageRouteForTesting(makeReq(validMessage, {}, nextIp()), resPerm, '/agent/message', new URLSearchParams());
    assert.notStrictEqual(capPerm.status, 401, 'permissive must not produce 401');
    // Outcomes are DISTINCT — not vacuously green
    assert.notStrictEqual(capEnforce.status, capPerm.status, 'enforce and permissive must yield distinct HTTP statuses');
  });
});
