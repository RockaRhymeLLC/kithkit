/**
 * t-130, t-131, t-132, t-133, t-175: SDK adapter layer
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
  name: 'research',
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
});
