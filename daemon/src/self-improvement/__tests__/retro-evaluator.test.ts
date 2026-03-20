/**
 * Tests for retro-evaluator: shouldTriggerRetro, spawnRetro, and lifecycle callback.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import {
  shouldTriggerRetro,
  spawnRetro,
  _setSpawnFnForTesting,
  _setProfilesDirForTesting,
} from '../retro-evaluator.js';
import {
  spawnWorkerJob,
  setOnJobComplete,
  _resetForTesting,
} from '../../agents/lifecycle.js';
import {
  _setQueryFnForTesting,
  _resetWorkersForTesting,
} from '../../agents/sdk-adapter.js';
import type { AgentProfile } from '../../agents/profiles.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const RETRO_PROFILE_MD = `---
name: retro
description: Post-task retrospective analysis worker
tools: [Read, Grep]
disallowedTools: [Bash, Edit, Write, NotebookEdit]
model: haiku
permissionMode: bypassPermissions
maxTurns: 15
effort: medium
---

You are a retrospective analysis worker.
`;

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

function makeTask(overrides: Partial<{
  id: string;
  title: string;
  description: string | null;
  status: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  outcome: string | null;
  outcome_notes: string | null;
  created_at: string;
  completed_at: string | null;
  workers: Array<{ id: string; status: string; error: string | null }>;
}> = {}) {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: null,
    status: 'completed',
    result: null,
    error: null,
    retry_count: 0,
    outcome: null,
    outcome_notes: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

function enableSelfImprovement(tmpDir: string) {
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'self_improvement:',
      '  enabled: true',
      '  retro:',
      '    enabled: true',
    ].join('\n') + '\n',
  );
  loadConfig(tmpDir);
}

// ── shouldTriggerRetro tests ──────────────────────────────────

describe('shouldTriggerRetro returns true when task has errors', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-'));
    enableSelfImprovement(tmpDir);
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when task.error is set', () => {
    const task = makeTask({ error: 'Something went wrong' });
    assert.equal(shouldTriggerRetro(task), true);
  });
});

describe('shouldTriggerRetro returns true when retry_count > 0', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-'));
    enableSelfImprovement(tmpDir);
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when retry_count is 1', () => {
    const task = makeTask({ retry_count: 1 });
    assert.equal(shouldTriggerRetro(task), true);
  });

  it('returns true when retry_count is 3', () => {
    const task = makeTask({ retry_count: 3 });
    assert.equal(shouldTriggerRetro(task), true);
  });
});

describe('shouldTriggerRetro returns false when no signals present', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-'));
    enableSelfImprovement(tmpDir);
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for clean task with no errors or retries', () => {
    const task = makeTask({ error: null, retry_count: 0 });
    assert.equal(shouldTriggerRetro(task), false);
  });

  it('returns false for task with workers but none failed', () => {
    const task = makeTask({
      error: null,
      retry_count: 0,
      workers: [{ id: 'w1', status: 'completed', error: null }],
    });
    assert.equal(shouldTriggerRetro(task), false);
  });
});

describe('shouldTriggerRetro returns false when self_improvement disabled', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when self_improvement.enabled is false (default)', () => {
    loadConfig(tmpDir);
    const task = makeTask({ error: 'Some error', retry_count: 2 });
    assert.equal(shouldTriggerRetro(task), false);
  });

  it('returns false when self_improvement enabled but retro.enabled is false', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: true\n  retro:\n    enabled: false\n',
    );
    loadConfig(tmpDir);
    const task = makeTask({ error: 'Some error' });
    assert.equal(shouldTriggerRetro(task), false);
  });
});

// ── spawnRetro tests ──────────────────────────────────────────

describe('spawnRetro constructs correct prompt with task context', () => {
  let tmpDir: string;
  let profilesDir: string;
  let capturedRequest: unknown;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-spawn-'));
    profilesDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(profilesDir);
    fs.writeFileSync(path.join(profilesDir, 'retro.md'), RETRO_PROFILE_MD);
    enableSelfImprovement(tmpDir);
    _setProfilesDirForTesting(profilesDir);

    capturedRequest = undefined;
    _setSpawnFnForTesting((req) => {
      capturedRequest = req;
      return Promise.resolve({ jobId: 'mock-job-id', status: 'running' as const });
    });
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSpawnFnForTesting(null);
    _setProfilesDirForTesting(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes task id, title, error, and retry_count in prompt', async () => {
    const task = {
      id: 'task-abc',
      title: 'Test the retro system',
      description: 'Run all retro checks',
      status: 'failed',
      result: null,
      error: 'Worker timed out',
      retry_count: 2,
      outcome: 'failed',
      outcome_notes: 'Hit timeout on second attempt',
      created_at: '2026-03-19T10:00:00Z',
      completed_at: null,
      workers: [],
      activity: [
        {
          id: 1,
          task_id: 'task-abc',
          agent: 'orchestrator',
          type: 'progress',
          stage: 'start',
          message: 'Task started',
          created_at: '2026-03-19T10:00:01Z',
        },
      ],
    };

    const jobId = await spawnRetro(task);
    assert.equal(jobId, 'mock-job-id');

    const req = capturedRequest as { prompt: string; profile: { name: string }; spawned_by: string };
    assert.ok(req, 'spawn was called');
    assert.equal(req.profile.name, 'retro');
    assert.equal(req.spawned_by, 'orchestrator');
    assert.ok(req.prompt.includes('task-abc'), 'prompt includes task id');
    assert.ok(req.prompt.includes('Test the retro system'), 'prompt includes title');
    assert.ok(req.prompt.includes('Worker timed out'), 'prompt includes error');
    assert.ok(req.prompt.includes('2'), 'prompt includes retry_count');
    assert.ok(req.prompt.includes('Task started'), 'prompt includes activity log entry');
  });
});

// ── finishJob callback tests ──────────────────────────────────

describe('finishJob calls onJobComplete callback after DB update', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-lifecycle-'));
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

  it('callback is invoked with completed job after worker finishes', async () => {
    _setQueryFnForTesting(async function* (_args) {
      await sleep(10);
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as never;
    });

    let callbackJob: unknown = null;
    setOnJobComplete((job) => {
      callbackJob = job;
    });

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Test callback' });

    await sleep(800);

    assert.ok(callbackJob, 'callback should have been called');
    const job = callbackJob as { id: string; status: string };
    assert.equal(job.id, jobId);
    assert.equal(job.status, 'completed');
  });

  it('finishJob works when no callback is set', async () => {
    _setQueryFnForTesting(async function* (_args) {
      await sleep(10);
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as never;
    });

    // No callback set — should complete without error
    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'No callback test' });

    await sleep(800);

    const { getJobStatus } = await import('../../agents/lifecycle.js');
    const job = getJobStatus(jobId);
    assert.ok(job, 'job should exist');
    assert.equal(job!.status, 'completed');
  });
});
