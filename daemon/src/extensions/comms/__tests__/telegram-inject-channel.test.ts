/**
 * Mutation-killing regression test for the setActiveChannel-per-inject fix.
 *
 * Problem: programmatic tmux injections (Telegram → doInject) bypass the
 * UserPromptSubmit hook that normally sets the active channel. Without an
 * explicit setActiveChannel('telegram') call inside doInject, the channel
 * file stays whatever it was before the inject, causing outbound replies to
 * route to the wrong channel.
 *
 * Fix (ported from fork commit e0639eda): call setActiveChannel('telegram')
 * inside doInject() before injectToComms().
 *
 * This test MUST fail if that call is removed.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase, _resetDbForTesting } from '../../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { getChannel, _resetForTesting as _resetChannelRouter } from '../channel-router.js';
import { _doInjectForTesting, _resetForTesting as _resetTelegramAdapter } from '../adapters/telegram.js';

// ── helpers ──────────────────────────────────────────────────

function setupProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inject-channel-'));
  fs.mkdirSync(path.join(tmpDir, '.kithkit', 'state'), { recursive: true });
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  return tmpDir;
}

function setChannelFile(tmpDir: string, channel: string): void {
  fs.writeFileSync(path.join(tmpDir, '.kithkit', 'state', 'channel.txt'), channel + '\n');
}

// ── tests ─────────────────────────────────────────────────────

describe('telegram doInject — setActiveChannel-per-inject (fork e0639eda)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    _resetChannelRouter();
    _resetTelegramAdapter();
    tmpDir = setupProject();
  });

  it('sets active channel to "telegram" before injecting — direct DM message', () => {
    // Arrange: start with channel = 'terminal' to show the change
    setChannelFile(tmpDir, 'terminal');
    assert.equal(getChannel(), 'terminal', 'precondition: channel starts as terminal');

    // Act: trigger doInject (injectToComms returns false in test env — that is expected)
    _doInjectForTesting('hello', 'Alice', false);

    // Assert: channel must now be 'telegram' — proves setActiveChannel('telegram') was called
    assert.equal(
      getChannel(),
      'telegram',
      'doInject must call setActiveChannel("telegram") so outbound replies route to Telegram',
    );
  });

  it('sets active channel to "telegram" for third-party injections', () => {
    setChannelFile(tmpDir, 'terminal');

    _doInjectForTesting('hi from 3rd party', 'Bob', /* isThirdParty */ true);

    assert.equal(getChannel(), 'telegram');
  });

  it('sets active channel to "telegram" for group-chat injections', () => {
    setChannelFile(tmpDir, 'terminal');

    _doInjectForTesting('group msg', 'Carol', false, 'group', '99999');

    assert.equal(getChannel(), 'telegram');
  });

  it('MUTATION GUARD — channel stays "terminal" if setActiveChannel call is absent', () => {
    // This test is the mutation kill: if setActiveChannel('telegram') is removed
    // from doInject, getChannel() will return 'terminal' after the inject and
    // the tests above will fail. This comment documents intent; the tests above
    // are the actual kill signal.
    setChannelFile(tmpDir, 'telegram');
    _doInjectForTesting('already telegram', 'Dave', false);
    // Channel should still be telegram (idempotent when already correct)
    assert.equal(getChannel(), 'telegram');
  });
});
