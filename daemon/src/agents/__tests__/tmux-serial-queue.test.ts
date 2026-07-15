/**
 * Mutation-kill tests for kithkit#2743 Fix 1: async tmux injection.
 *
 * 1. Per-session serial queue — concurrent injectMessage() calls to the SAME
 *    session must never interleave their send-keys syscalls (FIFO, one at a
 *    time). Two interleaved send-keys sequences to one pane can corrupt the
 *    input (e.g. session A's C-m submit landing between session A message 2's
 *    text keystrokes).
 * 2. Event-loop responsiveness — injectMessage() must not block the event
 *    loop. The OLD implementation used execFileSync + execFileSync('/bin/
 *    sleep', ...) in a loop, blocking the thread for 3-6s per message. The
 *    NEW implementation is fully async (promisified execFile + timers/
 *    promises setTimeout), so a timer ticking every few ms must keep firing
 *    while an injection is in flight.
 *
 * MUTATION-KILL for (1): comment out the `enqueueForSession(...)` wrapper in
 * tmux.ts's injectMessage() (call injectMessageToSession() directly) — the
 * two concurrent calls race, their sendKeys calls interleave, and the
 * "no interleaving" assertion below goes RED. Restoring the wrapper makes it
 * GREEN again. (Verified manually during development; the queue call is the
 * single line `return enqueueForSession(session, () => injectMessageToSession(...))`.)
 *
 * MUTATION-KILL for (2): reintroduce a synchronous blocking call (e.g.
 * `execFileSync('/bin/sleep', ['0.2'])`) anywhere in the injection hot path —
 * the background tick counter stops incrementing during that window, and the
 * "ticks kept advancing" assertion goes RED.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { injectMessage, _setTmuxDepsForTesting, _resetInjectionAttempts } from '../tmux.js';

describe('Fix 2743/1 — per-session serial queue (mutation-kill)', () => {
  let savedAllowInject: string | undefined;
  let savedSuppress: string | undefined;

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

  it('two concurrent injectMessage() calls to the SAME session never interleave their send-keys calls', async () => {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    savedSuppress = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    _resetInjectionAttempts();

    type Call = { kind: 'capture' | 'send'; text: string };
    const calls: Call[] = [];
    // Separate delivery-channel logs so we can bind the FIFO ordering to the
    // ACTUAL seam the payload arrived through, not just "some 'send' entry
    // containing the text" — see the delivery-channel assertions below.
    const pasteBufferCalls: { session: string; text: string }[] = [];
    const sendKeysCalls: { session: string; args: string[] }[] = [];

    _setTmuxDepsForTesting({
      resolveSession: () => 'shared-session',
      sessionExists: () => true,
      isOrchAlive: () => true,
      // Every capture-pane and send-keys call is logged in strict call order.
      // Because both messages target the same resolved session, if the serial
      // queue failed to serialize them, calls from msg-2 could appear between
      // msg-1's -l text call and its C-m submit call.
      capturePane: () => {
        calls.push({ kind: 'capture', text: '' });
        // #497: verifySubmitLanded now requires a parseable EMPTY input box
        // (a live `❯ ` row immediately followed by a bare border line, with
        // a "Context:" footer within the next few lines) rather than any
        // pane change. Return that shape so findCurrentInputLine() resolves
        // to '' immediately and verifySubmitLanded returns true fast — no
        // retries — keeping the interleave window realistic.
        return '❯ \n────────────────────────────────────────\n  [Sonnet 4.5] Context: 50% used\n  ⏵⏵ bypass permissions on · 1 shell · ← for agents';
      },
      // Text payload now goes through the paste-buffer seam (bracketed
      // paste), not '-l' send-keys. Record it as a 'send' entry (labeled
      // with a '-l'-style marker) so the FIFO / no-interleaving assertions
      // below, which key off calls containing 'MSG-ONE'/'MSG-TWO', still see
      // the payload delivery event in the shared call-order timeline.
      // Without this seam, the paste-buffer call falls through to real tmux I/O.
      pasteBuffer: (session, text) => {
        calls.push({ kind: 'send', text: `-l ${text}` });
        pasteBufferCalls.push({ session, text });
      },
      sendKeys: (session, args) => {
        calls.push({ kind: 'send', text: args.join(' ') });
        sendKeysCalls.push({ session, args });
      },
    });

    // Fire both WITHOUT awaiting the first — if the serial queue is bypassed,
    // their internal awaits (capture, sendKeys) will race and interleave.
    const p1 = injectMessage('orchestrator', 'MSG-ONE');
    const p2 = injectMessage('orchestrator', 'MSG-TWO');
    const [r1, r2] = await Promise.all([p1, p2]);

    assert.equal(r1, true, 'first injection should succeed');
    assert.equal(r2, true, 'second injection should succeed');

    // Locate the index range spanned by each message's -l text call through
    // its own C-m submit call, and assert no OTHER message's calls fall inside.
    const msg1Start = calls.findIndex(c => c.kind === 'send' && c.text.includes('MSG-ONE'));
    const msg2Start = calls.findIndex(c => c.kind === 'send' && c.text.includes('MSG-TWO'));
    assert.ok(msg1Start >= 0 && msg2Start >= 0, 'both messages must have sent their text payload');

    // FIFO: since injectMessage('orchestrator', ...) is called synchronously
    // for msg-1 before msg-2 (both queue-enqueue calls happen in the same
    // synchronous tick, in call order), msg-1 must be fully processed first.
    assert.ok(
      msg1Start < msg2Start,
      `MUTATION-KILL: expected msg-1's text payload to be sent before msg-2's (FIFO), got order: ${JSON.stringify(calls)}`,
    );

    // No interleaving: every call between msg-1's -l text call and the next
    // occurrence of a "C-m" call for msg-1 must belong to msg-1's own session
    // work, not msg-2's.
    const msg1CmIdx = calls.findIndex((c, i) => i > msg1Start && c.kind === 'send' && c.text.includes('C-m'));
    assert.ok(msg1CmIdx > msg1Start, 'msg-1 must have a C-m submit call after its text payload');
    assert.ok(
      msg2Start > msg1CmIdx,
      `MUTATION-KILL: msg-2's send-keys call must not start until msg-1's full sequence ` +
        `(text + C-m) has completed — got msg1Start=${msg1Start}, msg1CmIdx=${msg1CmIdx}, msg2Start=${msg2Start}, calls: ${JSON.stringify(calls)}`,
    );

    // Delivery-channel binding: the above assertions only look at the shared
    // `calls` timeline, which both the pasteBuffer and sendKeys seam stubs
    // feed into — so they'd stay green even if payload delivery reverted from
    // bracketed paste back to literal '-l' send-keys. Pin the payload to the
    // ACTUAL seam it must travel through.
    assert.ok(
      pasteBufferCalls.some(c => c.text.includes('MSG-ONE')),
      `MUTATION-KILL: MSG-ONE payload must be delivered via the pasteBuffer (bracketed paste) seam, ` +
        `got pasteBufferCalls: ${JSON.stringify(pasteBufferCalls)}`,
    );
    assert.ok(
      pasteBufferCalls.some(c => c.text.includes('MSG-TWO')),
      `MUTATION-KILL: MSG-TWO payload must be delivered via the pasteBuffer (bracketed paste) seam, ` +
        `got pasteBufferCalls: ${JSON.stringify(pasteBufferCalls)}`,
    );
    assert.ok(
      !sendKeysCalls.some(c => c.args.some(a => a.includes('MSG-ONE') || a.includes('MSG-TWO'))),
      `MUTATION-KILL: payload text must never be carried by a send-keys call (only the separate ` +
        `C-m submit may be), got sendKeysCalls: ${JSON.stringify(sendKeysCalls)}`,
    );
  });

  it('injectMessage() does not block the Node event loop (async I/O, no sync sleep)', async () => {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    savedSuppress = process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
    delete process.env.KITHKIT_SUPPRESS_NOTIFICATIONS;
    _resetInjectionAttempts();

    // Force the real readiness-gate sleep path (no capturePane seam means the
    // `!_testingDeps?.capturePane` branches take their real `await sleep(...)`
    // delays), so the injection takes a non-trivial amount of wall-clock time
    // — enough to observe whether the event loop kept servicing other timers.
    let sessionExistsCalls = 0;
    // Record pasteBuffer invocations (still stubbed, no real tmux I/O) so we
    // can assert the probe payload actually reached the bracketed-paste seam
    // — not just that *something* returned without blocking the event loop.
    const pasteBufferCalls: { session: string; text: string }[] = [];
    _setTmuxDepsForTesting({
      resolveSession: () => 'orch1',
      sessionExists: () => { sessionExistsCalls++; return true; },
      isOrchAlive: () => true,
      sendKeys: () => { /* no-op, avoid real tmux I/O */ },
      // Without this seam, the paste-buffer call falls through to real tmux
      // I/O against the resolved session — avoid pasting the probe text into
      // a live pane during test runs. Record calls (still no real I/O) to
      // verify delivery below.
      pasteBuffer: (session, text) => { pasteBufferCalls.push({ session, text }); },
    });

    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 5);

    try {
      const start = Date.now();
      await injectMessage('orchestrator', 'event-loop-responsiveness-probe');
      const elapsedMs = Date.now() - start;

      // MUTATION-KILL: if injectMessage were reverted to synchronous
      // execFileSync-based sleeps, the ticker's setInterval callback (which
      // can only run when the event loop is free) would be starved for the
      // entire elapsed duration and `ticks` would be 0 (or far too low to
      // account for the wall-clock time that passed).
      const expectedMinTicks = Math.floor(elapsedMs / 5 / 4); // generous slack
      assert.ok(
        ticks >= Math.max(1, expectedMinTicks),
        `MUTATION-KILL: event loop appears blocked — only ${ticks} ticks fired ` +
          `during a ${elapsedMs}ms injectMessage() call (expected >= ${expectedMinTicks}). ` +
          'A synchronous sleep/exec in the injection path would starve the timer.',
      );
      assert.ok(sessionExistsCalls >= 1, 'sanity: session lookup seam should have been invoked');

      // MUTATION-KILL: the async/no-block assertion above stays green even if
      // payload delivery reverted to '-l' send-keys, since that path is also
      // async. Pin delivery to the bracketed-paste seam: the probe text must
      // have reached pasteBuffer.
      assert.ok(
        pasteBufferCalls.some(c => c.text.includes('event-loop-responsiveness-probe')),
        `MUTATION-KILL: probe payload must be delivered via the pasteBuffer (bracketed paste) seam, ` +
          `got pasteBufferCalls: ${JSON.stringify(pasteBufferCalls)}`,
      );
    } finally {
      clearInterval(ticker);
    }
  });
});
