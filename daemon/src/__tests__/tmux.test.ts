/**
 * Tests for tmux.ts — session name helpers.
 *
 * The buildOrchestratorWrapperScript function was removed in the v2 orchestrator
 * cutover (replaced by --agent orchestrator). These tests cover the remaining
 * pure logic portions of the module.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _getCommsSession,
  _getOrchestratorSession,
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
