/**
 * Tests for tmux.ts — orchestrator session model and state detection.
 *
 * These tests exercise the pure logic portions of the tmux module:
 *  - Session name helpers: _getCommsSession, _getOrchestratorSession
 *  - buildOrchestratorWrapperScript: now deprecated/throws — tested for that behavior
 *
 * Real tmux/session operations are NOT tested here (they require a live tmux
 * socket). Integration tests for those live in the manual test runbook.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrchestratorWrapperScript,
  _getCommsSession,
  _getOrchestratorSession,
} from '../agents/tmux.js';

// ── buildOrchestratorWrapperScript (deprecated) ──────────────

describe('buildOrchestratorWrapperScript — deprecated', () => {
  it('throws an error since it is deprecated in the new restart loop model', () => {
    assert.throws(
      () => buildOrchestratorWrapperScript('/usr/bin/claude', 'Do something'),
      /deprecated/i,
      'should throw with a deprecation message',
    );
  });

  it('throws even with custom daemon port', () => {
    assert.throws(
      () => buildOrchestratorWrapperScript('/usr/bin/claude', 'Task', 9999),
      Error,
    );
  });
});

// ── Session name helpers ──────────────────────────────────────

describe('Session name helpers', () => {
  it('_getCommsSession returns the generic comms session name', () => {
    assert.equal(_getCommsSession(), 'comms1');
  });

  it('_getOrchestratorSession returns the generic orchestrator session name', () => {
    assert.equal(_getOrchestratorSession(), 'orch1');
  });
});
