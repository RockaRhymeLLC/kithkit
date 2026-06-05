/**
 * Tests for tmux.ts — session name helpers, notification suppression,
 * and injectMessage log-level guard.
 *
 * The buildOrchestratorWrapperScript function was removed in the v2 orchestrator
 * cutover (replaced by --agent orchestrator). These tests cover the remaining
 * pure logic portions of the module.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initLogger, _resetLoggerForTesting } from '../core/logger.js';
import {
  _getCommsSession,
  _getOrchestratorSession,
  injectMessage,
  _getInjectionAttempts,
  _resetInjectionAttempts,
  _setTmuxDepsForTesting,
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

// ── injectMessage: log-level guard (R2 safety) ───────────────

/**
 * Verify the R2 guard: injectMessage should only downgrade to debug when
 * the orchestrator is confirmed gone. If it's alive but session lookup
 * fails, that's a real delivery failure and must stay warn.
 */
describe('injectMessage log level for missing session (R2 guard)', () => {
  let logDir: string;

  function readLogEntries(): Array<{ level: string; msg: string; data?: Record<string, unknown> }> {
    const logFile = path.join(logDir, 'daemon.log');
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e): e is { level: string; msg: string; data?: Record<string, unknown> } => e !== null);
  }

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-tmux-test-'));
    // Capture debug level so we can verify the downgrade
    initLogger({ logDir, minLevel: 'debug' });
  });

  afterEach(() => {
    _setTmuxDepsForTesting(null);
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('logs debug (not warn) when orch session not found and orchestrator is gone', () => {
    _setTmuxDepsForTesting({
      sessionExists: () => false,   // simulate: tmux has-session fails
      isOrchAlive: () => false,     // orchestrator is confirmed gone
    });

    const result = injectMessage('orchestrator', 'test nudge');
    assert.equal(result, false, 'should return false when session not found');

    const entries = readLogEntries();
    const debugEntries = entries.filter(e => e.level === 'debug' && e.msg.includes('orchestrator has exited'));
    const warnEntries = entries.filter(e => e.level === 'warn' && e.msg.includes('session not found'));

    assert.ok(debugEntries.length > 0, `expected debug log when orch is gone, got: ${JSON.stringify(entries)}`);
    assert.equal(warnEntries.length, 0, `should not warn when orch is gone (stale ref), got: ${JSON.stringify(warnEntries)}`);
  });

  it('logs warn when orch session not found but orchestrator appears alive (real delivery failure)', () => {
    _setTmuxDepsForTesting({
      sessionExists: () => false,   // simulate: tmux has-session fails
      isOrchAlive: () => true,      // orchestrator is alive (e.g. name-mismatch scenario)
    });

    const result = injectMessage('orchestrator', 'test nudge');
    assert.equal(result, false, 'should return false when session not found');

    const entries = readLogEntries();
    const warnEntries = entries.filter(e => e.level === 'warn' && e.msg.includes('session not found'));
    const debugDowngrade = entries.filter(e => e.level === 'debug' && e.msg.includes('orchestrator has exited'));

    assert.ok(warnEntries.length > 0, `expected warn log when orch is alive but session not found, got: ${JSON.stringify(entries)}`);
    assert.equal(debugDowngrade.length, 0, `should not silently downgrade when orch is alive, got: ${JSON.stringify(debugDowngrade)}`);
  });
});
