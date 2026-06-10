/**
 * Tests for worker-lifecycle hardening (Round 3, Fix C):
 *
 * 1. spawnWorkerJob: a throw from startWorker no longer leaves the job
 *    stuck in 'queued' forever — the job is failed loudly and the spawn
 *    call returns { status: 'failed' }.
 * 2. finishJob: idempotence guard — a second finish for an already-terminal
 *    job is ignored (no listener re-fire, no result overwrite).
 * 3. processQueue: a throw from startWorker fails that job and continues
 *    draining the queue instead of abandoning everything behind it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../core/db.js';
import {
  spawnWorkerJob,
  setOnJobComplete,
  setMaxConcurrentAgents,
  _resetForTesting,
  _getQueueLength,
  _setStartWorkerFnForTesting,
  _finishJobForTesting,
} from '../lifecycle.js';
import type { JobRecord, SpawnRequest } from '../lifecycle.js';
import type { AgentProfile } from '../profiles.js';

// ── Helpers ──────────────────────────────────────────────────

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

function getJob(jobId: string): { status: string; result: string | null; error: string | null } {
  const rows = query<{ status: string; result: string | null; error: string | null }>(
    'SELECT status, result, error FROM worker_jobs WHERE id = ?',
    jobId,
  );
  return rows[0]!;
}

function getAgentStatusRow(jobId: string): string {
  const rows = query<{ status: string }>('SELECT status FROM agents WHERE id = ?', jobId);
  return rows[0]!.status;
}

/** A startWorker stand-in that marks the job running without touching the SDK. */
function fakeStart(jobId: string, req: SpawnRequest): void {
  if (req.prompt.includes('POISON')) {
    throw new Error('poison spawn');
  }
  const ts = new Date().toISOString();
  exec(`UPDATE agents SET status = 'running', updated_at = ? WHERE id = ?`, ts, jobId);
  exec(`UPDATE worker_jobs SET status = 'running', started_at = ? WHERE id = ?`, ts, jobId);
}

let tmpDir: string;

beforeEach(() => {
  _resetConfigForTesting();
  _resetDbForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-lifecycle-hardening-'));
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    ['agent:', '  name: TestAgent'].join('\n') + '\n',
  );
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetForTesting();
});

afterEach(() => {
  _setStartWorkerFnForTesting(null);
  setOnJobComplete(null);
  _resetForTesting();
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. spawn-failure containment ─────────────────────────────

describe('spawnWorkerJob: startWorker failure containment', () => {
  it('fails the job instead of leaving it queued when startWorker throws', async () => {
    _setStartWorkerFnForTesting(() => {
      throw new Error('boom');
    });

    const { jobId, status } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'do work' });

    assert.equal(status, 'failed');
    const job = getJob(jobId);
    assert.equal(job.status, 'failed');
    assert.ok(job.error?.includes('Worker spawn failed: boom'), `unexpected error: ${job.error}`);
    assert.equal(getAgentStatusRow(jobId), 'stopped');
    assert.equal(_getQueueLength(), 0);
  });

  it('fires job-complete listeners exactly once for a contained spawn failure', async () => {
    const calls: JobRecord[] = [];
    setOnJobComplete(j => calls.push(j));
    _setStartWorkerFnForTesting(() => {
      throw new Error('boom');
    });

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'do work' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, jobId);
    assert.equal(calls[0]!.status, 'failed');
  });
});

// ── 2. finishJob idempotence ─────────────────────────────────

describe('finishJob: idempotence guard', () => {
  it('ignores a duplicate finish for an already-terminal job', async () => {
    const calls: JobRecord[] = [];
    setOnJobComplete(j => calls.push(j));
    _setStartWorkerFnForTesting(() => {
      throw new Error('boom');
    });

    const { jobId } = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'do work' });
    assert.equal(calls.length, 1);
    assert.equal(getJob(jobId).status, 'failed');

    // Attempt to re-finish with a different terminal state — must be a no-op.
    _finishJobForTesting(jobId, 'completed', 'late result', null);

    const job = getJob(jobId);
    assert.equal(job.status, 'failed', 'duplicate finish must not overwrite terminal status');
    assert.equal(job.result, null, 'duplicate finish must not overwrite result');
    assert.equal(calls.length, 1, 'duplicate finish must not re-fire listeners');
  });
});

// ── 3. processQueue containment ──────────────────────────────

describe('processQueue: bad spawn does not break the dequeue loop', () => {
  it('fails the poison job and still starts the job behind it', async () => {
    _setStartWorkerFnForTesting(fakeStart);
    setMaxConcurrentAgents(1);

    // A occupies the single slot; B (poison) and C queue behind it.
    const a = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'task A' });
    const b = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'POISON task B' });
    const c = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'task C' });

    assert.equal(a.status, 'running');
    assert.equal(b.status, 'queued');
    assert.equal(c.status, 'queued');
    assert.equal(_getQueueLength(), 2);

    // Finishing A frees the slot and drains the queue: B's spawn throws and
    // is contained; C must still be dequeued and started.
    _finishJobForTesting(a.jobId, 'completed', 'done', null);

    const jobB = getJob(b.jobId);
    assert.equal(jobB.status, 'failed');
    assert.ok(jobB.error?.includes('Worker spawn failed'), `unexpected error: ${jobB.error}`);

    const jobC = getJob(c.jobId);
    assert.equal(jobC.status, 'running', 'job C must start despite job B failing to spawn');
    assert.equal(_getQueueLength(), 0);
  });
});
