/**
 * Focused tests for the R2 CRITICAL fixes on PR #274:
 *
 * 1. Abort signal cancels registerWithRetry promptly (no zombie loop).
 * 2. Concurrent initNetworkSDK calls share one in-flight promise (single-flight).
 * 3. give-up path populates result.error with failure details.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runRegistrationRetryLoop } from '../retry.js';
import { initNetworkSDK, _resetForTesting as resetSdkBridge } from '../sdk-bridge.js';
import { _registerMultiCommunityForTesting } from '../registration.js';
import { _resetForTesting as resetNetworkState } from '../network-state.js';
import type { AgentConfig, NetworkCommunity } from '../../../config.js';

// ── Minimal test config ──────────────────────────────────────

function makeConfig(communities: NetworkCommunity[] = []): AgentConfig {
  return {
    agent: { name: 'test-agent' },
    network: {
      enabled: true,
      communities,
    },
  } as unknown as AgentConfig;
}

// ── Test 1: shutdown-during-retry cancels promptly ───────────

describe('runRegistrationRetryLoop — abort signal cancels promptly', () => {
  it('resolves quickly when signal is aborted after first failed attempt', async () => {
    const ac = new AbortController();

    // Simulated register function that always fails and records each call
    let callCount = 0;
    const registerFn = mock.fn(async (_c: AgentConfig) => {
      callCount++;
      return { ok: false, error: 'simulated network failure' };
    });

    const onSuccess = mock.fn(async (_c: AgentConfig) => { /* should not be called */ });

    // Start the retry loop (first attempt will fail, then it'll sleep for 5s)
    const retryPromise = runRegistrationRetryLoop(
      makeConfig(),
      ac.signal,
      registerFn,
      onSuccess,
    );

    // Abort after a short delay — should interrupt the sleepCancellable
    await new Promise(r => setTimeout(r, 20));
    const abortedAt = Date.now();
    ac.abort();

    await retryPromise;
    const elapsed = Date.now() - abortedAt;

    assert.ok(elapsed < 200, `Loop should cancel within 200ms of abort, took ${elapsed}ms`);
    assert.equal(onSuccess.mock.calls.length, 0, 'onSuccess should not be called on abort');
    // registerFn was called once before the sleep; abort happens during sleep
    assert.ok(callCount >= 1, 'registerFn should have been called at least once');
  });

  it('resolves immediately if signal is already aborted before first attempt', async () => {
    const ac = new AbortController();
    ac.abort(); // pre-aborted

    const registerFn = mock.fn(async () => ({ ok: false, error: 'should not be called' }));
    const onSuccess = mock.fn(async () => {});

    const start = Date.now();
    await runRegistrationRetryLoop(makeConfig(), ac.signal, registerFn, onSuccess);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50, `Pre-aborted loop should resolve immediately, took ${elapsed}ms`);
    assert.equal(registerFn.mock.calls.length, 0, 'registerFn should not be called when pre-aborted');
  });
});

// ── Test 2: concurrent initNetworkSDK → single in-flight promise ─

describe('initNetworkSDK — single-flight guard', () => {
  beforeEach(() => {
    resetSdkBridge();
  });

  it('two concurrent calls return the same promise object', () => {
    // Pass a config with network disabled — initNetworkSDK returns false quickly
    // without touching keychain or the SDK package. Both concurrent calls must
    // get the same in-flight promise.
    const disabledConfig = { network: { enabled: false } };
    const p1 = initNetworkSDK(disabledConfig);
    const p2 = initNetworkSDK(disabledConfig);
    assert.strictEqual(p1, p2, 'concurrent initNetworkSDK calls must return the same promise');
  });

  it('in-flight clears after resolution — next call creates a new promise', async () => {
    const disabledConfig = { network: { enabled: false } };
    const p1 = initNetworkSDK(disabledConfig);
    await p1;
    // After resolution, _initInFlight should be null; next call is fresh
    const p2 = initNetworkSDK(disabledConfig);
    assert.notStrictEqual(p1, p2, 'after first resolves, next call should create a new promise');
    await p2;
  });
});

// ── Test 3: give-up path populates result.error ──────────────

describe('registerMultiCommunity — give-up populates result.error', () => {
  beforeEach(() => {
    resetNetworkState();
  });

  it('returns non-empty error when all relay registrations fail', async () => {
    // Mock global fetch to always return HTTP 503
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: 'service unavailable' }),
      } as Response;
    };

    try {
      const result = await _registerMultiCommunityForTesting(
        [{ name: 'test-relay', primary: 'https://relay.test.invalid' }],
        'test-agent',
        { publicKey: 'fakepub', privateKey: 'fakeprivGEBase64==' },
        undefined,
      );

      assert.equal(result.ok, false, 'result.ok should be false when all relays fail');
      assert.ok(result.error, 'result.error must be set (not undefined)');
      assert.ok(result.error.length > 0, 'result.error must be non-empty');
      assert.ok(
        result.error.includes('test-relay'),
        `result.error should mention the community name, got: ${result.error}`,
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('does not set error when all relays succeed', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => {
      return {
        ok: true,
        status: 201,
        json: async () => ({ name: 'test-agent', status: 'active' }),
      } as Response;
    };

    try {
      const result = await _registerMultiCommunityForTesting(
        [{ name: 'test-relay', primary: 'https://relay.test.invalid' }],
        'test-agent',
        { publicKey: 'fakepub', privateKey: 'fakeprivGEBase64==' },
        undefined,
      );

      assert.equal(result.ok, true);
      assert.equal(result.error, undefined, 'error should be absent on full success');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
