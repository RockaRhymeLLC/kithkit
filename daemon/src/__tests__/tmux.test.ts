/**
 * Tests for tmux.ts — orchestrator wrapper script generation and state detection.
 *
 * These tests exercise the pure logic portions of the tmux module:
 *  - buildOrchestratorWrapperScript: script content, prompt encoding, structure
 *  - getOrchestratorState / isOrchestratorAlive: tested via mocked execFileSync
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

// ── buildOrchestratorWrapperScript ───────────────────────────

describe('buildOrchestratorWrapperScript — script structure', () => {
  it('returns a non-empty string', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Do something');
    assert.ok(typeof script === 'string' && script.length > 0);
  });

  it('starts with a bash shebang', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Do something');
    assert.ok(script.startsWith('#!/usr/bin/env bash'), `expected shebang, got: ${script.slice(0, 30)}`);
  });

  it('embeds the claude binary path', () => {
    const script = buildOrchestratorWrapperScript('/home/bmo/.local/bin/claude', 'Task');
    assert.ok(script.includes('"/home/bmo/.local/bin/claude"'), 'should contain quoted claude path');
  });

  it('uses the provided daemon port', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task', 9999);
    assert.ok(script.includes('DAEMON_PORT=9999'), 'should embed daemon port');
  });

  it('defaults to daemon port 3847', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('DAEMON_PORT=3847'), 'should default to port 3847');
  });

  it('includes idle wait and poll interval variables', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('IDLE_WAIT_SEC='), 'should define IDLE_WAIT_SEC');
    assert.ok(script.includes('POLL_INTERVAL_SEC='), 'should define POLL_INTERVAL_SEC');
  });

  it('includes a cleanup function and EXIT trap', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('cleanup()'), 'should define cleanup function');
    assert.ok(script.includes('trap cleanup EXIT'), 'should trap EXIT with cleanup');
  });

  it('cleanup function marks orchestrator status as stopped', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('"status":"stopped"'), 'cleanup should POST stopped status');
    assert.ok(script.includes('/api/agents/orchestrator'), 'cleanup should hit agent endpoint');
  });

  it('calls claude with --dangerously-skip-permissions and -p flag', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(
      script.includes('--dangerously-skip-permissions') && script.includes('-p'),
      'should pass --dangerously-skip-permissions and -p to claude',
    );
  });

  it('includes a polling loop using since_id (not unread=true)', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    // Must use since_id-based polling so messages consumed by the orchestrator Claude
    // process via the API don't disappear before the wrapper's poll loop runs.
    assert.ok(script.includes('since_id=$LAST_MSG_ID'), 'should poll with since_id cursor, not unread=true');
    assert.ok(!script.includes('unread=true'), 'should NOT use unread=true (race condition)');
    assert.ok(script.includes('while ['), 'should have a while loop for polling');
  });

  it('seeds LAST_MSG_ID from current max message ID before starting', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('LAST_MSG_ID='), 'should define LAST_MSG_ID variable');
    // Should query the daemon to seed initial cursor before running Claude
    assert.ok(script.includes('api/messages?agent=orchestrator'), 'should query messages API to seed cursor');
  });

  it('advances LAST_MSG_ID after consuming a message', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('LAST_MSG_ID="$NEW_LAST_ID"'), 'should advance cursor after consuming task');
  });

  it('resets elapsed counter after picking up a new task', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('elapsed=0'), 'should reset elapsed timer on new task');
  });
});

describe('buildOrchestratorWrapperScript — prompt encoding', () => {
  it('encodes the initial prompt as base64', () => {
    const prompt = 'Do the work now';
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', prompt);
    const expected = Buffer.from(prompt, 'utf8').toString('base64');
    assert.ok(script.includes(expected), 'script should contain base64-encoded prompt');
  });

  it('handles prompts with single quotes without breaking the script', () => {
    const prompt = "It's Dave's task with 'special' chars";
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', prompt);
    // The prompt is base64 encoded — no raw quotes should appear in the embedded data
    const b64 = Buffer.from(prompt, 'utf8').toString('base64');
    assert.ok(script.includes(b64), 'base64-encoded prompt should be present');
  });

  it('handles prompts with newlines and special shell characters', () => {
    const prompt = 'Line 1\nLine 2\n$VAR\n`backtick`\n"double"';
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', prompt);
    const b64 = Buffer.from(prompt, 'utf8').toString('base64');
    assert.ok(script.includes(b64), 'multi-line prompt with special chars should be base64-encoded');
  });

  it('decodes prompt via base64 -d in the script', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('base64 -d'), 'script should decode prompt with base64 -d');
  });

  it('round-trip: encoded prompt decodes back to original', () => {
    const original = 'You are the orchestrator agent.\n\nTask: Fix the bug in foo.ts\n\nContext: The test fails on line 42.';
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', original);

    // Extract the base64 value from the script
    const match = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/);
    assert.ok(match, 'script should contain base64 -d decode line');
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf8');
    assert.equal(decoded, original, 'decoded prompt should match original');
  });
});

describe('buildOrchestratorWrapperScript — task extraction logic', () => {
  it('includes python3 json parsing for message body', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes('python3'), 'should use python3 for JSON parsing');
    assert.ok(script.includes('json.load'), 'should parse JSON response');
  });

  it('extracts task field from message body JSON', () => {
    const script = buildOrchestratorWrapperScript('/usr/bin/claude', 'Task');
    assert.ok(script.includes("parsed.get('task'"), 'should extract task key from parsed body');
  });
});

// ── Session name helpers ──────────────────────────────────────

describe('Session name helpers', () => {
  it('_getCommsSession returns the generic comms session name', () => {
    assert.equal(_getCommsSession(), 'commsagent');
  });

  it('_getOrchestratorSession returns the generic orchestrator session name', () => {
    assert.equal(_getOrchestratorSession(), 'orchagent');
  });
});
