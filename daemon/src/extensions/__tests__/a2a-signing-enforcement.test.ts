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

  // ── fix #3148 — null-secret fail-closed ──────────────────
  // MUTATION-KILL: revert the 'if (secret === null) { if (posture === 'enforce') { return reject... } }'
  // branch to return { action: 'accept' } unconditionally and this test goes RED.
  // RED output is captured in the PR description.
  it('null secret fails-closed under enforce (fix #3148): null return → reject, permissive → accept', async () => {
    _setKeychainReaderForTesting(keychainEmpty); // returns null — same as real readKeychain on ANY error

    // enforce: null secret must reject (fail-closed)
    const enforceResult = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'enforce');
    assert.strictEqual(enforceResult.action, 'reject',
      'enforce + null secret (absent key or read failure) must reject (fail-closed) — fix #3148');
    assert.ok(enforceResult.reason?.includes('Keychain'),
      'Reason must mention Keychain so operators know what to check');

    // permissive: null secret (no key configured) → accept (unconfigured LAN is trusted)
    const permissiveResult = await _checkA2ASignatureEnforcement(TEST_BODY, undefined, 'permissive');
    assert.strictEqual(permissiveResult.action, 'accept',
      'permissive + null secret (no key configured) must still accept');
  });
});

// ── Tests: /agent/p2p HTTP handler ────────────────────────────
//
// todo #3058 (Change 2): HMAC-X-Signature enforcement has been REMOVED from the relay
// /agent/p2p path. Security on the relay path is provided by the SDK's Ed25519 signature
// verification (processEnvelope in messaging.ts) and the msg.verified gate in
// wireMessageEvent (sdk-bridge.ts). The HMAC gate lives on the LAN /agent/message path only.
//
// Mutation-kill property: if HMAC enforcement is RE-ADDED to handleAgentP2P, the test
// "relay path: unsigned request reaches SDK layer (no 401 auth gate)" goes RED — the
// response would be 401 instead of 503 (SDK unavailable), violating the assertion.

describe('/agent/p2p — relay path (HMAC gate removed per #3058)', () => {
  let testIpCounter = 100;
  const nextIp = () => `198.51.${++testIpCounter}.1`;

  const validEnvelope = JSON.stringify({
    version: '1', type: 'direct', messageId: 'm-relay-1', sender: 'bmo',
    recipient: 'skippy', timestamp: new Date().toISOString(),
    payload: { ciphertext: 'abc', nonce: 'xyz' }, signature: 'any',
  });

  beforeEach(() => {
    _setKeychainReaderForTesting(keychainWithSecret);
    _setConfigForTesting(makeConfig('enforce', 'permissive'));
  });
  afterEach(() => {
    _resetKeychainReaderForTesting();
    _setConfigForTesting(null);
  });

  it('relay path: unsigned request reaches SDK layer — no HMAC 401 gate', async () => {
    // HMAC is not checked on /agent/p2p (relay path). Unsigned request falls through
    // to handleIncomingP2P which returns {ok:false} (SDK not initialised in tests) → 503.
    // MUTATION-KILL: if HMAC enforcement is re-added, this returns 401, not 503 — test goes RED.
    const { res, captured } = makeRes();
    const req = makeReq(validEnvelope, {}, nextIp()); // no x-signature header
    await _handleAgentP2PForTesting(req, res, '/agent/p2p', new URLSearchParams());
    assert.notStrictEqual(captured.status, 401,
      'Relay /agent/p2p must NOT return 401 — HMAC auth is not applied to this path. ' +
      'If RED: HMAC gate was re-added to handleAgentP2P — remove it (security lives on msg.verified).');
    // SDK not initialised → 503 (transient)
    assert.strictEqual(captured.status, 503,
      'Relay /agent/p2p must return 503 (SDK unavailable) not 401 (HMAC rejection)');
  });

  it('relay path: keychain availability does NOT block relay requests', async () => {
    // Keychain failure on the relay path does not block (HMAC not checked here).
    _setKeychainReaderForTesting(keychainLocked);
    const { res, captured } = makeRes();
    const req = makeReq(validEnvelope, {}, nextIp());
    await _handleAgentP2PForTesting(req, res, '/agent/p2p', new URLSearchParams());
    assert.notStrictEqual(captured.status, 401,
      'Keychain unavailability must NOT block relay path — HMAC not applied here.');
    assert.strictEqual(captured.status, 503, 'Expected 503 (SDK unavailable) regardless of keychain state');
  });

  it('relay path: posture config does not change HTTP outcome (HMAC not applied)', async () => {
    // Both enforce and permissive config produce the same HTTP result on /agent/p2p
    // because HMAC is not checked on the relay path.
    _setConfigForTesting(makeConfig('permissive', 'permissive'));
    const { res: resP, captured: capP } = makeRes();
    await _handleAgentP2PForTesting(makeReq(validEnvelope, {}, nextIp()), resP, '/agent/p2p', new URLSearchParams());

    _setConfigForTesting(makeConfig('enforce', 'permissive'));
    const { res: resE, captured: capE } = makeRes();
    await _handleAgentP2PForTesting(makeReq(validEnvelope, {}, nextIp()), resE, '/agent/p2p', new URLSearchParams());

    assert.strictEqual(capP.status, 503, 'permissive config: relay path → 503');
    assert.strictEqual(capE.status, 503, 'enforce config: relay path → 503 (not 401)');
    assert.strictEqual(capP.status, capE.status, 'Relay path outcome must be posture-independent');
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

  // ── fix #3148 — HTTP-level null-secret fail-closed ────────
  // MUTATION-KILL: revert the null-secret → reject branch in _checkA2ASignatureEnforcement
  // and this test goes RED (returns non-401 instead of 401).
  it('HTTP 401 when keychain returns null (not throws) under enforce posture (fix #3148)', async () => {
    _setKeychainReaderForTesting(keychainEmpty); // null return — models real readKeychain behavior on any error
    _setConfigForTesting(makeConfig('permissive', 'enforce'));
    const { res, captured } = makeRes();
    const req = makeReq(validMessage, {}, nextIp()); // unsigned
    await _handleAgentMessageRouteForTesting(req, res, '/agent/message', new URLSearchParams());
    assert.strictEqual(captured.status, 401,
      'null secret (null return, not throw) + enforce must yield HTTP 401 (fail-closed, fix #3148)');
    assert.strictEqual(captured.body.ok, false,
      'Response body must indicate failure');
  });
});
