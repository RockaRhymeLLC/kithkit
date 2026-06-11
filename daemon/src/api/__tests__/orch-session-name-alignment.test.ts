/**
 * Regression guard — todo #81: orchestrator session name alignment.
 *
 * Both spawnOrchestratorSession() and injectMessage('orchestrator', ...) must
 * resolve the tmux session name via the shared resolveSession() function.
 *
 * Mutation-kill mechanism:
 *   _setTmuxDepsForTesting({ resolveSession: () => SENTINEL }) injects a sentinel
 *   value that differs from the real 'orch1'.  If either call site hardcodes 'orch1'
 *   (bypassing resolveSession), the sentinel never reaches that site and the assertion
 *   fires → the test goes RED, catching the regression.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnOrchestratorSession,
  injectMessage,
  _setTmuxDepsForTesting,
  _resetInjectionAttempts,
} from '../../agents/tmux.js';

/** Sentinel session name — deliberately different from the real 'orch1'. */
const SENTINEL = 'orch-test-sentinel-81';

describe('orch-session-name-alignment (todo #81)', () => {

  test('spawnOrchestratorSession returns the resolveSession result, not hardcoded orch1', () => {
    const seenSessions: string[] = [];

    _setTmuxDepsForTesting({
      resolveSession: (id) => (id === 'orchestrator' ? SENTINEL : null),
      // Return true so spawnOrchestratorSession takes the fast-path "already running" branch
      // and exits before reaching any real execFileSync tmux calls.
      sessionExists: (s) => { seenSessions.push(s); return true; },
    });

    let result: string | null;
    try {
      result = spawnOrchestratorSession();
    } finally {
      _setTmuxDepsForTesting(null);
    }

    // If spawn hardcodes 'orch1' the result will be 'orch1', not the sentinel → RED.
    assert.strictEqual(
      result,
      SENTINEL,
      `spawnOrchestratorSession() returned '${result}' instead of sentinel '${SENTINEL}' — ` +
        'spawn path is not routing through resolveSession (todo #81 regression)',
    );

    // The "already running" check must also have received the sentinel.
    assert.ok(
      seenSessions.includes(SENTINEL),
      `sessionExists was called with sessions ${JSON.stringify(seenSessions)} — sentinel '${SENTINEL}' not found — ` +
        '"already running" check is not routing through resolveSession (todo #81 regression)',
    );
  });

  test('injectMessage passes the resolveSession result to sessionExists, not hardcoded orch1', () => {
    let seenSession: string | undefined;

    // Temporarily allow injectMessage to proceed past the test-runner guard so we can
    // observe which session name it resolves to.  sessionExists returns false to prevent
    // any real tmux send-keys from firing.
    const savedSuppress = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';

    _setTmuxDepsForTesting({
      resolveSession: (id) => (id === 'orchestrator' ? SENTINEL : null),
      sessionExists: (s) => { seenSession = s; return false; }, // capture name; block send-keys
      isOrchAlive: () => false, // suppress R2 warn→debug log noise
    });

    try {
      _resetInjectionAttempts();
      injectMessage('orchestrator', 'regression-probe');
    } finally {
      // Restore env vars before any assertion that might throw
      if (savedSuppress !== undefined) {
        process.env.KITHKIT_SUPPRESS_NOTIFICATIONS = savedSuppress;
      } else {
        delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
      }
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
      _setTmuxDepsForTesting(null);
    }

    // If injectMessage hardcodes 'orch1' the captured value will be 'orch1' → RED.
    assert.strictEqual(
      seenSession,
      SENTINEL,
      `injectMessage passed '${seenSession}' to sessionExists instead of sentinel '${SENTINEL}' — ` +
        'deliver path is not routing through resolveSession (todo #81 regression)',
    );
  });
});
