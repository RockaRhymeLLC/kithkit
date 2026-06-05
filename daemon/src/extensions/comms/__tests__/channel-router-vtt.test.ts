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
import { resolveReplyChannel } from '../../voice/index.js';

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
// Tests call resolveReplyChannel() directly — not an inline re-implementation —
// so any reintroduction of setChannel() inside the function or its call site
// is caught immediately: getChannel() would change, failing the final assertion.

describe('resolveReplyChannel — 5/28 silent-reply-flip regression', () => {
  beforeEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-router-vtt-sil-'));
    fs.mkdirSync(path.join(tmpDir, '.kithkit', 'state'), { recursive: true });
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  it('terminal/silent: resolveReplyChannel returns last-active channel; getChannel() unchanged', () => {
    // terminal path — active channel defaults to 'terminal' (no channel file)
    updateLastActiveChannel('teams');
    const terminalBefore = getChannel();
    const terminalReply = resolveReplyChannel('terminal');
    assert.equal(terminalBefore, 'terminal', 'active channel should default to terminal');
    assert.equal(terminalReply, 'teams', 'terminal path resolves to last-active text channel');
    assert.equal(getChannel(), 'terminal', 'active channel file must be untouched after terminal resolution');

    // silent path
    setChannel('silent');
    updateLastActiveChannel('telegram');
    const silentBefore = getChannel();
    const silentReply = resolveReplyChannel('silent');
    assert.equal(silentBefore, 'silent', 'active channel should be silent');
    assert.equal(silentReply, 'telegram', 'silent path resolves to last-active text channel');
    assert.equal(getChannel(), 'silent', 'active channel file must be untouched after silent resolution (5/28 regression guard)');
  });

  it('telegram/teams: resolveReplyChannel passthrough; getChannel() unchanged', () => {
    // telegram path
    setChannel('telegram');
    const telegramBefore = getChannel();
    const telegramReply = resolveReplyChannel('telegram');
    assert.equal(telegramReply, 'telegram', 'telegram passthrough: activeChannel returned unchanged');
    assert.equal(getChannel(), telegramBefore, 'active channel file must be untouched after telegram passthrough');

    // teams path
    setChannel('teams');
    const teamsBefore = getChannel();
    const teamsReply = resolveReplyChannel('teams');
    assert.equal(teamsReply, 'teams', 'teams passthrough: activeChannel returned unchanged');
    assert.equal(getChannel(), teamsBefore, 'active channel file must be untouched after teams passthrough');
  });
});
