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
  verifySubmitLanded,
  _getInjectionAttempts,
  _resetInjectionAttempts,
  _setTmuxDepsForTesting,
  isOrchestratorAlive,
  getOrchestratorState,
  ORCH_SESSION_PATTERN,
  spawnOrchestratorSession,
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

  let savedAllowInject: string | undefined;

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-tmux-test-'));
    // Capture debug level so we can verify the downgrade
    initLogger({ logDir, minLevel: 'debug' });
    // Opt in to real session-check logic (bypasses the test-runner guard in injectMessage)
    // so that the session lookup and its log calls actually execute.
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
  });

  afterEach(() => {
    _setTmuxDepsForTesting(null);
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    fs.rmSync(logDir, { recursive: true, force: true });
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
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
    //
    // orchProcessState: () => 'waiting' is set for the second mock so that the
    // pane-PID liveness check (getOrchestratorState) reports a live session.

    _setTmuxDepsForTesting({ listSessions: () => ['comms1'] }); // no orch session
    const withNoOrch = isOrchestratorAlive();

    _setTmuxDepsForTesting({
      listSessions: () => ['comms1', 'orch2'],  // orch2 added
      orchProcessState: () => 'waiting',         // pane is alive (required for zombie guard)
    });
    const withOrch2 = isOrchestratorAlive();

    assert.equal(withNoOrch, false,
      'should return false when no session matches ORCH_SESSION_PATTERN');
    assert.equal(withOrch2, true,
      'should return true when orch2 exists in the session list and pane is alive');
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

  it('returns true when the standard ORCH_SESSION name (orch1) appears in the list and pane is alive', () => {
    // Regression guard: standard operation must still work.
    // orchProcessState: () => 'waiting' is required because the pane-PID liveness check
    // (getOrchestratorState) now runs after the session-name match (#796 zombie guard).
    _setTmuxDepsForTesting({
      listSessions: () => ['comms1', 'orch1'],
      orchProcessState: () => 'waiting',
    });

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

// ── isOrchestratorAlive — zombie session detection (fix #796) ────────────────
//
// Mutation-kill tests for the pane-PID liveness check added to isOrchestratorAlive().
//
// PROBLEM (kithkit#796): a zombie tmux session — where the session NAME still appears
// in `tmux list-sessions` but the pane's child process has exited — causes the
// pattern-only implementation to return true. Callers believe the orchestrator is alive
// and skip spawning a fresh one, leaving tasks permanently stuck.
//
// FIX: after the session-name pattern match, call getOrchestratorState() which performs
// the pane-PID liveness check (#439 dead-default, #853 fast-retry). 'dead' → zombie.
//
// HOW THE MUTATION KILL WORKS:
//   With the fix: listSessions finds 'orch1' → session match → getOrchestratorState()
//     is called → panePid throws → outer catch → 'dead' → isOrchestratorAlive() = false.
//   MUTATION (remove getOrchestratorState call): session match → return true immediately.
//     → assert.equal(result, false) FAILS → RED.
//
// SEAM ARCHITECTURE:
//   - listSessions: returns a session list with an orch-pattern name.
//   - sessionExists: () => true — tells getOrchestratorState() the session is still
//     present in tmux (simulates the zombie: has-session succeeds, pane dead).
//   - panePid: () => { throw } — simulates the dead-pane condition:
//     tmux display-message can't return a valid PID for the dead pane. This throw
//     propagates to the outer catch in getOrchestratorState() which returns 'dead'.
//   These three together are the minimal deterministic zombie simulation.

describe('isOrchestratorAlive — zombie session detection (fix #796)', () => {
  afterEach(() => {
    _setTmuxDepsForTesting(null);
  });

  it('MUTATION-KILL: returns false when session name matches but pane process is dead (zombie)', () => {
    // Zombie scenario: tmux session 'orch1' lingers in `list-sessions` but the
    // pane's child process (Claude) has already exited.
    //
    // listSessions returns ['orch1']  →  ORCH_SESSION_PATTERN matches
    // sessionExists: () => true       →  has-session still succeeds (session shell alive)
    // panePid: () => { throw }        →  display-message fails on dead pane → outer catch
    //                                    in getOrchestratorState() returns 'dead'
    //
    // MUTATION-KILL: removing the getOrchestratorState() call from isOrchestratorAlive()
    // makes it return true (pattern match alone) → assert.equal(false) FAILS → RED.
    _setTmuxDepsForTesting({
      listSessions: () => ['orch1'],
      sessionExists: () => true,
      panePid: () => { throw new Error('zombie pane: no valid pid'); },
    });

    const result = isOrchestratorAlive();
    assert.equal(result, false,
      'MUTATION-KILL: zombie session (name matches ORCH_SESSION_PATTERN but pane dead) ' +
      'must return false — removing the getOrchestratorState() check causes true → RED');
  });

  it('returns true when session name matches and pane process is genuinely alive', () => {
    // Sanity / non-zombie baseline: session name matches AND state is 'waiting' (live).
    // orchProcessState bypasses pane-PID syscalls for deterministic test behaviour.
    _setTmuxDepsForTesting({
      listSessions: () => ['orch1'],
      orchProcessState: () => 'waiting',
    });

    const result = isOrchestratorAlive();
    assert.equal(result, true,
      'live orchestrator session (name matches, pane alive) must still return true');
  });

  it('returns true when session name matches and pane is actively processing (active state)', () => {
    _setTmuxDepsForTesting({
      listSessions: () => ['orch1'],
      orchProcessState: () => 'active',
    });

    const result = isOrchestratorAlive();
    assert.equal(result, true,
      'active orchestrator session must return true — active state is alive, not zombie');
  });
});

// ── getOrchestratorState: outer-catch fallback (phantom-nudge fix, #110) ──────

/**
 * Regression suite for the outer-catch fallback in getOrchestratorState().
 *
 * Root cause of phantom new-task nudges (#110): when process-state detection
 * failed (e.g. `tmux display-message` timed out, unexpected pgrep error), the
 * outer catch returned 'waiting' instead of 'dead'. This caused the escalate
 * endpoint to fire a nudge to an unknown-state session instead of spawning a
 * fresh orchestrator — leaving the task pending but unreachable.
 *
 * Fix: outer catch now returns 'dead' (conservative). Callers treat the
 * unknown state as dead, so the escalate spawns a fresh session and the
 * idle monitor can pick up pending tasks normally.
 *
 * SEAM ARCHITECTURE:
 *   - orchProcessState injectable: has its OWN inner try/catch (lines 342-358).
 *     Throwing via orchProcessState is caught by that INNER catch, never reaching
 *     the outer catch at lines 397-406. NOT a mutation-killer for the outer catch.
 *   - sessionExists + panePid injectables: bypass the orchProcessState block entirely.
 *     sessionExists=true passes the has-session check; panePid throwing propagates
 *     directly into the outer try with no inner catch to intercept it. This IS a
 *     true mutation-killer for the outer catch.
 */
describe('getOrchestratorState — outer-catch fallback (phantom-nudge fix #110)', { concurrency: 1 }, () => {
  afterEach(() => _setTmuxDepsForTesting(null));

  it('MUTATION-KILL (outer catch via panePid seam): returns dead when display-message throws', () => {
    // TRUE mutation-killer for the outer catch (lines 397-406 in tmux.ts).
    //
    // orchProcessState is NOT set, so the seam block (lines 342-358) is bypassed.
    // sessionExists: () => true  →  has-session check passes, enters the outer try.
    // panePid: () => { throw }   →  propagates directly to the outer catch.
    //
    // MUTATION PROOF: reverting the outer catch from 'dead' to 'waiting' makes this
    // test RED. The orchProcessState=null approach does NOT kill that mutation because
    // its throw is caught by the seam's own inner catch, never reaching the outer catch.
    _setTmuxDepsForTesting({
      sessionExists: () => true,
      panePid: () => { throw new Error('simulated display-message failure'); },
    });
    const result = getOrchestratorState();
    assert.equal(result, 'dead',
      'outer catch must return dead (not waiting) — this seam drives the REAL outer catch, not the orchProcessState inner catch');
  });

  it('orchProcessState seam error is also caught as dead (inner catch, not outer)', () => {
    // orchProcessState returning null throws inside the seam block's OWN inner catch
    // (lines 352-357), which also returns 'dead'. This is NOT the outer catch (#110 fix)
    // but still verifies the seam handles unexpected errors defensively.
    _setTmuxDepsForTesting({ orchProcessState: () => null });
    const result = getOrchestratorState();
    assert.equal(result, 'dead',
      'orchProcessState inner catch must also return dead on error (defensive seam behavior)');
  });

  it('returns active when orchProcessState reports active', () => {
    _setTmuxDepsForTesting({ orchProcessState: () => 'active' });
    const result = getOrchestratorState();
    assert.equal(result, 'active',
      'orchProcessState=active must propagate unchanged');
  });

  it('returns waiting when orchProcessState reports waiting', () => {
    _setTmuxDepsForTesting({ orchProcessState: () => 'waiting' });
    const result = getOrchestratorState();
    assert.equal(result, 'waiting',
      'orchProcessState=waiting must propagate unchanged');
  });
});

// ── injectMessage: separate C-m submit + capture-pane verify (fix #853/#2297) ───
//
// Mutation-kill suite for the spawn-kickoff submit race fix.
//
// ROOT CAUSE (#853/#2297 / trace 8069cbf0):
//   A freshly-spawned orchestrator receives its kickoff nudge via a single
//   execFile('sleep', ['5']) → injectMessage() path. The text lands in the pane
//   but the submit keystroke (Enter/C-m) loses the race on slower boxes —
//   the orch sees the text but never submits it, and idles forever.
//
// FIX:
//   1. Readiness-gate: wait for Claude's `> ` input prompt before sending.
//   2. Text and submit are separate send-keys calls. The submit is always
//      `send-keys C-m` — never folded into the -l literal payload where
//      the sanitizer or length cap could swallow it.
//   3. verifySubmitLanded() uses capture-pane to confirm the pane advanced
//      after the submit; bounded retry re-sends C-m if not yet confirmed.
//
// SEAM ARCHITECTURE:
//   sendKeys injectable: records all send-keys calls without real tmux I/O.
//     - MUTATION-KILL: remove the standalone execSendKeys(session, ['C-m']) call
//       → no 'C-m' entry in sendKeysCalls → assert fails → RED.
//   capturePane injectable: returns pre-scripted pane content.
//     - Also suppresses all sleeps inside injectMessage when set (fast tests).
//     - MUTATION-KILL (COMMIT 4): return constant content → verifySubmitLanded
//       returns false → injectMessage returns false → result-assert fails → RED.
//
// HOW TO PROVE MUTATION-KILL:
//   1. GREEN baseline (as written).
//   2. Fold submit into text: replace execSendKeys(session, ['C-m']) with
//      execSendKeys(session, ['-l', stamped + '\r']) → no separate C-m call
//      → cmCalls filter returns [] → assert fails → RED.
//   3. Restore → GREEN.

describe('injectMessage — separate C-m submit with capture-pane verify (mutation-kill #853)', { concurrency: 1 }, () => {
  let savedAllowInject: string | undefined;
  let savedSuppress: string | undefined;

  beforeEach(() => {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    savedSuppress = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    // KITHKIT_ALLOW_TEST_INJECT=1 bypasses isUnderTestRunner() so the real
    // inject path runs; sendKeys + capturePane seams prevent actual tmux I/O.
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    _resetInjectionAttempts();
  });

  afterEach(() => {
    _setTmuxDepsForTesting(null);
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
    if (savedSuppress === undefined) {
      delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    } else {
      process.env.KITHKIT_SUPPRESS_NOTIFICATIONS = savedSuppress;
    }
    _resetInjectionAttempts();
  });

  it('MUTATION-KILL (primary): a standalone C-m send-keys call fires after the text payload', () => {
    // This is the primary mutation-killer for the spawn-kickoff race fix.
    //
    // The REAL submit path: execSendKeys(session, ['C-m']) is a dedicated call
    // in injectMessage's try block, separate from the text payload send.
    //
    // MUTATION: fold C-m into the text payload (execSendKeys(session, ['-l', text+'\r']))
    //   → no separate ['C-m'] entry in sendKeysCalls
    //   → cmCalls filter returns [] → length assertion fails → RED.
    //
    // This test drives the REAL submit path via sendKeys seam — not a bypass seam
    // that sidesteps the code deciding to send C-m (cf. PR #439's first submission).

    const sendKeysCalls: Array<{ session: string; args: string[] }> = [];
    let captureCallCount = 0;

    _setTmuxDepsForTesting({
      resolveSession: (id) => (id === 'orchestrator' ? 'orch1' : null),
      sessionExists: () => true,
      isOrchAlive: () => true,
      sendKeys: (session, args) => { sendKeysCalls.push({ session, args }); },
      // capturePane seam:
      //   call 0 (baseline / readiness gate): show prompt → isInputPromptReady passes
      //   call 1+ (verifySubmitLanded): return different content → verify returns true
      capturePane: (_session) => {
        const n = captureCallCount++;
        return n === 0
          ? '$ claude\n> '                         // ready prompt (baseline)
          : '$ claude\n[12:00:01] check queue\n> '; // submit confirmed (new content)
      },
    });

    const result = injectMessage('orchestrator', 'check queue');

    // injectMessage must return true (syscall succeeded)
    assert.equal(result, true, 'injectMessage must return true when send-keys syscall succeeds');

    // The standalone C-m call MUST be present in the recorded calls.
    // Mutation-kill: if C-m is folded into the text payload, this list is empty → RED.
    const cmCalls = sendKeysCalls.filter(c => c.args.includes('C-m'));
    assert.ok(
      cmCalls.length >= 1,
      `MUTATION-KILL: standalone C-m send-keys call must fire — got calls: ${JSON.stringify(sendKeysCalls)}`,
    );

    // The text payload call (-l) must NOT contain C-m (it must stay separate)
    const textCalls = sendKeysCalls.filter(c => c.args[0] === '-l');
    assert.ok(textCalls.length >= 1, 'text must be sent via -l literal send-keys');
    assert.ok(
      !textCalls.some(c => c.args.join('\0').includes('C-m')),
      `text payload must not fold C-m into the -l argument — mutation evidence: ${JSON.stringify(textCalls)}`,
    );

    // Every call must target the correct session
    assert.ok(
      sendKeysCalls.every(c => c.session === 'orch1'),
      'all send-keys calls must target the resolved orchestrator session',
    );
  });

  it('MUTATION-KILL (secondary): verifySubmitLanded detects pane-advanced via capturePane', () => {
    // Drives verifySubmitLanded() directly via the exported function.
    // The capturePane seam returns changed content → verify returns true.
    // Mutation: replace capturePaneContent() body with () => baselineContent
    //   (always same) → verify returns false → assert fails → RED.
    let calls = 0;
    _setTmuxDepsForTesting({
      resolveSession: () => 'orch1',
      sessionExists: () => true,
      isOrchAlive: () => true,
      capturePane: (_session) => {
        // First call: baseline (same)
        // Second call: pane advanced (different — simulates submit received)
        return calls++ === 0 ? '> ' : '> [response]\n> ';
      },
    });

    const baseline = '> ';
    const verified = verifySubmitLanded('orch1', baseline);
    assert.equal(verified, true,
      'verifySubmitLanded must return true when capturePane shows pane advanced');
  });

  it('verifySubmitLanded returns false when pane content does not change (submit not received)', () => {
    // COMMIT 4 receipt-based return precondition: if pane never changes,
    // verifySubmitLanded must return false so injectMessage can return false.
    _setTmuxDepsForTesting({
      resolveSession: () => 'orch1',
      sessionExists: () => true,
      isOrchAlive: () => true,
      capturePane: (_session) => '> ', // constant — no change
    });

    const baseline = '> ';
    const verified = verifySubmitLanded('orch1', baseline);
    assert.equal(verified, false,
      'verifySubmitLanded must return false when capturePane content does not change (submit not confirmed)');
  });
});

// ── spawnOrchestratorSession: args-capture (fix/870) ─────────
//
// WHAT THIS TEST CATCHES:
//   The prior buildOrchSpawnEnv return-value test only checked what env map was
//   built, NOT whether those vars were actually propagated to the pane. When a
//   tmux SERVER pre-exists, `execFileSync({env})` is a no-op — panes inherit the
//   SERVER's frozen env. R2 verified CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY ABSENT
//   via `ps eww`. The fix is to pass -e flags on the new-session command line,
//   which sets pane env explicitly regardless of server state.
//
// MUTATION-KILL (RED-on-revert proof):
//   Remove the two '-e','CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1' and '-e','CLAUDECODE='
//   pairs from the orchSpawnArgs array in tmux.ts, rebuild, run this test →
//   the assertions below fail (args array lacks the -e pairs) → RED.
//   Restore the pairs → GREEN.
//
// HOW THE SEAM WORKS:
//   _testingDeps.newSessionArgs intercepts the new-session execFileSync call
//   (same _testingDeps pattern as sendKeys). sessionExists: () => false ensures
//   the function proceeds past the "already running" check without real tmux I/O.

describe('spawnOrchestratorSession — tmux new-session args-capture (fix/870)', () => {
  afterEach(() => {
    _setTmuxDepsForTesting(null);
  });

  it('MUTATION-KILL: new-session args contain -e CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 and -e CLAUDECODE= before claudeBin', () => {
    let capturedArgs: string[] | null = null;

    _setTmuxDepsForTesting({
      sessionExists: () => false, // session does not exist → proceed to spawn
      newSessionArgs: (args) => { capturedArgs = args; },
    });

    spawnOrchestratorSession();

    assert.ok(capturedArgs !== null, 'newSessionArgs seam must have been called — spawnOrchestratorSession did not reach the spawn step');

    const args = capturedArgs as string[];

    // ── Assert -e CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 is present ──
    const surveyIdx = args.indexOf('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1');
    assert.ok(
      surveyIdx !== -1,
      `args must contain 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1' — got: ${JSON.stringify(args)}`,
    );
    assert.equal(
      args[surveyIdx - 1],
      '-e',
      `'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1' must be immediately preceded by '-e' — got args[${surveyIdx - 1}]='${args[surveyIdx - 1]}'`,
    );

    // ── Assert -e CLAUDECODE= is present ──
    const claudecodeIdx = args.indexOf('CLAUDECODE=');
    assert.ok(
      claudecodeIdx !== -1,
      `args must contain 'CLAUDECODE=' — got: ${JSON.stringify(args)}`,
    );
    assert.equal(
      args[claudecodeIdx - 1],
      '-e',
      `'CLAUDECODE=' must be immediately preceded by '-e' — got args[${claudecodeIdx - 1}]='${args[claudecodeIdx - 1]}'`,
    );

    // ── Assert both -e options appear BEFORE the claudeBin argument (tmux ordering) ──
    // claudeBin is the first arg that does not start with '-' and is not a tmux
    // option value (i.e. the actual command to run). We find it by locating the
    // boundary: the first arg after all tmux option pairs.
    // Strategy: claudeBin appears after '-y', '50' in the args list, so its index
    // is after the last tmux option value. We know the static prefix length is 12
    // (indices 0–11: -S SOCKET new-session -d -s NAME -c DIR -x 200 -y 50),
    // then the two -e pairs (indices 12–15), then claudeBin at index 16.
    // We assert using actual indexOf of the known value 'claude' or any path.
    const newSessionIdx = args.indexOf('new-session');
    assert.ok(newSessionIdx !== -1, 'args must contain new-session subcommand');

    // Find claudeBin: after '-y' '50', the next non -e-value arg that looks like a binary path.
    // Simplest robust check: survey + claudecode -e pairs must both appear before any
    // arg that contains 'claude' as a standalone binary name (the command portion).
    // We look for the claudeBin candidate: the first arg that ends with 'claude' or equals 'claude'
    // and appears AFTER the '-y' option.
    const yIdx = args.indexOf('-y');
    assert.ok(yIdx !== -1, 'args must contain -y (height)');

    // After '-y VALUE -e K -e K' comes claudeBin. Its index must be > surveyIdx and > claudecodeIdx.
    // We find it as the first arg after the -e pairs that doesn't start with '-'.
    const postY = args.slice(yIdx + 2); // skip '-y' and '50'
    let claudeBinIdx = -1;
    for (let i = 0; i < postY.length; i++) {
      const a = postY[i];
      if (!a.startsWith('-') && a !== 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1' && a !== 'CLAUDECODE=') {
        claudeBinIdx = (yIdx + 2) + i;
        break;
      }
    }
    assert.ok(
      claudeBinIdx !== -1,
      `could not find claudeBin in args — got postY: ${JSON.stringify(postY)}`,
    );

    assert.ok(
      surveyIdx < claudeBinIdx,
      `MUTATION-KILL: '-e CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1' (idx ${surveyIdx}) must appear BEFORE claudeBin (idx ${claudeBinIdx}) — tmux requires -e before the shell command`,
    );
    assert.ok(
      claudecodeIdx < claudeBinIdx,
      `MUTATION-KILL: '-e CLAUDECODE=' (idx ${claudecodeIdx}) must appear BEFORE claudeBin (idx ${claudeBinIdx}) — tmux requires -e before the shell command`,
    );
  });
});
