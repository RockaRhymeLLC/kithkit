/**
 * spawn-feedback-survey — mutation-kill tests
 *
 * Asserts that CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 is present in the
 * environment used for BOTH daemon spawn paths:
 *   - orchestrator (tmux new-session via buildOrchSpawnEnv in tmux.ts)
 *   - workers       (sdkOptions.env built in sdk-adapter.ts)
 *
 * CC 2.1.x doc + issue #8036 confirm this var suppresses the interactive
 * session-feedback survey prompt that can wedge long orch/worker sessions.
 *
 * Mutation-kill guarantee: removing the var from either spawn path causes
 * the corresponding test to go RED.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _buildOrchSpawnEnvForTesting,
} from '../agents/tmux.js';
import {
  spawnWorker,
  _resetWorkersForTesting,
  _setQueryFnForTesting,
  _getLastSdkCallArgs,
} from '../agents/sdk-adapter.js';
import type { WorkerProfile } from '../agents/sdk-adapter.js';

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createMockQuery() {
  return async function* mockQuery(_args: { prompt: string; options?: unknown }) {
    yield { type: 'result', subtype: 'success', result: 'ok', usage: {} } as never;
  };
}

const minimalProfile: WorkerProfile = { name: 'test-survey-profile' };

// ── Teardown ──────────────────────────────────────────────────

beforeEach(() => {
  _resetWorkersForTesting();
});

afterEach(() => {
  _resetWorkersForTesting();
  _setQueryFnForTesting(null);
});

// ── Tests ─────────────────────────────────────────────────────

describe('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY in spawn envs', () => {

  it('orchestrator spawn env contains CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1', () => {
    const env = _buildOrchSpawnEnvForTesting();
    assert.equal(
      env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY,
      '1',
      'orch tmux spawn env must set CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
    );
  });

  it('worker spawn env contains CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 (no caller env)', async () => {
    _setQueryFnForTesting(createMockQuery());
    spawnWorker({ prompt: 'test', profile: minimalProfile });
    await sleep(50);

    const args = _getLastSdkCallArgs();
    assert.ok(args, 'SDK query should have been called');
    const opts = args.options as Record<string, unknown>;
    const env = opts.env as Record<string, string> | undefined;
    assert.ok(env, 'sdkOptions.env must be set even when caller supplies no env');
    assert.equal(
      env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY,
      '1',
      'worker env must set CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
    );
  });

  it('worker spawn env contains CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 (caller env present)', async () => {
    _setQueryFnForTesting(createMockQuery());
    spawnWorker({
      prompt: 'test',
      profile: minimalProfile,
      env: { KITHKIT_AGENT_TOKEN: 'tok-test' },
    });
    await sleep(50);

    const args = _getLastSdkCallArgs();
    assert.ok(args, 'SDK query should have been called');
    const opts = args.options as Record<string, unknown>;
    const env = opts.env as Record<string, string> | undefined;
    assert.ok(env, 'sdkOptions.env must be set');
    assert.equal(
      env.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY,
      '1',
      'worker env must set CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 even when caller env is merged',
    );
    // Caller-supplied vars must still be present
    assert.equal(env.KITHKIT_AGENT_TOKEN, 'tok-test', 'caller env vars must be preserved');
  });

});
