/**
 * Tests for the VTT-decoupling fix (todo #393 + 2026-05-11 directive):
 *
 * - 'teams' is a valid AgentChannel + a TEXT_CHANNEL
 * - updateLastActiveChannel('teams') persists to feature_state
 * - getLastActiveChannel() returns 'teams' after a Teams inbound was recorded
 * - getLastActiveChannel() does NOT return 'voice' when voice was recorded
 *   (voice is an input modality, not a channel)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, _resetDbForTesting } from '../../../core/db.js';
import {
  updateLastActiveChannel,
  getLastActiveChannel,
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
