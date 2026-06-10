/**
 * Worker telemetry capture (Round 5): resolved_model + turns_used land on the
 * worker_jobs row. This is the instrumentation gap that made model
 * attribution impossible in the fable-5 experiment rounds.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query } from '../../core/db.js';
import { spawnWorkerJob, _resetForTesting, type JobRecord } from '../lifecycle.js';
import { _setQueryFnForTesting, _resetWorkersForTesting } from '../sdk-adapter.js';
import type { AgentProfile } from '../profiles.js';

const TEST_PROFILE: AgentProfile = {
  name: 'research',
  description: 'Research agent',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 20,
  effort: 'high',
  body: 'You are a research assistant.',
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('worker telemetry: resolved_model and turns_used', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-telemetry-'));
    _resetDbForTesting();
    _resetWorkersForTesting();
    _resetForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetForTesting();
    _resetWorkersForTesting();
    _setQueryFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists the system:init model and assistant turn count', async () => {
    _setQueryFnForTesting(async function* (_args) {
      await sleep(10);
      yield { type: 'system', subtype: 'init', model: 'claude-test-model-1' } as never;
      yield { type: 'assistant', message: { content: [] } } as never;
      yield { type: 'assistant', message: { content: [] } } as never;
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as never;
    });

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'telemetry test' });
    await sleep(800);

    const job = query<JobRecord>('SELECT * FROM worker_jobs WHERE id = ?', jobId)[0]!;
    assert.equal(job.status, 'completed');
    assert.equal(job.resolved_model, 'claude-test-model-1');
    assert.equal(job.turns_used, 2);
  });

  it('falls back to result modelUsage keys when no init message arrives', async () => {
    _setQueryFnForTesting(async function* (_args) {
      await sleep(10);
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, output_tokens: 2 },
        num_turns: 3,
        modelUsage: { 'claude-fallback-model': { inputTokens: 5 } },
      } as never;
    });

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'fallback test' });
    await sleep(800);

    const job = query<JobRecord>('SELECT * FROM worker_jobs WHERE id = ?', jobId)[0]!;
    assert.equal(job.resolved_model, 'claude-fallback-model');
    assert.equal(job.turns_used, 3, 'result num_turns wins when larger than counted turns');
  });
});
