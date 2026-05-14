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

  it('Test A: injectMessage attempts tmux when flag is unset', () => {
    // Ensure flag is absent
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;

    // The call will fail internally (no tmux in test env) but that's expected —
    // what matters is that it passed the env-var guard (_injectionAttempts > 0).
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
