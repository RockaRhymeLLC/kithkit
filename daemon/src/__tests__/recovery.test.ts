/**
 * t-160: Failed worker notifies orchestrator and doesn't leave orphaned state
 * t-161: Orchestrator crash recovery
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, exec, query, _resetDbForTesting } from '../core/db.js';
import {
  notifyWorkerFailure,
  handleWorkerTimeout,
  recoverFromRestart,
  detectCrashedAgents,
  markAgentCrashed,
  getPendingJobsForRecovery,
} from '../agents/recovery.js';
import type { JobRecord, AgentRecord } from '../agents/lifecycle.js';

describe('Failed worker notifies orchestrator and cleans up (t-160)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-recovery-'));
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handleWorkerTimeout marks job as timeout', () => {
    const ts = new Date().toISOString();

    // Insert a running agent and job
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w1', 'worker', 'coding', 'running', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at, started_at)
       VALUES ('w1', 'w1', 'coding', 'fix the bug', 'running', ?, ?)`,
      ts, ts,
    );

    handleWorkerTimeout('w1');

    const jobs = query<JobRecord>('SELECT * FROM worker_jobs WHERE id = ?', 'w1');
    assert.equal(jobs[0]!.status, 'timeout');
    assert.ok(jobs[0]!.error!.includes('timeout'));
    assert.ok(jobs[0]!.finished_at);

    const agents = query<AgentRecord>('SELECT * FROM agents WHERE id = ?', 'w1');
    assert.equal(agents[0]!.status, 'stopped');
  });

  it('notifyWorkerFailure sends message to orchestrator', () => {
    const ts = new Date().toISOString();

    // Create orchestrator agent
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('orchestrator', 'orchestrator', NULL, 'idle', ?, ?)`,
      ts, ts,
    );

    const job: JobRecord = {
      id: 'w1',
      agent_id: 'w1',
      profile: 'coding',
      prompt: 'fix the bug',
      status: 'failed',
      result: null,
      error: 'Something went wrong',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      started_at: ts,
      finished_at: ts,
      created_at: ts,
      spawned_by: null,
      spawner_notified_at: null,
    };

    // Should not throw
    notifyWorkerFailure(job);

    // Check that a message was queued for orchestrator
    const messages = query<{ to_agent: string; type: string }>(
      "SELECT to_agent, type FROM messages WHERE to_agent = 'orchestrator'",
    );
    assert.ok(messages.length > 0, 'Message should be sent to orchestrator');
    assert.equal(messages[0]!.type, 'result');
  });

  it('failed worker agent status set to stopped', () => {
    const ts = new Date().toISOString();

    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w2', 'worker', 'coding', 'running', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('w2', 'w2', 'coding', 'test prompt', 'running', ?)`,
      ts,
    );

    handleWorkerTimeout('w2');

    const agents = query<AgentRecord>('SELECT * FROM agents WHERE id = ?', 'w2');
    assert.equal(agents[0]!.status, 'stopped');
    assert.ok(!agents[0]!.pid, 'No PID should remain');
  });
});

describe('Orchestrator crash recovery (t-161)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-recovery-'));
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recoverFromRestart cleans up orphaned agents', () => {
    const ts = new Date().toISOString();

    // Simulate agents left running from crash
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('orch', 'orchestrator', NULL, 'busy', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w1', 'worker', 'coding', 'running', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('w1', 'w1', 'coding', 'do work', 'running', ?)`,
      ts,
    );

    const report = recoverFromRestart();

    assert.ok(report.orphansCleaned >= 2, 'Should clean up orphaned agents');

    // Verify agent statuses
    const agents = query<AgentRecord>('SELECT * FROM agents');
    for (const agent of agents) {
      assert.equal(agent.status, 'crashed', `Agent ${agent.id} should be crashed`);
    }
  });

  it('interrupted jobs marked as failed', () => {
    const ts = new Date().toISOString();

    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w1', 'worker', 'coding', 'running', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at, started_at)
       VALUES ('w1', 'w1', 'coding', 'important work', 'running', ?, ?)`,
      ts, ts,
    );

    const report = recoverFromRestart();

    const jobs = query<JobRecord>('SELECT * FROM worker_jobs WHERE id = ?', 'w1');
    assert.equal(jobs[0]!.status, 'failed');
    assert.ok(jobs[0]!.finished_at);
  });

  it('detectCrashedAgents finds active persistent agents', () => {
    const ts = new Date().toISOString();

    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('comms', 'comms', NULL, 'idle', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w-stopped', 'worker', 'coding', 'stopped', ?, ?)`,
      ts, ts,
    );

    const crashed = detectCrashedAgents();
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0]!.id, 'comms');
  });

  it('markAgentCrashed updates status and fails running jobs', () => {
    const ts = new Date().toISOString();

    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('orch', 'orchestrator', NULL, 'busy', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('j1', 'orch', 'coding', 'task', 'queued', ?)`,
      ts,
    );

    markAgentCrashed('orch');

    const agents = query<AgentRecord>('SELECT * FROM agents WHERE id = ?', 'orch');
    assert.equal(agents[0]!.status, 'crashed');

    const jobs = query<JobRecord>('SELECT * FROM worker_jobs WHERE id = ?', 'j1');
    assert.equal(jobs[0]!.status, 'failed');
    assert.ok(jobs[0]!.error!.includes('crashed'));
  });

  it('getPendingJobsForRecovery returns queued jobs in order', () => {
    const ts1 = '2026-01-01T00:00:01Z';
    const ts2 = '2026-01-01T00:00:02Z';

    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w1', 'worker', 'coding', 'queued', ?, ?)`,
      ts1, ts1,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('w2', 'worker', 'coding', 'queued', ?, ?)`,
      ts2, ts2,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('w1', 'w1', 'coding', 'first', 'queued', ?)`,
      ts1,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('w2', 'w2', 'coding', 'second', 'queued', ?)`,
      ts2,
    );

    const pending = getPendingJobsForRecovery();
    assert.equal(pending.length, 2);
    assert.equal(pending[0]!.prompt, 'first');
    assert.equal(pending[1]!.prompt, 'second');
  });
});
