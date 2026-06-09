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
  isOrchestratorAlive,
  ORCH_SESSION_PATTERN,
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

// ── isOrchestratorAlive — independent detection (fix/752) ────
//
// Mutation-kill tests for the independent-detection rewrite.
//
// HOW THE MUTATION KILL WORKS:
//   The OLD implementation checked `has-session -t =orch1` (hardcoded constant).
//   It does NOT use _testingDeps.listSessions, so changing the mock has NO EFFECT on it.
//   The NEW implementation reads from _testingDeps.listSessions (when set) and applies
//   ORCH_SESSION_PATTERN, so changing the mock DOES change the result.
//
//   PRIMARY KILL (machine-state-independent): verify that changing the listSessions mock
//   from "no orch session" to "orch2 exists" changes isOrchestratorAlive()'s return value.
//   - OLD impl: both calls hit real execFileSync(has-session, =orch1) → SAME result both
//     times regardless of mock → assert.notEqual fails → RED.
//   - NEW impl: first call returns false, second returns true → assert.notEqual passes → GREEN.
//
//   SECONDARY KILLS: direct assertions that pattern-matching works correctly. These also
//   fail with the old impl on machines where the real 'orch1' session is NOT running.

describe('isOrchestratorAlive — independent detection (fix/752)', () => {
  afterEach(() => {
    _setTmuxDepsForTesting(null);
  });

  it('ORCH_SESSION_PATTERN matches orch1, orch2, orch, orch123 but not comms1 or orch-foo', () => {
    assert.ok(ORCH_SESSION_PATTERN.test('orch1'),   'should match orch1 (ORCH_SESSION constant)');
    assert.ok(ORCH_SESSION_PATTERN.test('orch2'),   'should match orch2 (alternate name)');
    assert.ok(ORCH_SESSION_PATTERN.test('orch'),    'should match bare orch');
    assert.ok(ORCH_SESSION_PATTERN.test('orch123'), 'should match orch123');
    assert.ok(!ORCH_SESSION_PATTERN.test('comms1'), 'should NOT match comms1');
    assert.ok(!ORCH_SESSION_PATTERN.test('orch-foo'), 'should NOT match orch-foo');
    assert.ok(!ORCH_SESSION_PATTERN.test(''),       'should NOT match empty string');
  });

  it('MUTATION-KILL (primary): result must change when listSessions switches from no-orch to orch2', () => {
    // This test kills the old has-session-on-constant implementation without relying on
    // real machine tmux state.
    //
    // OLD impl ignores _testingDeps.listSessions entirely — it always calls
    //   execFileSync(TMUX_BIN, has-session, -t =orch1).
    // So withNoOrch and withOrch2 both produce the SAME value (whatever the real tmux says).
    //   assert.notEqual(withNoOrch, withOrch2) → FAILS → RED.
    //
    // NEW impl consults _testingDeps.listSessions → withNoOrch = false, withOrch2 = true.
    //   assert.notEqual(false, true) → PASSES → GREEN.

    _setTmuxDepsForTesting({ listSessions: () => ['comms1'] }); // no orch session
    const withNoOrch = isOrchestratorAlive();

    _setTmuxDepsForTesting({ listSessions: () => ['comms1', 'orch2'] }); // orch2 added
    const withOrch2 = isOrchestratorAlive();

    assert.equal(withNoOrch, false,
      'should return false when no session matches ORCH_SESSION_PATTERN');
    assert.equal(withOrch2, true,
      'should return true when orch2 exists in the session list');
    assert.notEqual(withNoOrch, withOrch2,
      'result MUST change when an orch-pattern session is added — ' +
      'old has-session-on-constant impl returns the same value both times (cannot pass this)');
  });

  it('MUTATION-KILL (secondary): returns false when no orchestrator sessions exist', () => {
    // Only non-orch sessions present. Old impl: ignores mock, calls has-session =orch1.
    // On machines without real orch1 running: old impl returns false (coincidental pass).
    // On machines WITH real orch1 running: old impl returns true (fails assert → RED kill).
    _setTmuxDepsForTesting({ listSessions: () => ['comms1', 'worker-abc'] });

    const result = isOrchestratorAlive();
    assert.equal(result, false,
      'isOrchestratorAlive() must return false when no session matches ORCH_SESSION_PATTERN');
  });

  it('MUTATION-KILL (secondary): returns false when session list is empty (tmux not running)', () => {
    // tmux server not running → listSessions() returns []. Old impl: ignores mock.
    // Old impl on machines WITH real orch1: returns true (fails → RED kill).
    _setTmuxDepsForTesting({ listSessions: () => [] });

    const result = isOrchestratorAlive();
    assert.equal(result, false,
      'isOrchestratorAlive() must return false when no sessions exist at all');
  });

  it('returns true when the standard ORCH_SESSION name (orch1) appears in the list', () => {
    // Regression guard: standard operation must still work.
    _setTmuxDepsForTesting({ listSessions: () => ['comms1', 'orch1'] });

    const result = isOrchestratorAlive();
    assert.equal(result, true,
      'isOrchestratorAlive() must still return true for the standard orch1 session name');
  });

  it('_testingDeps.isOrchAlive override still short-circuits before pattern detection', () => {
    // The isOrchAlive hook must fire and return its value without calling listSessions.
    // We verify this by making listSessions a sentinel that records if it was called.
    let listSessionsCalled = false;
    _setTmuxDepsForTesting({
      isOrchAlive: () => true,
      listSessions: () => { listSessionsCalled = true; return []; },
    });

    const result = isOrchestratorAlive();
    assert.equal(result, true, '_testingDeps.isOrchAlive must be respected');
    assert.equal(listSessionsCalled, false,
      '_testingDeps.isOrchAlive must short-circuit before listSessions is called');
  });

  it('_testingDeps.isOrchAlive returning false also short-circuits correctly', () => {
    let listSessionsCalled = false;
    _setTmuxDepsForTesting({
      isOrchAlive: () => false,
      listSessions: () => { listSessionsCalled = true; return ['orch1']; },
    });

    const result = isOrchestratorAlive();
    assert.equal(result, false, '_testingDeps.isOrchAlive returning false must be respected');
    assert.equal(listSessionsCalled, false,
      '_testingDeps.isOrchAlive must short-circuit (false case) before listSessions is called');
  });
});
