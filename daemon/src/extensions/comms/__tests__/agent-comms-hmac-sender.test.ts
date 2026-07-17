/**
 * Mutation-kill tests for the outbound HMAC signing path (#3225).
 *
 * Pins two behaviors of _resolveHmacSignatureHeaders:
 *   1. When the keychain reader returns null (absent entry, locked Keychain,
 *      or timeout), the sender logs at ERROR level — NOT warn, NOT silent.
 *   2. When a valid secret is present, the correct HMAC header is produced.
 *
 * Mutation-kill property (item 1):
 *   If production is reverted to the old warn-and-send-silently path:
 *     - log.error call is absent → console.error spy receives zero calls
 *     - "should log at ERROR level" test goes RED
 *
 * RED-on-revert is confirmed manually and recorded in the PR description.
 *
 * Seam: _setHmacKeychainReaderForTesting replaces readKeychain with a stub
 * that returns null (models absent entry — the real non-throw null path).
 * HMAC computation code still runs for the positive case — nothing is mocked
 * beyond keychain access.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mock } from 'node:test';
import {
  _resolveHmacSignatureHeaders,
  _setHmacKeychainReaderForTesting,
  _resetHmacKeychainReaderForTesting,
} from '../agent-comms.js';
import { _resetLoggerForTesting } from '../../../core/logger.js';

// ── Keychain stubs ────────────────────────────────────────────────────────────

/** Models an absent entry — the real readKeychain null-return path (non-lock). */
const keychainEmpty = async (_service: string): Promise<string | null> => null;

/** Models a healthy Keychain with a known secret. */
const keychainWithSecret = async (_service: string): Promise<string | null> =>
  'test-hmac-secret-for-3225';

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  // Initialise the logger so that log.error() calls console.error() (not console.log).
  // This makes the spy on console.error a reliable discriminator between error/warn.
  _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'debug' });
});

afterEach(() => {
  _resetHmacKeychainReaderForTesting();
  mock.restoreAll();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('_resolveHmacSignatureHeaders — null secret (absent entry)', () => {
  /**
   * Core mutation-kill test (#3225a).
   *
   * Pre-fix: log.warn called; console.error is NOT called → spy sees 0 calls → RED.
   * Post-fix: log.error called; console.error IS called → spy sees ≥1 call → GREEN.
   *
   * The assertion on the message text confirms it's the HMAC error, not some
   * unrelated error log firing during setup.
   */
  it('logs at ERROR level (not warn) and returns empty headers when secret is null', async () => {
    _setHmacKeychainReaderForTesting(keychainEmpty);

    const errorSpy = mock.method(console, 'error');

    const headers = await _resolveHmacSignatureHeaders('{"type":"text","text":"hello"}');

    assert.deepEqual(headers, [], 'empty headers — message will be sent unsigned');

    const calls = errorSpy.mock.calls;
    assert.ok(calls.length > 0, 'console.error must be called at least once (ERROR-level log)');

    const msg = String(calls[0].arguments[0]);
    assert.ok(
      msg.includes('HMAC') && msg.includes('unsigned'),
      `ERROR log must reference HMAC signing failure, got: ${msg}`,
    );
  });
});

describe('_resolveHmacSignatureHeaders — secret present', () => {
  it('returns X-Signature header containing a valid hex HMAC when secret is present', async () => {
    _setHmacKeychainReaderForTesting(keychainWithSecret);

    const payload = '{"type":"text","text":"hello","messageId":"mk-1"}';
    const headers = await _resolveHmacSignatureHeaders(payload);

    assert.ok(headers.length >= 2, 'should return at least -H and X-Signature: value');

    const flagIdx = headers.indexOf('-H');
    assert.notEqual(flagIdx, -1, 'curl -H flag must be present');

    const headerValue = headers[flagIdx + 1];
    assert.ok(
      typeof headerValue === 'string' && headerValue.startsWith('X-Signature:'),
      `header must start with X-Signature:, got: ${headerValue}`,
    );

    // Verify the HMAC is a non-empty hex string (64 chars for sha256)
    const hex = headerValue.replace('X-Signature:', '').trim();
    assert.match(hex, /^[0-9a-f]{64}$/, 'HMAC must be a 64-char lowercase hex sha256');
  });
});
