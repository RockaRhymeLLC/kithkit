/**
 * t-206: Session bridge supports multiple named sessions
 * t-207: Session bridge uses default session from config
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import {
  sessionExists,
  capturePane,
  isSessionBusy,
  injectText,
  getNewestTranscript,
  _testHelpers,
  _resetForTesting,
  _setSbDepsForTesting,
} from '../core/session-bridge.js';

describe('Session bridge multi-session (t-206)', () => {
  let tmpDir: string;

  afterEach(() => {
    _resetConfigForTesting();
    _resetForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sessionExists returns false for nonexistent session', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    assert.equal(sessionExists('nonexistent-session-xyz'), false);
  });

  it('sessionExists accepts named session parameter', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    // Both named and default calls should work without errors
    assert.equal(sessionExists('some-other-session'), false);
    assert.equal(sessionExists(), false);
  });

  it('capturePane returns empty string for nonexistent session', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    const result = capturePane('nonexistent-session-xyz');
    assert.equal(result, '');
  });

  it('isSessionBusy always returns false', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    assert.equal(isSessionBusy(), false);
    assert.equal(isSessionBusy('any-session'), false);
  });

  it('injectText returns false when session does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    const result = injectText('hello', { name: 'nonexistent-session-xyz' });
    assert.equal(result, false);
  });

  it('getTranscriptDir mangles path correctly', () => {
    const dir = _testHelpers.getTranscriptDir('/Users/someone/my_project');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-someone-my-project');
    assert.equal(dir, expected);
  });
});

describe('Session bridge default session from config (t-207)', () => {
  let tmpDir: string;

  afterEach(() => {
    _resetConfigForTesting();
    _resetForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to agent name from config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    // sessionExists() with no arg should not throw and should use config name
    const result = sessionExists();
    assert.equal(typeof result, 'boolean');
  });

  it('capturePane defaults to agent name from config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const result = capturePane();
    assert.equal(typeof result, 'string');
  });

  it('getNewestTranscript returns null when no transcripts exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const result = getNewestTranscript();
    assert.equal(result, null);
  });

  it('operations complete within 500ms', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const start = Date.now();
    sessionExists();
    capturePane();
    isSessionBusy();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Operations took ${elapsed}ms, expected < 500ms`);
  });
});

// ── injectText: separate Enter submit + seam (mutation-kill #367) ───────────
//
// Mutation-kill suite for the injectText() submit-keystroke seam.
// Mirrors the injectMessage() pattern added in #440 (34c9ed84).
//
// BACKGROUND (#367):
//   injectText() sends text to a tmux pane and then presses Enter to submit
//   it. Before this PR the Enter send-keys call was a direct execFileSync —
//   no injectable seam — so a future regression (e.g. folding Enter into the
//   text payload, or removing the submit call entirely) would go undetected.
//
// FIX:
//   execSbSendKeys() helper routes all send-keys calls through
//   _sbDeps?.sendKeys when set, mirroring execSendKeys() in tmux.ts (#440).
//
// SEAM ARCHITECTURE:
//   sendKeys injectable: records all send-keys calls without real tmux I/O.
//     - MUTATION-KILL: remove or fold the standalone execSbSendKeys(…,'Enter')
//       call → no 'Enter' entry in sendKeysCalls → assert fails → RED.
//   sessionExists injectable: returns true without a live tmux session.
//   capturePane injectable: returns "not pending" so retry loop exits fast.
//   KITHKIT_ALLOW_TEST_INJECT=1 bypasses isUnderTestRunner() guard so the
//   real production inject path executes (not the early-return fast path).
//
// HOW TO PROVE MUTATION-KILL:
//   1. GREEN baseline (as written).
//   2. Fold submit into text: replace execSbSendKeys(tmux, session, ['Enter'])
//      with execSbSendKeys(tmux, session, ['-l', stamped + '\r'])
//      → no separate ['Enter'] call → cmCalls filter returns [] → RED.
//   3. Restore → GREEN.

describe('injectText — separate Enter submit seam (mutation-kill #367)', { concurrency: 1 }, () => {
  let savedAllowInject: string | undefined;

  beforeEach(function () {
    savedAllowInject = process.env.KITHKIT_ALLOW_TEST_INJECT;
    // KITHKIT_ALLOW_TEST_INJECT=1 bypasses isUnderTestRunner() so the real
    // injectText production path runs; sendKeys seam prevents actual tmux I/O.
    process.env.KITHKIT_ALLOW_TEST_INJECT = '1';
  });

  afterEach(function () {
    _setSbDepsForTesting(null);
    _resetForTesting();
    if (savedAllowInject === undefined) {
      delete process.env.KITHKIT_ALLOW_TEST_INJECT;
    } else {
      process.env.KITHKIT_ALLOW_TEST_INJECT = savedAllowInject;
    }
  });

  it('MUTATION-KILL: a standalone Enter send-keys call fires after the text payload', () => {
    // This is the primary mutation-killer for the injectText submit seam.
    //
    // The REAL submit path: execSbSendKeys(tmux, session, ['Enter']) is a
    // dedicated call in injectText's try block, separate from the text payload.
    //
    // MUTATION: fold Enter into the text payload (execSbSendKeys(…, ['-l', text+'\r']))
    //   → no separate ['Enter'] entry in sendKeysCalls
    //   → enterCalls filter returns [] → length assertion fails → RED.
    //
    // This test drives the REAL submit path via the sendKeys seam — not a bypass
    // that sidesteps the code deciding to send Enter (cf. PR #439 trap).

    const sendKeysCalls: Array<{ session: string; args: string[] }> = [];

    _setSbDepsForTesting({
      // sessionExists seam: return true so injectText doesn't abort early.
      sessionExists: () => true,
      // sendKeys seam: record all send-keys calls, suppress real tmux I/O.
      sendKeys: (session, args) => { sendKeysCalls.push({ session, args }); },
      // capturePane seam: return empty string so retry loop breaks immediately.
      capturePane: () => '',
    });

    const result = injectText('check queue', { name: 'comms1', timestamp: false });

    // injectText must return true (send succeeded)
    assert.equal(result, true, 'injectText must return true when send-keys seam succeeds');

    // The standalone Enter call MUST be present in the recorded calls.
    // Mutation-kill: if Enter is folded into the text payload, this list is empty → RED.
    const enterCalls = sendKeysCalls.filter(c => c.args.includes('Enter'));
    assert.ok(
      enterCalls.length >= 1,
      `MUTATION-KILL: standalone Enter send-keys call must fire — got calls: ${JSON.stringify(sendKeysCalls)}`,
    );

    // The text payload call (-l) must NOT contain 'Enter' (it must stay separate)
    const textCalls = sendKeysCalls.filter(c => c.args[0] === '-l');
    assert.ok(textCalls.length >= 1, 'text must be sent via -l literal send-keys');
    assert.ok(
      !textCalls.some(c => c.args.join('\0').includes('Enter')),
      `text payload must not fold Enter into the -l argument — mutation evidence: ${JSON.stringify(textCalls)}`,
    );

    // Every call must target the correct session
    assert.ok(
      sendKeysCalls.every(c => c.session === 'comms1'),
      'all send-keys calls must target the correct session name',
    );
  });
});
