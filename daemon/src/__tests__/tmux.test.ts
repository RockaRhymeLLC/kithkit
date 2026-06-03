/**
 * Tests for tmux.ts — session name helpers and notification suppression.
 *
 * The buildOrchestratorWrapperScript function was removed in the v2 orchestrator
 * cutover (replaced by --agent orchestrator). These tests cover the remaining
 * pure logic portions of the module.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _getCommsSession,
  _getOrchestratorSession,
  injectMessage,
  _getInjectionAttempts,
  _resetInjectionAttempts,
} from '../agents/tmux.js';

// ── Session name helpers ──────────────────────────────────────

describe('Session name helpers', () => {
  it('_getCommsSession returns the generic comms session name', () => {
    assert.equal(_getCommsSession(), 'comms1');
  });

  it('_getOrchestratorSession returns the generic orchestrator session name', () => {
    assert.equal(_getOrchestratorSession(), 'orch1');
  });
});

// ── KITHKIT_SUPPRESS_NOTIFICATIONS guard ─────────────────────

describe('injectMessage — KITHKIT_SUPPRESS_NOTIFICATIONS guard', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    _resetInjectionAttempts();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    } else {
      process.env.KITHKIT_SUPPRESS_NOTIFICATIONS = savedEnv;
    }
    _resetInjectionAttempts();
  });

  it('Test A: injectMessage increments attempt counter when flag is unset', () => {
    // Ensure flag is absent to exercise the env-var guard path.
    // IMPORTANT: deleting KITHKIT_SUPPRESS_NOTIFICATIONS does NOT cause real tmux
    // I/O here. The production isUnderTestRunner() guard in injectMessage() fires
    // after _injectionAttempts++ and returns false before any execFileSync call.
    // This test safely verifies the attempt counter without relying on tmux absence.
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;

    injectMessage('comms', 'test message');
    assert.equal(_getInjectionAttempts(), 1, 'should have attempted injection (no suppression)');
  });

  it('Test B: injectMessage is a no-op when KITHKIT_SUPPRESS_NOTIFICATIONS=1', () => {
    process.env.KITHKIT_SUPPRESS_NOTIFICATIONS = '1';

    const result = injectMessage('comms', 'test message');

    assert.equal(result, false, 'should return false immediately');
    assert.equal(_getInjectionAttempts(), 0, 'should not attempt injection when suppressed');
  });
});

// ── Production guard regression ────────────────────────────

/**
 * Regression guard for the comms-flood live-op incident.
 *
 * Scenario that caused the flood:
 *   1. Test code deleted KITHKIT_SUPPRESS_NOTIFICATIONS.
 *   2. Called injectMessage('comms', ...).
 *   3. The only guard was the KITHKIT_SUPPRESS_NOTIFICATIONS env-var check.
 *   4. With it deleted, the code reached execFileSync(tmux, ['send-keys', '-t', 'COMMS_SESSION:', ...]).
 *   5. If COMMS_SESSION existed as a live session, canary text was injected into the production comms agent.
 *
 * Fix: isUnderTestRunner() in injectMessage (agents/tmux.ts) and injectText
 * (core/session-bridge.ts) detects the test-runner environment via NODE_TEST_CONTEXT
 * and other runner markers that test code CANNOT remove, and returns false before
 * any execFileSync call. This test proves that guard is active.
 *
 * If this test is deleted or the guard is removed, the flood WILL recur.
 */
describe('Production guard — blocks real tmux I/O under test runner (regression: comms-flood)', () => {
  let savedSuppress: string | undefined;
  let savedAllowInject: string | undefined;

  beforeEach(() => {
    savedSuppress = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    _resetInjectionAttempts();
  });

  afterEach(() => {
    if (savedSuppress === undefined) {
      delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    } else {
      process.env.KITHKIT_SUPPRESS_NOTIFICATIONS = savedSuppress;
    }
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
    _resetInjectionAttempts();
  });

  it('injectMessage is blocked by the test-runner guard even when KITHKIT_SUPPRESS_NOTIFICATIONS is deleted', () => {
    // Reproduce the exact conditions of the comms-flood incident:
    //   - KITHKIT_SUPPRESS_NOTIFICATIONS deleted (as Test A previously did)
    //   - KITHKIT_ALLOW_TEST_INJECT absent (no opt-in)
    // We are running under node --test, so NODE_TEST_CONTEXT=child is set by
    // the test runner process — isUnderTestRunner() must return true.
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    delete process.env.KITHKIT_ALLOW_TEST_INJECT;

    const result = injectMessage('comms', 'canary-regression-guard-test');

    // The attempt counter is incremented before the production guard fires —
    // this is intentional so tests asserting the counter still pass.
    assert.equal(_getInjectionAttempts(), 1, 'attempt counter must be tracked');

    // The guard must return false, proving no real execFileSync('tmux', 'send-keys')
    // was issued. If result is true, a real send-keys fired against the live session.
    assert.equal(result, false, 'production guard must block injection under test runner');
  });
});
