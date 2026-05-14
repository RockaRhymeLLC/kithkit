/**
 * t-130, t-131, t-132, t-133, t-175, t-136: SDK adapter layer
 *
 * Tests use a mock SDK query function to verify adapter behavior
 * without calling the real Anthropic API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  spawnWorker,
  killWorker,
  getWorkerStatus,
  listWorkers,
  _resetWorkersForTesting,
  _setQueryFnForTesting,
  _getLastSdkCallArgs,
  _getCapWarningStateForTesting,
} from '../agents/sdk-adapter.js';
import type { WorkerProfile, SpawnOptions } from '../agents/sdk-adapter.js';

// ── Mock helpers ─────────────────────────────────────────────

/** Create a mock query function that yields messages then returns. */
function createMockQuery(messages: Array<Record<string, unknown>>, delayMs = 0) {
  return async function* mockQuery(_args: { prompt: string; options?: unknown }) {
    for (const msg of messages) {
      if (delayMs > 0) await sleep(delayMs);
      yield msg as never;
    }
  };
}

/** Create a mock that hangs forever (for kill/timeout tests). */
function createHangingQuery() {
  return async function* hangingQuery(_args: { prompt: string; options?: unknown }) {
    // Yield an initial message then hang
    yield { type: 'assistant', content: 'thinking...' } as never;
    // Wait indefinitely (will be aborted)
    await new Promise(() => {}); // never resolves
  };
}

/** Create a mock that respects abort signal. */
function createAbortableQuery(signalRef: { signal: AbortSignal | null }) {
  return async function* abortableQuery(args: { prompt: string; options?: unknown }) {
    const opts = args.options as { abortController?: AbortController } | undefined;
    if (opts?.abortController) {
      signalRef.signal = opts.abortController.signal;
    }
    // Yield an initial message
    yield { type: 'assistant', content: 'working...' } as never;
    // Wait for abort
    await new Promise<void>((resolve, reject) => {
      if (signalRef.signal?.aborted) { reject(new Error('Aborted')); return; }
      signalRef.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const testProfile: WorkerProfile = {
  // Use a name that does NOT match any caps.profiles entry so maxTurns falls
  // back to the frontmatter value (10). Named profiles like 'research' now
  // resolve their cap from caps.profiles via getCaps() — see Worker A commit 10620956.
  name: 'test-adapter-profile',
  description: 'Research worker',
  model: 'claude-sonnet-4-6',
  allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch'],
  disallowedTools: ['Bash'],
  permissionMode: 'bypassPermissions',
  maxTurns: 10,
  body: 'You are a research assistant.',
};

// ── Setup/teardown ───────────────────────────────────────────

beforeEach(() => {
  _resetWorkersForTesting();
});

afterEach(() => {
  _resetWorkersForTesting();
  _setQueryFnForTesting(null); // restore real SDK
});

describe('SDK Adapter', { concurrency: 1 }, () => {

  // ── t-130: spawnWorker creates SDK query with profile options ──

  describe('spawnWorker with profile options (t-130)', () => {
    it('passes allowedTools, disallowedTools, model from profile', async () => {
      const resultMessage = {
        type: 'result',
        subtype: 'success',
        result: 'Done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      _setQueryFnForTesting(createMockQuery([resultMessage]));

      const id = spawnWorker({
        prompt: 'List files in current directory',
        profile: testProfile,
      });

      assert.ok(id, 'Should return a job ID');

      // Wait for async worker to complete
      await sleep(50);

      const args = _getLastSdkCallArgs();
      assert.ok(args, 'SDK should have been called');
      assert.equal(args.prompt, 'List files in current directory');

      const opts = args.options as Record<string, unknown>;
      assert.deepEqual(opts.allowedTools, ['Read', 'Glob', 'Grep', 'WebSearch']);
      assert.deepEqual(opts.disallowedTools, ['Bash']);
      assert.equal(opts.model, 'claude-sonnet-4-6');
      assert.equal(opts.maxTurns, 10);
    });

    it('sets permissionMode to bypassPermissions with allowDangerouslySkipPermissions', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      spawnWorker({ prompt: 'test', profile: testProfile });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;
      assert.equal(opts.permissionMode, 'bypassPermissions');
      assert.equal(opts.allowDangerouslySkipPermissions, true);
    });

    it('does not set allowDangerouslySkipPermissions for non-bypass modes', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      const profile: WorkerProfile = {
        name: 'safe-worker',
        permissionMode: 'acceptEdits',
      };
      spawnWorker({ prompt: 'test', profile });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;
      assert.equal(opts.permissionMode, 'acceptEdits');
      assert.equal(opts.allowDangerouslySkipPermissions, undefined);
    });

    it('appends profile body to systemPrompt', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      spawnWorker({ prompt: 'test', profile: testProfile });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;
      const sp = opts.systemPrompt as Record<string, unknown>;
      assert.equal(sp.type, 'preset');
      assert.equal(sp.preset, 'claude_code');
      assert.equal(sp.append, 'You are a research assistant.');
    });
  });

  // ── t-175: settingSources AND systemPrompt both set ────────────

  describe('CLAUDE.md loading config (t-175)', () => {
    it('sets both settingSources and systemPrompt for CLAUDE.md loading', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      spawnWorker({ prompt: 'test', profile: { name: 'minimal' } });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;

      // Must have settingSources
      assert.deepEqual(opts.settingSources, ['project']);

      // Must have systemPrompt with preset
      const sp = opts.systemPrompt as Record<string, unknown>;
      assert.equal(sp.type, 'preset');
      assert.equal(sp.preset, 'claude_code');
    });

    it('systemPrompt preset is always set even with no profile body', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      const profile: WorkerProfile = { name: 'bare' };
      spawnWorker({ prompt: 'test', profile });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;
      const sp = opts.systemPrompt as Record<string, unknown>;
      assert.equal(sp.type, 'preset');
      assert.equal(sp.preset, 'claude_code');
      assert.equal(sp.append, undefined, 'Should not have append when no profile body');
    });
  });

  // ── t-131: killWorker aborts running worker ────────────────────

  describe('killWorker (t-131)', () => {
    it('aborts a running worker via AbortController', async () => {
      const signalRef: { signal: AbortSignal | null } = { signal: null };
      _setQueryFnForTesting(createAbortableQuery(signalRef));

      const id = spawnWorker({
        prompt: 'long running task',
        profile: { name: 'test' },
        timeoutMs: 60000, // long timeout so it doesn't interfere
      });

      // Wait for worker to start
      await sleep(50);

      const statusBefore = getWorkerStatus(id);
      assert.equal(statusBefore?.status, 'running');

      // Kill it
      const killed = killWorker(id);
      assert.ok(killed, 'killWorker should return true');

      // Wait for abort to propagate
      await sleep(50);

      const statusAfter = getWorkerStatus(id);
      assert.equal(statusAfter?.status, 'failed');
      assert.equal(statusAfter?.error, 'Aborted');
      assert.ok(statusAfter?.finishedAt, 'Should have finishedAt');
    });

    it('returns false for unknown worker ID', () => {
      const result = killWorker('nonexistent');
      assert.equal(result, false);
    });

    it('returns false for already-completed worker', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: { name: 'test' } });
      await sleep(50);

      const result = killWorker(id);
      assert.equal(result, false);
    });
  });

  // ── t-132: Worker status includes usage stats ──────────────────

  describe('Worker status with usage stats (t-132)', () => {
    it('captures token counts and cost from SDK result', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'assistant', content: 'Working on it...' },
        {
          type: 'result',
          subtype: 'success',
          result: 'Here are the files: src/, lib/, test/',
          total_cost_usd: 0.0042,
          usage: { input_tokens: 1500, output_tokens: 350 },
        },
      ]));

      const id = spawnWorker({
        prompt: 'List files in current directory',
        profile: testProfile,
      });

      await sleep(50);

      const status = getWorkerStatus(id);
      assert.ok(status, 'Worker should exist');
      assert.equal(status.status, 'completed');
      assert.equal(status.tokensIn, 1500);
      assert.equal(status.tokensOut, 350);
      assert.equal(status.costUsd, 0.0042);
      assert.equal(status.result, 'Here are the files: src/, lib/, test/');
      assert.ok(status.startedAt);
      assert.ok(status.finishedAt);
    });

    it('captures zero usage when no usage in result', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: { name: 'test' } });
      await sleep(50);

      const status = getWorkerStatus(id);
      assert.equal(status?.tokensIn, 0);
      assert.equal(status?.tokensOut, 0);
      assert.equal(status?.costUsd, 0);
    });

    it('captures error status when SDK returns non-success', async () => {
      _setQueryFnForTesting(createMockQuery([
        {
          type: 'result',
          subtype: 'error_max_budget_usd',
          result: 'Budget exceeded',
          total_cost_usd: 0.50,
          usage: { input_tokens: 5000, output_tokens: 2000 },
        },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: { name: 'test' } });
      await sleep(50);

      const status = getWorkerStatus(id);
      assert.equal(status?.status, 'failed');
      assert.ok(status?.error?.includes('Budget exceeded'));
      assert.equal(status?.tokensIn, 5000);
      assert.equal(status?.costUsd, 0.50);
    });

    it('returns null for unknown worker ID', () => {
      const status = getWorkerStatus('nonexistent');
      assert.equal(status, null);
    });

    it('listWorkers returns all workers', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      spawnWorker({ prompt: 'test 1', profile: { name: 'a' } });
      spawnWorker({ prompt: 'test 2', profile: { name: 'b' } });
      await sleep(50);

      const all = listWorkers();
      assert.equal(all.length, 2);
    });
  });

  // ── t-133: Inactivity timeout triggers kill ────────────────────

  describe('Inactivity timeout (t-133)', () => {
    it('kills worker after inactivity timeout', async () => {
      // Mock that yields one message then hangs
      _setQueryFnForTesting(createHangingQuery());

      const id = spawnWorker({
        prompt: 'test',
        profile: { name: 'test' },
        timeoutMs: 200, // 200ms timeout for testing
      });

      // Worker should be running initially
      await sleep(50);
      assert.equal(getWorkerStatus(id)?.status, 'running');

      // Wait for timeout
      await sleep(300);

      const status = getWorkerStatus(id);
      assert.equal(status?.status, 'timeout');
      assert.ok(status?.error?.includes('Inactivity timeout'));
      assert.ok(status?.finishedAt);
    });

    it('resets timer on each message (extends timeout)', async () => {
      // Mock that yields messages at intervals
      _setQueryFnForTesting(async function* () {
        yield { type: 'assistant', content: 'msg 1' } as never;
        await sleep(100);
        yield { type: 'assistant', content: 'msg 2' } as never;
        await sleep(100);
        yield {
          type: 'result', subtype: 'success', result: 'Done',
          usage: { input_tokens: 10, output_tokens: 5 },
        } as never;
      });

      const id = spawnWorker({
        prompt: 'test',
        profile: { name: 'test' },
        timeoutMs: 150, // 150ms timeout — would fire if not reset between messages
      });

      // Wait for all messages to complete
      await sleep(350);

      const status = getWorkerStatus(id);
      assert.equal(status?.status, 'completed', 'Should complete because timer resets on each message');
    });

    it('uses default timeout when not specified', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'OK', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: { name: 'test' } });
      await sleep(50);

      // Just verify it completed without timeout (default is 5 min)
      assert.equal(getWorkerStatus(id)?.status, 'completed');
    });
  });

  // ── t-136: Cap-approaching turn warning ────────────────────────

  describe('Cap-approaching turn warning (t-136)', () => {
    // Use a profile name not in caps.profiles fallback so effectiveMaxTurns
    // falls back to the profile's own maxTurns value.
    const warningProfile: WorkerProfile = { name: 'test-warning-only', maxTurns: 5 };

    it('fires turn warning when turns_used/cap reaches threshold', async () => {
      // 4/5 = 80% — exactly at the default 80% warning threshold
      _setQueryFnForTesting(createMockQuery([
        { type: 'assistant', content: 'turn 1' },
        { type: 'assistant', content: 'turn 2' },
        { type: 'assistant', content: 'turn 3' },
        { type: 'assistant', content: 'turn 4' },
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: warningProfile });
      await sleep(50);

      const capState = _getCapWarningStateForTesting(id);
      assert.ok(capState, 'capState should exist');
      assert.equal(capState!.turns_used, 4, 'Should count 4 assistant turns');
      assert.ok(capState!.turn_warning_fired, 'Warning should have fired at 80% of maxTurns');
    });

    it('does not fire warning below threshold', async () => {
      // 3/5 = 60% — below the 80% threshold
      _setQueryFnForTesting(createMockQuery([
        { type: 'assistant', content: 'turn 1' },
        { type: 'assistant', content: 'turn 2' },
        { type: 'assistant', content: 'turn 3' },
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: warningProfile });
      await sleep(50);

      const capState = _getCapWarningStateForTesting(id);
      assert.ok(capState, 'capState should exist');
      assert.equal(capState!.turns_used, 3);
      assert.equal(capState!.turn_warning_fired, false, 'Warning must not fire at 60%');
    });

    it('fires warning exactly once even when many turns exceed threshold', async () => {
      // 4+ turns all exceed threshold; warning must fire only once
      _setQueryFnForTesting(createMockQuery([
        { type: 'assistant', content: 'turn 1' },
        { type: 'assistant', content: 'turn 2' },
        { type: 'assistant', content: 'turn 3' },
        { type: 'assistant', content: 'turn 4' },
        { type: 'assistant', content: 'turn 5' },
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: warningProfile });
      await sleep(50);

      const capState = _getCapWarningStateForTesting(id);
      assert.ok(capState!.turn_warning_fired, 'Warning should have fired');
      assert.equal(capState!.turns_used, 5, 'All 5 turns counted');
      // The fired flag stays true — idempotency guaranteed by the boolean check
      assert.ok(capState!.turn_warning_fired, 'Warning flag remains set (idempotent)');
    });

    it('does not warn when turns are far below the default cap', async () => {
      // Profile with no maxTurns and not in caps.profiles → falls back to
      // caps.default_max_turns (100). With only 2 turns, 2/100 = 2% is well below
      // the 80% warning threshold so the warning must not fire.
      const uncappedProfile: WorkerProfile = { name: 'test-uncapped' };
      _setQueryFnForTesting(createMockQuery([
        { type: 'assistant', content: 'turn 1' },
        { type: 'assistant', content: 'turn 2' },
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      const id = spawnWorker({ prompt: 'test', profile: uncappedProfile });
      await sleep(50);

      const capState = _getCapWarningStateForTesting(id);
      assert.ok(capState, 'capState should exist');
      assert.equal(capState!.turn_warning_fired, false, 'No warning when no cap set');
    });
  });

  // ── t-137: caps.default_max_turns fallback (P0 fix) ───────────

  describe('caps.default_max_turns fallback (t-137)', () => {
    it('uses caps.default_max_turns (100) when profile absent from caps.profiles and has no frontmatter maxTurns', async () => {
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      // Profile name not in caps.profiles; no maxTurns on the object → must fall
      // back to caps.default_max_turns (default: 100) so SDK always has a turn cap.
      const bareProfile: WorkerProfile = { name: 'test-bare-no-turns' };
      spawnWorker({ prompt: 'test', profile: bareProfile });
      await sleep(50);

      const args = _getLastSdkCallArgs();
      assert.ok(args, 'SDK should have been called');
      const opts = args!.options as Record<string, unknown>;
      assert.equal(opts.maxTurns, 100, 'maxTurns must equal caps.default_max_turns (100) as final fallback');
    });

    it('caps.profiles entry still takes precedence over caps.default_max_turns', async () => {
      // testProfile.name = 'test-adapter-profile' is not in real caps.profiles,
      // so frontmatter maxTurns (10) takes precedence over default (100).
      _setQueryFnForTesting(createMockQuery([
        { type: 'result', subtype: 'success', result: 'Done', usage: {} },
      ]));

      spawnWorker({ prompt: 'test', profile: testProfile }); // maxTurns: 10
      await sleep(50);

      const args = _getLastSdkCallArgs();
      const opts = args!.options as Record<string, unknown>;
      assert.equal(opts.maxTurns, 10, 'profile frontmatter maxTurns (10) takes precedence over default (100)');
    });
  });

  // ── t-138: inactivity_warning_fired resets on timer reset (P1 fix) ──

  describe('inactivity_warning_fired resets across quiet periods (t-138)', () => {
    it('clears inactivity_warning_fired when timer resets on incoming message', async () => {
      // Scenario: worker goes quiet → warning fires → message arrives → timer
      // resets → inactivity_warning_fired must be false so the warning can fire
      // again during the next quiet period.
      //
      // Timeline with timeoutMs=500 (warningMs=400):
      //   t=0:   worker starts, timers armed
      //   t=420: we sample capState — warning should have fired at t=400
      //   t=450: mock yields a message → resetInactivityTimer called
      //   t=480: we sample capState — flag should be cleared
      //   t=~500: worker completes

      const timeoutMs = 500;

      _setQueryFnForTesting(async function* () {
        // Hang until warning has fired, then yield a message to trigger a reset.
        await sleep(450);
        yield { type: 'assistant', content: 'recovered' } as never;
        yield { type: 'result', subtype: 'success', result: 'Done', usage: {} } as never;
      });

      const id = spawnWorker({
        prompt: 'test',
        profile: { name: 'test-inactivity-reset' },
        timeoutMs,
      });

      // After 420ms: warning timer (400ms) should have fired.
      await sleep(420);
      const stateMid = _getCapWarningStateForTesting(id);
      assert.ok(stateMid, 'capState should exist while running');
      assert.ok(stateMid!.inactivity_warning_fired, 'inactivity warning should have fired at 80% of timeout');

      // After another 80ms (total ~500ms): message arrived at 450ms, timer reset.
      await sleep(80);
      const stateAfterReset = _getCapWarningStateForTesting(id);
      assert.ok(stateAfterReset, 'capState should still exist');
      assert.equal(
        stateAfterReset!.inactivity_warning_fired,
        false,
        'inactivity_warning_fired must be cleared after timer reset so warning can re-fire in next quiet period',
      );

      // Worker should complete cleanly.
      await sleep(100);
      assert.equal(getWorkerStatus(id)?.status, 'completed');
    });
  });
});
