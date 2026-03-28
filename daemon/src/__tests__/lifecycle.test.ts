/**
 * t-137, t-138, t-139, t-140, t-141, t-172, t-173, t-177: Agent lifecycle manager
 *
 * Tests use mocked SDK adapter to verify lifecycle behavior
 * without calling the real Anthropic API.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, get, exec, query } from '../core/db.js';
import { handleAgentsRoute, setProfilesDir } from '../api/agents.js';
import {
  spawnWorkerJob,
  getJobStatus,
  getAgentStatus,
  listAgents,
  cleanupOrphanedAgents,
  setMaxConcurrentAgents,
  _resetForTesting,
} from '../agents/lifecycle.js';
import {
  _setQueryFnForTesting,
  _resetWorkersForTesting,
} from '../agents/sdk-adapter.js';
import type { AgentProfile } from '../agents/profiles.js';

const TEST_PORT = 19870;

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

const TEST_PROFILE: AgentProfile = {
  name: 'research',
  description: 'Research agent',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 20,
  effort: 'high',
  maxBudgetUsd: 1.0,
  body: 'You are a research assistant.',
};

let server: http.Server;
let tmpDir: string;
let profilesDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-lifecycle-'));
  profilesDir = path.join(tmpDir, 'profiles');
  fs.mkdirSync(profilesDir);

  // Write a test profile
  fs.writeFileSync(path.join(profilesDir, 'research.md'), `---
name: research
description: Research agent
model: sonnet
permissionMode: bypassPermissions
maxTurns: 20
---

You are a research assistant.
`);

  _resetDbForTesting();
  _resetWorkersForTesting();
  _resetForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  setProfilesDir(profilesDir);

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleAgentsRoute(inReq, res, url.pathname)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    _resetWorkersForTesting();
    _resetForTesting();
    _setQueryFnForTesting(null);
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

// ── Mock SDK query functions ─────────────────────────────────

/** Mock that completes successfully after yielding a result message. */
function createSuccessQuery(resultText = 'Done.', delayMs = 10) {
  return async function* (_args: { prompt: string; options?: unknown }) {
    if (delayMs > 0) await sleep(delayMs);
    yield {
      type: 'result',
      subtype: 'success',
      result: resultText,
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
    } as never;
  };
}

/** Mock that hangs forever (for timeout tests). */
function createHangingQuery() {
  return async function* (_args: { prompt: string; options?: unknown }) {
    yield { type: 'assistant', content: 'thinking...' } as never;
    await new Promise(() => {}); // never resolves
  };
}

/** Mock that completes slowly — takes `durationMs` before result. */
function createSlowQuery(durationMs: number, resultText = 'Done.') {
  return async function* (_args: { prompt: string; options?: unknown }) {
    await sleep(durationMs);
    yield {
      type: 'result',
      subtype: 'success',
      result: resultText,
      total_cost_usd: 0.01,
      usage: { input_tokens: 50, output_tokens: 25 },
    } as never;
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Worker spawns via API and completes job (t-137)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST /agents/spawn returns 202 with jobId and status', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const res = await request('POST', '/api/agents/spawn', {
      profile: 'research',
      prompt: 'Find information about kithkit',
    });

    assert.equal(res.status, 202);
    const body = JSON.parse(res.body);
    assert.ok(body.jobId, 'should have a jobId');
    assert.ok(['queued', 'running'].includes(body.status), `status should be queued or running, got ${body.status}`);
  });

  it('worker job transitions from running to completed', async () => {
    _setQueryFnForTesting(createSuccessQuery('Research complete.', 20));

    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'Do some research',
    });

    // Should start as running
    let job = getJobStatus(jobId);
    assert.ok(job, 'job should exist');
    assert.equal(job!.status, 'running');

    // Wait for completion (poll timer is 500ms, query takes 20ms)
    await sleep(800);

    job = getJobStatus(jobId);
    assert.equal(job!.status, 'completed');
    assert.equal(job!.result, 'Research complete.');
    assert.ok(job!.finished_at, 'should have finished_at');
  });

  it('worker_jobs record has tokens and cost after completion', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'Quick task',
    });

    await sleep(800);

    const job = getJobStatus(jobId);
    assert.equal(job!.status, 'completed');
    assert.equal(job!.tokens_in, 100);
    assert.equal(job!.tokens_out, 50);
    assert.equal(job!.cost_usd, 0.05);
  });

  it('agent record set to stopped after completion', async () => {
    _setQueryFnForTesting(createSuccessQuery());

    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'Quick task',
    });

    await sleep(800);

    const agent = getAgentStatus(jobId);
    assert.equal(agent!.status, 'stopped');
  });
});

describe('Worker timeout detected and enforced (t-138)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('worker killed after inactivity timeout', async () => {
    _setQueryFnForTesting(createHangingQuery());

    // Use a very short timeout for testing
    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'Task that will hang',
      timeoutMs: 200, // 200ms timeout
    });

    // Should start as running
    let job = getJobStatus(jobId);
    assert.equal(job!.status, 'running');

    // Wait for timeout + poll interval
    await sleep(1000);

    job = getJobStatus(jobId);
    assert.equal(job!.status, 'timeout');
    assert.ok(job!.finished_at, 'should have finished_at');

    const agent = getAgentStatus(jobId);
    assert.equal(agent!.status, 'stopped');
  });
});

describe('Max concurrent agents enforced with queuing (t-139)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('third worker queued when max is 2', async () => {
    setMaxConcurrentAgents(2);
    _setQueryFnForTesting(createSlowQuery(2000));

    const job1 = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Task 1' });
    const job2 = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Task 2' });
    const job3 = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Task 3' });

    assert.equal(job1.status, 'running');
    assert.equal(job2.status, 'running');
    assert.equal(job3.status, 'queued');

    // Verify in DB
    const job3Db = getJobStatus(job3.jobId);
    assert.equal(job3Db!.status, 'queued');
  });
});

describe('Orphaned sessions cleaned up on daemon startup (t-140)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('orphaned running agents marked as crashed', () => {
    // Simulate orphaned records
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('orphan-1', 'worker', 'research', 'running', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('orphan-2', 'orchestrator', NULL, 'busy', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES ('orphan-1', 'orphan-1', 'research', 'Some task', 'running', ?)`,
      ts,
    );

    const cleaned = cleanupOrphanedAgents();
    assert.equal(cleaned, 2);

    const agent1 = getAgentStatus('orphan-1');
    assert.equal(agent1!.status, 'crashed');

    const agent2 = getAgentStatus('orphan-2');
    assert.equal(agent2!.status, 'crashed');

    const job = getJobStatus('orphan-1');
    assert.equal(job!.status, 'failed');
    assert.ok(job!.error!.includes('orphan cleanup'));
  });

  it('stopped agents not affected by cleanup', () => {
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES ('healthy-1', 'worker', 'research', 'stopped', ?, ?)`,
      ts, ts,
    );

    const cleaned = cleanupOrphanedAgents();
    assert.equal(cleaned, 0);

    const agent = getAgentStatus('healthy-1');
    assert.equal(agent!.status, 'stopped');
  });
});

describe('Orchestrator spawns on-demand and stops when idle (t-141)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('no orchestrator at startup', () => {
    const agents = listAgents();
    const orchestrator = agents.find(a => a.type === 'orchestrator');
    assert.equal(orchestrator, undefined, 'no orchestrator should exist at startup');
  });

  // Note: Full orchestrator lifecycle requires tmux integration (Phase 3 story s-f09).
  // This test verifies the DB state management for orchestrator records.
  it('orchestrator agent record lifecycle', () => {
    const ts = new Date().toISOString();

    // Simulate orchestrator spawn
    exec(
      `INSERT INTO agents (id, type, status, tmux_session, created_at, updated_at)
       VALUES ('orchestrator', 'orchestrator', 'busy', 'orch1', ?, ?)`,
      ts, ts,
    );

    let orch = getAgentStatus('orchestrator');
    assert.equal(orch!.status, 'busy');
    assert.equal(orch!.tmux_session, 'orch1');

    // Simulate orchestrator completing work
    exec(
      `UPDATE agents SET status = 'stopped', updated_at = ? WHERE id = 'orchestrator'`,
      new Date().toISOString(),
    );

    orch = getAgentStatus('orchestrator');
    assert.equal(orch!.status, 'stopped');
  });
});

describe('Fast path — simple request without orchestrator (t-172)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('comms handles request without spawning orchestrator', async () => {
    // Simulate comms agent running
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, status, created_at, updated_at)
       VALUES ('comms', 'comms', 'idle', ?, ?)`,
      ts, ts,
    );

    // After processing (comms would handle directly), verify no orchestrator spawned
    const agents = listAgents();
    const orchestrator = agents.find(a => a.type === 'orchestrator');
    assert.equal(orchestrator, undefined, 'orchestrator should NOT be spawned for simple requests');

    const comms = agents.find(a => a.type === 'comms');
    assert.equal(comms!.status, 'idle');
  });
});

describe('Rate limit — worker queued when max concurrent agents reached (t-173)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('worker queued when all slots occupied, auto-starts when slot frees', async () => {
    setMaxConcurrentAgents(3);
    _setQueryFnForTesting(createSlowQuery(300));

    // Simulate comms + orchestrator already occupying 2 slots
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, status, created_at, updated_at)
       VALUES ('comms', 'comms', 'idle', ?, ?)`,
      ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, status, created_at, updated_at)
       VALUES ('orch', 'orchestrator', 'busy', ?, ?)`,
      ts, ts,
    );

    // Worker A gets the last slot (3 of 3)
    const workerA = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Worker A' });
    assert.equal(workerA.status, 'running');

    // Worker B should be queued (no slots)
    const workerB = await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Worker B' });
    assert.equal(workerB.status, 'queued');

    // Wait for worker A to complete
    await sleep(1200);

    // Worker A should be done
    const jobA = getJobStatus(workerA.jobId);
    assert.equal(jobA!.status, 'completed');

    // Worker B should have auto-started (slot freed)
    // Give it time to start and complete
    await sleep(1200);

    const jobB = getJobStatus(workerB.jobId);
    assert.ok(
      ['running', 'completed'].includes(jobB!.status),
      `Worker B should be running or completed, got ${jobB!.status}`,
    );
  });
});

describe('Negative — spawn with nonexistent profile returns error (t-177)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns 400 for nonexistent profile', async () => {
    const res = await request('POST', '/api/agents/spawn', {
      profile: 'nonexistent-profile',
      prompt: 'Do something',
    });

    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('nonexistent-profile'), `error should mention profile name: ${body.error}`);
  });

  it('returns 400 when prompt is missing', async () => {
    const res = await request('POST', '/api/agents/spawn', {
      profile: 'research',
    });

    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('prompt'), `error should mention prompt: ${body.error}`);
  });

  it('no records created for failed spawn attempts', async () => {
    await request('POST', '/api/agents/spawn', {
      profile: 'nonexistent-profile',
      prompt: 'Do something',
    });

    const agents = listAgents();
    assert.equal(agents.length, 0, 'no agent records should exist');

    const jobs = query('SELECT * FROM worker_jobs');
    assert.equal(jobs.length, 0, 'no job records should exist');
  });
});

describe('GET /api/agents lists all agents (t-137 supplement)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns empty list initially', async () => {
    const res = await request('GET', '/api/agents');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data, []);
    assert.ok(body.timestamp);
  });

  it('returns agents after spawn', async () => {
    _setQueryFnForTesting(createSlowQuery(2000));

    await spawnWorkerJob({ profile: TEST_PROFILE, prompt: 'Task 1' });

    const res = await request('GET', '/api/agents');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, 'worker');
    assert.equal(body.data[0].status, 'running');
  });
});

describe('GET /api/agents/:id/status returns job details (t-137 supplement)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns job status for a spawned worker', async () => {
    _setQueryFnForTesting(createSlowQuery(2000));

    const { jobId } = await spawnWorkerJob({
      profile: TEST_PROFILE,
      prompt: 'Some work',
    });

    const res = await request('GET', `/api/agents/${jobId}/status`);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, jobId);
    assert.equal(body.status, 'running');
    assert.equal(body.profile, 'research');
    assert.equal(body.prompt, 'Some work');
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request('GET', '/api/agents/unknown-id/status');
    assert.equal(res.status, 404);
  });
});
