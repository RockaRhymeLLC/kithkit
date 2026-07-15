/**
 * Mutation-kill regression tests for injectText()'s bracketed-paste delivery
 * (sync sibling of agents/tmux.ts's execPasteBuffer()).
 *
 * INCIDENT: session-bridge.ts's injectText() is the low-level chokepoint used
 * by external-channel adapters and automation tasks to deliver inbound
 * human/peer text into a tmux pane. The old implementation sent the payload
 * as literal keystrokes (`send-keys -l <payload>`), then a *separate*
 * `send-keys Enter` call after a short sleep. A literal '@' character in the
 * payload (e.g. "remind me @8pm") can pop the receiving TUI's file-autocomplete
 * inside the pane; the subsequent Enter then ACCEPTS the popup's fuzzy-matched
 * local file instead of submitting the message, and the harness auto-reads
 * that file. Peer-controlled text should never be able to trigger a local
 * file read.
 *
 * FIX: deliver the text payload via tmux bracketed paste (`load-buffer -` +
 * `paste-buffer -d -p`) instead of literal send-keys. Bracketed paste wraps
 * the insert in escape sequences that suppress the receiving TUI's live
 * interpretation of '@'/'/' triggers. The submit keystroke (Enter) remains a
 * separate, unchanged send-keys call — no popup can be open after a paste.
 *
 * These tests MUST fail if payload delivery is reverted to
 * `execSbSendKeys(tmux, session, ['-l', payload])`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  injectText,
  _resetForTesting,
  _setSbDepsForTesting,
} from '../session-bridge.js';

describe('injectText — bracketed paste delivery (mutation-kill)', () => {
  let savedAllowInject: string | undefined;

  beforeEach(() => {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
  });

  afterEach(() => {
    _resetForTesting();
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
  });

  for (const sample of ['@8am.', 'remind me @8pm please', '@path-like/string.png']) {
    it(`delivers '${sample}' VERBATIM via the paste-buffer seam, not via '-l' send-keys`, () => {
      const sendKeysCalls: Array<{ session: string; args: string[] }> = [];
      const pasteBufferCalls: Array<{ session: string; text: string }> = [];

      _setSbDepsForTesting({
        sessionExists: () => true,
        sendKeys: (session, args) => { sendKeysCalls.push({ session, args }); },
        pasteBuffer: (session, text) => { pasteBufferCalls.push({ session, text }); },
      });

      const result = injectText(sample, { name: 'comms1', timestamp: false });
      assert.equal(result, true);

      // Exactly one pasteBuffer call. The sample carries an invisible U+200B
      // ZWSP after any '@' that could resolve as a file mention. Stripping
      // ZWSP must restore the sample verbatim — display is unchanged.
      assert.equal(
        pasteBufferCalls.length, 1,
        `expected exactly one pasteBuffer call — got: ${JSON.stringify(pasteBufferCalls)}`,
      );
      assert.equal(pasteBufferCalls[0]!.text.replace(/​/g, ''), sample);
      assert.equal(pasteBufferCalls[0]!.session, 'comms1');

      // MUTATION-KILL: no '-l' send-keys call may carry the payload — that
      // was the vulnerable path (live keystrokes -> @-autocomplete popup).
      const literalTextCalls = sendKeysCalls.filter(c => c.args[0] === '-l');
      assert.equal(
        literalTextCalls.length, 0,
        `MUTATION-KILL: '-l' send-keys must NOT be used for the text payload — got: ${JSON.stringify(literalTextCalls)}`,
      );
      assert.ok(
        !sendKeysCalls.some(c => c.args.some(a => a.includes(sample))),
        `the '@'-bearing sample text must never appear in a send-keys call — got: ${JSON.stringify(sendKeysCalls)}`,
      );
    });
  }

  it('never calls pasteBuffer when the session does not exist', () => {
    const pasteBufferCalls: Array<{ session: string; text: string }> = [];
    _setSbDepsForTesting({
      sessionExists: () => false,
      sendKeys: () => {},
      pasteBuffer: (session, text) => { pasteBufferCalls.push({ session, text }); },
    });

    const result = injectText('@8am.', { name: 'nonexistent-session-xyz' });
    assert.equal(result, false);
    assert.equal(pasteBufferCalls.length, 0, 'must not paste into a session that does not exist');
  });

  it('MUTATION-KILL: strips an embedded bracketed-paste terminator (ESC[201~) before it reaches pasteBuffer', () => {
    // Bracketed paste is only safe if the payload cannot embed the paste
    // terminator ESC[201~ — an embedded terminator ends paste mode early and
    // subsequent bytes go LIVE to the TUI (including '/'-commands), re-opening
    // the keystroke-injection exploit class this fix was meant to close.
    const pasteBufferCalls: Array<{ session: string; text: string }> = [];

    _setSbDepsForTesting({
      sessionExists: () => true,
      sendKeys: () => {},
      pasteBuffer: (session, text) => { pasteBufferCalls.push({ session, text }); },
    });

    const malicious = 'hello \x1b[201~/quit rest';
    const result = injectText(malicious, { name: 'comms1', timestamp: false });
    assert.equal(result, true);

    assert.equal(pasteBufferCalls.length, 1);
    const delivered = pasteBufferCalls[0]!.text;

    // No ESC byte anywhere — makes the ESC[201~ terminator unrepresentable.
    assert.ok(
      !delivered.includes('\x1b'),
      `MUTATION-KILL: delivered payload must contain no ESC byte — got: ${JSON.stringify(delivered)}`,
    );
    // The terminator sequence (as an ESC-prefixed escape) cannot survive intact.
    assert.ok(
      !delivered.includes('\x1b[201~'),
      `MUTATION-KILL: bracketed-paste terminator must not survive intact — got: ${JSON.stringify(delivered)}`,
    );
    // The rest of the payload content is preserved (only the ESC byte is stripped).
    assert.ok(delivered.includes('hello'));
    assert.ok(delivered.includes('/quit rest'));
  });

  it('MUTATION-KILL: returns false and never calls pasteBuffer when text is entirely ESC/C0 control bytes', () => {
    const pasteBufferCalls: Array<{ session: string; text: string }> = [];

    _setSbDepsForTesting({
      sessionExists: () => true,
      sendKeys: () => {},
      pasteBuffer: (session, text) => { pasteBufferCalls.push({ session, text }); },
    });

    const result = injectText('\x01\x02\x1b[31m\x1b[0m\x7f', { name: 'comms1', timestamp: false });
    assert.equal(result, false, 'text that sanitizes to empty must short-circuit before pasteBuffer');
    assert.equal(pasteBufferCalls.length, 0);
  });
});

/**
 * @-mention ZWSP neutralization.
 *
 * RESIDUAL: bracketed paste closes the typing-time fuzzy-autocomplete popup
 * vector, but the receiving TUI separately resolves @-mentions in the
 * SUBMITTED buffer text — a peer-controlled '@'-prefixed path to a real file
 * (relative, absolute, ../traversal, or config-style) still auto-reads that
 * file at submit time. A filesystem-existence-check gate was rejected:
 * TOCTOU (the file may not exist at sanitize-time but resolve at
 * submit-time), cwd divergence between the sanitizer and the harness's
 * resolution, and absolute/traversal/symlink/tilde forms dodge the probe.
 * FIX: insert U+200B (ZERO WIDTH SPACE) immediately after any '@' followed
 * by a non-whitespace, non-'@' character — defeats @-mention resolution
 * while rendering identically (invisible). Mirrors the identical test matrix
 * in __tests__/tmux.test.ts for the tmux.ts chokepoint.
 */
describe('injectText — @-mention ZWSP neutralization (mutation-kill)', () => {
  let savedAllowInject: string | undefined;

  beforeEach(() => {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
  });

  afterEach(() => {
    _resetForTesting();
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
  });

  function deliverAndCapture(text: string): string {
    const pasteBufferCalls: Array<{ session: string; text: string }> = [];
    _setSbDepsForTesting({
      sessionExists: () => true,
      sendKeys: () => {},
      pasteBuffer: (session, t) => { pasteBufferCalls.push({ session, text: t }); },
    });
    const result = injectText(text, { name: 'comms1', timestamp: false });
    assert.equal(result, true, `injectText must succeed for input: ${JSON.stringify(text)}`);
    assert.equal(
      pasteBufferCalls.length, 1,
      `expected exactly one pasteBuffer call for: ${JSON.stringify(text)}`,
    );
    return pasteBufferCalls[0]!.text;
  }

  // (a) Path forms neutralized: bare '@'+path must never reach the paste
  // seam; a ZWSP must sit between '@' and the path; stripping ZWSP restores
  // the original visible token.
  for (const pathForm of ['@README.md', '@/etc/passwd', '@../secrets.txt', '@config/settings.yaml']) {
    it(`neutralizes path-form mention '${pathForm}' — ZWSP inserted, bare form absent from the delivered payload`, () => {
      const delivered = deliverAndCapture(pathForm);

      assert.ok(
        !delivered.includes(pathForm),
        `MUTATION-KILL: delivered text must NOT contain the bare '@'-path substring — got: ${JSON.stringify(delivered)}`,
      );
      assert.ok(
        delivered.includes(`@​${pathForm.slice(1)}`),
        `delivered text must contain '@' + ZWSP + the path — got: ${JSON.stringify(delivered)}`,
      );
      assert.ok(
        delivered.replace(/​/g, '').endsWith(pathForm),
        `stripping ZWSP must restore the original visible token — got: ${JSON.stringify(delivered)}`,
      );
    });
  }

  // (b) Display-preservation: over-neutralizing non-path '@'-forms is
  // harmless because ZWSP is invisible — stripped delivered text must equal
  // the original input with no visible change.
  for (const displayForm of ['remind me @8pm', 'ping @somebody please', 'email me at user@example.com']) {
    it(`preserves visible display for '${displayForm}' once ZWSP is stripped`, () => {
      const delivered = deliverAndCapture(displayForm);
      const withoutZwsp = delivered.replace(/​/g, '');
      assert.ok(
        withoutZwsp.endsWith(displayForm),
        `ZWSP-stripped delivered text must end with the original input (no visible change) — got: ${JSON.stringify(delivered)}`,
      );
    });
  }
});
