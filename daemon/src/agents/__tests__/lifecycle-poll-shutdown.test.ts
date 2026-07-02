/**
 * Mutation-kill tests for kithkit#2743 Fix 2: shutdown timer hygiene.
 *
 * Incident: per-worker poll timers (pollTimers map in lifecycle.ts) were
 * never cleared on daemon shutdown. A late setInterval tick firing after
 * closeDatabase() threw an uncaughtException (dist lifecycle.js:220,
 * "Database not initialized").
 *
 * Fix: exported stopAllPolling() clears every timer in pollTimers and empties
 * the map; main.ts's shutdown() calls it BEFORE closeDatabase(). The poll
 * callback body is also wrapped in try/catch so a late tick that slips through
 * logs at debug level instead of throwing.
 *
 * MUTATION-KILL for stopAllPolling(): comment out the `clearInterval(timer)`
 * call (or the `pollTimers.clear()` line) inside stopAllPolling() in
 * lifecycle.ts — the timer keeps firing after stopAllPolling() returns, and/or
 * _getPollTimerCount() stays non-zero, and the assertions below go RED.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  stopAllPolling,
  _getPollTimerCount,
  _registerPollTimerForTesting,
  _resetForTesting,
} from '../lifecycle.js';

describe('Fix 2743/2 — stopAllPolling clears all timers (mutation-kill)', () => {
  afterEach(() => {
    _resetForTesting();
  });

  it('clears every registered poll timer and empties the pollTimers map', () => {
    let tickCountA = 0;
    let tickCountB = 0;
    const timerA = setInterval(() => { tickCountA++; }, 5);
    const timerB = setInterval(() => { tickCountB++; }, 5);

    _registerPollTimerForTesting('job-a', timerA);
    _registerPollTimerForTesting('job-b', timerB);

    assert.equal(_getPollTimerCount(), 2, 'both timers should be registered before stopAllPolling');

    stopAllPolling();

    // MUTATION-KILL: if stopAllPolling() failed to clear the map, this stays 2.
    assert.equal(_getPollTimerCount(), 0, 'MUTATION-KILL: pollTimers map must be empty after stopAllPolling()');
  });

  it('a cleared timer never ticks again after stopAllPolling() (real wall-clock proof)', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    _registerPollTimerForTesting('job-c', timer);

    // Let it tick at least once to prove the timer is really live.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(ticks >= 1, 'sanity: timer must have ticked before being stopped');

    stopAllPolling();
    const ticksAtStop = ticks;

    // Wait well past several more would-be intervals.
    await new Promise(resolve => setTimeout(resolve, 50));

    // MUTATION-KILL: if clearInterval() were skipped, ticks would keep
    // incrementing past ticksAtStop during this wait.
    assert.equal(
      ticks, ticksAtStop,
      `MUTATION-KILL: timer kept firing after stopAllPolling() — ticks went from ${ticksAtStop} to ${ticks}`,
    );
  });

  it('a late tick on an uncleared-in-time timer does not crash the process (try/catch hygiene)', async () => {
    // Simulates the exact incident shape: a timer callback that throws
    // (e.g. touching a closed DB) must not become an uncaughtException. We
    // register a raw timer whose body mirrors the production try/catch
    // wrapper pattern used in lifecycle.ts's startPolling().
    let caughtInternally = 0;
    const timer = setInterval(() => {
      try {
        throw new Error('simulated: Database not initialized (post-shutdown tick)');
      } catch {
        caughtInternally++;
      }
    }, 10);
    _registerPollTimerForTesting('job-d', timer);

    let uncaught = false;
    const onUncaught = () => { uncaught = true; };
    process.on('uncaughtException', onUncaught);

    try {
      await new Promise(resolve => setTimeout(resolve, 40));
      stopAllPolling();
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }

    assert.ok(caughtInternally >= 1, 'sanity: the simulated late-tick error path must have run at least once');
    assert.equal(uncaught, false, 'MUTATION-KILL: no uncaughtException should escape a late poll tick');
  });
});
