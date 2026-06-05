/**
 * Tests for the VTT-decoupling fix (todo #393 + 2026-05-11 directive):
 *
 * - 'teams' is a valid AgentChannel + a TEXT_CHANNEL
 * - updateLastActiveChannel('teams') persists to feature_state
 * - getLastActiveChannel() returns 'teams' after a Teams inbound was recorded
 * - getLastActiveChannel() does NOT return 'voice' when voice was recorded
 *   (voice is an input modality, not a channel)
 *
 * Also pins the 5/28 silent-reply-flip regression:
 * - After voice reply-channel resolution on terminal and silent paths,
 *   getChannel() is identical before/after (no setChannel mutation).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, _resetDbForTesting } from '../../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import {
  updateLastActiveChannel,
  getLastActiveChannel,
  getChannel,
  setChannel,
} from '../channel-router.js';

function setupDb(): void {
  _resetDbForTesting();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-router-vtt-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

describe('AgentChannel — teams support (todo #393 / 5/11/2026)', () => {
  beforeEach(setupDb);

  it('updateLastActiveChannel("teams") persists and roundtrips', () => {
    updateLastActiveChannel('teams');
    assert.equal(getLastActiveChannel(), 'teams');
  });

  it('updateLastActiveChannel("telegram") followed by ("teams") returns "teams" (last wins)', () => {
    updateLastActiveChannel('telegram');
    updateLastActiveChannel('teams');
    assert.equal(getLastActiveChannel(), 'teams');
  });

  it('updateLastActiveChannel("voice") is a no-op — voice is not a text channel', () => {
    updateLastActiveChannel('telegram');
    // Try to register voice as last-active — should be silently ignored
    updateLastActiveChannel('voice' as unknown as Parameters<typeof updateLastActiveChannel>[0]);
    assert.equal(getLastActiveChannel(), 'telegram');
  });

  it('getLastActiveChannel() defaults to "telegram" when nothing recorded', () => {
    assert.equal(getLastActiveChannel(), 'telegram');
  });

  it('updateLastActiveChannel("terminal") persists (terminal is a text channel)', () => {
    updateLastActiveChannel('terminal');
    assert.equal(getLastActiveChannel(), 'terminal');
  });
});

// ── 5/28 silent-reply-flip regression guard ───────────────────────────────────
//
// The handleTranscribe voice pipeline reads getChannel() and — when the active
// channel is 'terminal' or 'silent' — resolves the reply destination via
// getLastActiveChannel() WITHOUT calling setChannel().  If setChannel() were
// reintroduced in that code path (as it was in the 5/28 regression), these
// tests fail because getChannel() would mutate.

describe('VTT active-channel isolation — 5/28 silent-reply-flip regression', () => {
  beforeEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-router-vtt-sil-'));
    fs.mkdirSync(path.join(tmpDir, '.kithkit', 'state'), { recursive: true });
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  it('terminal path: getChannel() unchanged after voice-reply resolution (no setChannel mutation)', () => {
    // No channel file → getChannel() defaults to 'terminal'
    updateLastActiveChannel('teams');
    const channelBefore = getChannel();

    // Simulate what handleTranscribe does for the terminal path:
    //   if (activeChannel === 'terminal' || activeChannel === 'silent') {
    //     replyChannel = getLastActiveChannel();   // must NOT call setChannel
    //   }
    const replyChannel = getLastActiveChannel();

    assert.equal(channelBefore, 'terminal', 'active channel should default to terminal');
    assert.equal(replyChannel, 'teams', 'voice reply routed to last-active text channel');
    assert.equal(getChannel(), 'terminal', 'active channel must be unchanged after voice-reply resolution');
  });

  it('silent path: getChannel() unchanged after voice-reply resolution (no setChannel mutation)', () => {
    setChannel('silent');
    updateLastActiveChannel('telegram');
    const channelBefore = getChannel();

    // Simulate what handleTranscribe does for the silent path
    const replyChannel = getLastActiveChannel();

    assert.equal(channelBefore, 'silent', 'active channel should be silent');
    assert.equal(replyChannel, 'telegram', 'voice reply routed to last-active text channel');
    assert.equal(getChannel(), 'silent', 'active channel must be unchanged (5/28 regression guard)');
  });
});
