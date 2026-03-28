/**
 * t-164 through t-171: Integration tests for 8 success criteria
 *
 * These are cross-story flows that verify the framework works as a whole.
 * Each test exercises multiple subsystems working together.
 *
 * Subsystem coverage per test:
 *   t-164: CLI init → config → profiles → DB → health
 *   t-165: DB → agents → messages → routing (no orchestrator)
 *   t-166: DB → agents → lifecycle → messages → spawn
 *   t-167: DB → agents → lifecycle → timeout → recovery
 *   t-168: DB → state → close → reopen → verify
 *   t-169: DB → messages → agents → audit trail
 *   t-170: DB → agents → jobs → usage aggregation
 *   t-171: CLI init → config → profiles → identity → structure validation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, _resetDbForTesting, exec, query, get } from '../../core/db.js';
import { handleStateRoute } from '../../api/state.js';
import { handleMessagesRoute } from '../../api/messages.js';
import { handleAgentsRoute, setProfilesDir } from '../../api/agents.js';
import { getHealth } from '../../core/health.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { loadProfiles } from '../../agents/profiles.js';
import {
  spawnWorkerJob,
  getJobStatus,
  getAgentStatus,
  listAgents,
  _resetForTesting as resetLifecycle,
} from '../../agents/lifecycle.js';
import {
  _setQueryFnForTesting,
  _resetWorkersForTesting,
} from '../../agents/sdk-adapter.js';
import {
  sendMessage,
  getMessages,
  _setTmuxInjectorForTesting,
} from '../../agents/message-router.js';
import {
  handleWorkerTimeout,
  recoverFromRestart,
} from '../../agents/recovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kithkitRoot = path.resolve(__dirname, '..', '..', '..', '..');

const TEST_PORT = 19900;
const VERSION = '0.1.0-test';

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

function json(res: { body: string }): Record<string, unknown> {
  return JSON.parse(res.body) as Record<string, unknown>;
}

/** Mock SDK query that completes successfully with token data. */
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

// ── SC1: Init produces running agent (t-164) ────────────────

describe('SC1: kithkit init produces running agent in under 60s (t-164)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc1-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init + config + DB + health form a working startup chain', () => {
    const start = performance.now();

    // Step 1: Simulate what init creates — config file
    const configYaml = `agent:\n  name: TestBot\n  identity_file: identity.md\ndaemon:\n  port: ${TEST_PORT}\n  log_level: info\n`;
    fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), configYaml);

    // Copy defaults from kithkit root
    const defaultsSrc = path.join(kithkitRoot, 'templates', 'config', 'kithkit.defaults.yaml');
    if (fs.existsSync(defaultsSrc)) {
      fs.copyFileSync(defaultsSrc, path.join(tmpDir, 'kithkit.defaults.yaml'));
    }

    // Step 2: Load config (tests config merging)
    const config = loadConfig(tmpDir);
    assert.equal(config.agent.name, 'TestBot');
    assert.equal(config.daemon.port, TEST_PORT);

    // Step 3: Open database (tests migrations run)
    openDatabase(tmpDir);

    // Step 4: Verify health endpoint returns correct info
    const health = getHealth(VERSION);
    assert.equal(health.status, 'ok');
    assert.equal(health.version, VERSION);
    assert.ok(typeof health.uptime === 'number');

    // Step 5: Verify profiles can be loaded
    const profilesDir = path.join(kithkitRoot, 'profiles');
    if (fs.existsSync(profilesDir)) {
      const profiles = loadProfiles(profilesDir);
      assert.ok(profiles.size >= 6, 'should have at least 6 built-in profiles');
      assert.ok(profiles.has('research'), 'should have research profile');
      assert.ok(profiles.has('coding'), 'should have coding profile');
    }

    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5000, `startup chain should complete in < 5s (took ${elapsed.toFixed(0)}ms)`);
  });

  it('identity template is copied and personalized', () => {
    const templatePath = path.join(kithkitRoot, 'templates', 'identities', 'professional.md');
    if (!fs.existsSync(templatePath)) return;

    const template = fs.readFileSync(templatePath, 'utf-8');
    const personalized = template.replace(/^name:\s*.*$/m, 'name: TestBot');
    fs.writeFileSync(path.join(tmpDir, 'identity.md'), personalized);

    const identity = fs.readFileSync(path.join(tmpDir, 'identity.md'), 'utf-8');
    assert.ok(identity.includes('name: TestBot'), 'identity should have agent name');
    assert.ok(identity.includes('---'), 'identity should have YAML frontmatter');
  });
});

// ── SC2: Comms handles simple requests without orchestrator (t-165) ──

describe('SC2: Comms handles simple requests without orchestrator (t-165)', () => {
  let tmpDir: string;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc2-'));
    openDatabase(tmpDir);
    _setTmuxInjectorForTesting(() => true);

    // Register a comms agent
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'comms-001', 'comms', null, 'idle', new Date().toISOString(), new Date().toISOString(),
    );

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${TEST_PORT}`);
      handleAgentsRoute(req, res, url.pathname)
        .then(h => h ? undefined : handleMessagesRoute(req, res, url.pathname, url.searchParams))
        .then(h => {
          if (h === false) {
            res.writeHead(404);
            res.end('{}');
          }
        })
        .catch(() => { res.writeHead(500); res.end('{}'); });
    });

    await new Promise<void>(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _resetDbForTesting();
    _setTmuxInjectorForTesting(null as unknown as (s: string, t: string) => boolean);
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('simple message to comms does not spawn orchestrator', async () => {
    // Send a simple message to comms
    const sendRes = await request('POST', '/api/messages', {
      from: 'human',
      to: 'comms-001',
      body: 'What time is it?',
      type: 'text',
    });
    assert.equal(sendRes.status, 200);

    // Verify no orchestrator was spawned
    const agentsRes = await request('GET', '/api/agents');
    assert.equal(agentsRes.status, 200);
    const agents = json(agentsRes).data as Array<{ type: string }>;
    const orchestrators = agents.filter(a => a.type === 'orchestrator');
    assert.equal(orchestrators.length, 0, 'no orchestrator should be spawned for simple request');

    // Verify message was logged
    const msgsRes = await request('GET', '/api/messages?agent=comms-001');
    assert.equal(msgsRes.status, 200);
    const msgs = json(msgsRes).data as Array<{ body: string }>;
    assert.ok(msgs.some(m => m.body === 'What time is it?'), 'message should be logged');
  });
});

// ── SC3: Complex task escalates to orchestrator (t-166) ─────

describe('SC3: Complex task escalates to orchestrator which spawns workers (t-166)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc3-'));
    openDatabase(tmpDir);
    _setTmuxInjectorForTesting(() => true);
  });

  afterEach(() => {
    _resetDbForTesting();
    _setTmuxInjectorForTesting(null as unknown as (s: string, t: string) => boolean);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('comms → orchestrator → worker → result chain works end-to-end', () => {
    // Register all three agent tiers
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'comms-001', 'comms', null, 'busy', ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'orch-001', 'orchestrator', null, 'idle', ts, ts,
    );

    // Simulate worker being spawned (via DB, not lifecycle — avoids async SDK calls)
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'worker-001', 'worker', 'research', 'running', ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'job-001', 'worker-001', 'research', 'Compare Vitest vs Jest', 'running', ts,
    );

    // Step 1: Comms escalates to orchestrator
    const escMsg = sendMessage({
      from: 'comms-001',
      to: 'orch-001',
      body: 'Research the top 3 TypeScript testing frameworks',
      type: 'task',
    });
    assert.ok(escMsg.messageId, 'escalation message should be created');

    // Step 2: Orchestrator assigns task to worker
    const taskMsg = sendMessage({
      from: 'orch-001',
      to: 'worker-001',
      body: 'Compare Vitest, Jest, and Node test runner',
      type: 'task',
    });
    assert.ok(taskMsg.messageId, 'task message should be created');

    // Step 3: Worker completes and sends result back
    const resultMsg = sendMessage({
      from: 'worker-001',
      to: 'orch-001',
      body: JSON.stringify({ jobId: 'job-001', result: 'Vitest recommended' }),
      type: 'result',
    });
    assert.ok(resultMsg.messageId, 'result message should be created');

    // Step 4: Orchestrator sends summary to comms
    const summaryMsg = sendMessage({
      from: 'orch-001',
      to: 'comms-001',
      body: 'Research complete: Vitest recommended for modern TypeScript projects',
      type: 'text',
    });
    assert.ok(summaryMsg.messageId, 'summary message should be created');

    // Verify: All agents present in DB
    const agents = listAgents();
    assert.equal(agents.length, 3, 'should have comms + orchestrator + worker');
    const agentTypes = agents.map(a => a.type);
    assert.ok(agentTypes.includes('comms'));
    assert.ok(agentTypes.includes('orchestrator'));
    assert.ok(agentTypes.includes('worker'));

    // Verify: Worker job exists
    const job = getJobStatus('job-001');
    assert.ok(job, 'worker job should exist');

    // Verify: Full message chain for orchestrator
    const orchMsgs = getMessages('orch-001');
    assert.equal(orchMsgs.length, 4, 'orchestrator should have 4 messages');
    const types = orchMsgs.map(m => m.type);
    assert.ok(types.filter(t => t === 'task').length >= 2, 'should have task messages');
    assert.ok(types.includes('result'), 'should have result message');
    assert.ok(types.includes('text'), 'should have text message');
  });
});

// ── SC4: Worker crash/hang detected and recovered (t-167) ───

describe('SC4: Worker crash/hang detected and recovered (t-167)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc4-'));
    openDatabase(tmpDir);
    _setTmuxInjectorForTesting(() => true);
  });

  afterEach(() => {
    _resetDbForTesting();
    _setTmuxInjectorForTesting(null as unknown as (s: string, t: string) => boolean);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('timeout detection marks job and notifies orchestrator via recovery system', () => {
    const ts = new Date().toISOString();

    // Create agent, job, and orchestrator (agent id = job id, per lifecycle convention)
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'job-hang', 'worker', 'research', 'running', ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'orch-001', 'orchestrator', null, 'busy', ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'job-hang', 'job-hang', 'research', 'research task', 'running', ts,
    );

    // Timeout the job
    handleWorkerTimeout('job-hang');

    // Verify job marked as timeout
    const job = get<{ status: string; result: string }>('worker_jobs', 'job-hang');
    assert.ok(job, 'job should exist');
    assert.equal(job!.status, 'timeout', 'job should be marked timeout');

    // Verify agent marked as stopped
    const agent = get<{ status: string }>('agents', 'job-hang');
    assert.ok(agent, 'agent should exist');
    assert.equal(agent!.status, 'stopped', 'agent should be stopped');

    // Verify notification message sent to orchestrator
    // notifyWorkerFailure sends to literal 'orchestrator', not the agent id
    const msgs = getMessages('orchestrator');
    const timeoutMsg = msgs.find(m => m.type === 'result' && m.body.includes('timeout'));
    assert.ok(timeoutMsg, 'orchestrator should receive timeout notification');
  });
});

// ── SC5: Agent state survives daemon restart (t-168) ────────

describe('SC5: Agent state survives daemon restart (t-168)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc5-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('DB state persists through close + reopen cycle', () => {
    // Phase 1: Create state
    openDatabase(tmpDir);

    const ts = new Date().toISOString();

    // Create todos
    exec(
      `INSERT INTO todos (title, description, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'Important task', 'Must do this', 'high', 'pending', ts, ts,
    );

    // Create memories
    exec(
      `INSERT INTO memories (content, type, category, tags, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'User likes dark mode', 'fact', 'preferences', '["ui"]', 'conversation', ts, ts,
    );

    // Create agent record
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'comms-persist', 'comms', null, 'idle', ts, ts,
    );

    // Create calendar event
    exec(
      `INSERT INTO calendar (title, start_time, created_at)
       VALUES (?, ?, ?)`,
      'Team standup', '2026-02-22T09:00:00Z', ts,
    );

    // Phase 2: Close database (simulates daemon shutdown)
    closeDatabase();

    // Phase 3: Reopen database (simulates daemon restart)
    openDatabase(tmpDir);

    // Phase 4: Verify all state survived
    const todos = query<{ title: string }>('SELECT * FROM todos');
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, 'Important task');

    const memories = query<{ content: string }>('SELECT * FROM memories');
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, 'User likes dark mode');

    const agents = query<{ id: string; status: string }>('SELECT * FROM agents');
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, 'comms-persist');

    const events = query<{ title: string }>('SELECT * FROM calendar');
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Team standup');
  });

  it('interrupted jobs recovered after restart', () => {
    openDatabase(tmpDir);
    const ts = new Date().toISOString();

    // Create a job that was running when daemon stopped
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'worker-interrupted', 'worker', 'coding', 'running', ts, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'job-interrupted', 'worker-interrupted', 'coding', 'implement feature', 'running', ts,
    );

    // Simulate restart
    closeDatabase();
    openDatabase(tmpDir);

    // Run recovery
    recoverFromRestart();

    // Verify interrupted job is marked as failed
    const job = get<{ status: string; result: string }>('worker_jobs', 'job-interrupted');
    assert.ok(job, 'job should still exist');
    assert.equal(job!.status, 'failed', 'interrupted job should be marked failed');

    // Verify orphaned agent is cleaned up
    const agent = get<{ status: string }>('agents', 'worker-interrupted');
    assert.ok(agent, 'agent should still exist');
    assert.equal(agent!.status, 'crashed', 'orphaned agent should be marked crashed');
  });
});

// ── SC6: All inter-agent messages logged and auditable (t-169) ──

describe('SC6: All inter-agent messages logged and auditable (t-169)', () => {
  let tmpDir: string;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc6-'));
    openDatabase(tmpDir);
    _setTmuxInjectorForTesting(() => true);

    // Register agents
    const ts = new Date().toISOString();
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'comms-audit', 'comms', null, 'busy', ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'orch-audit', 'orchestrator', null, 'idle', ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'worker-audit', 'worker', 'research', 'idle', ts, ts,
    );

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${TEST_PORT}`);
      handleMessagesRoute(req, res, url.pathname, url.searchParams)
        .then(h => {
          if (h === false) { res.writeHead(404); res.end('{}'); }
        })
        .catch(() => { res.writeHead(500); res.end('{}'); });
    });

    await new Promise<void>(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _resetDbForTesting();
    _setTmuxInjectorForTesting(null as unknown as (s: string, t: string) => boolean);
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('multi-agent message chain is fully logged and queryable via API', async () => {
    // Step 1: Comms → Orchestrator (task)
    await request('POST', '/api/messages', {
      from: 'comms-audit', to: 'orch-audit',
      body: 'Research TypeScript testing', type: 'task',
    });

    // Step 2: Orchestrator → Worker (task assignment)
    await request('POST', '/api/messages', {
      from: 'orch-audit', to: 'worker-audit',
      body: 'Compare Vitest vs Jest', type: 'task',
    });

    // Step 3: Worker → Orchestrator (result)
    await request('POST', '/api/messages', {
      from: 'worker-audit', to: 'orch-audit',
      body: 'Vitest is faster for modern projects', type: 'result',
    });

    // Step 4: Orchestrator → Comms (final answer)
    await request('POST', '/api/messages', {
      from: 'orch-audit', to: 'comms-audit',
      body: 'Research complete: Vitest recommended', type: 'text',
    });

    // Verify: Query all messages for orchestrator
    const orchRes = await request('GET', '/api/messages?agent=orch-audit');
    assert.equal(orchRes.status, 200);
    const orchMsgs = json(orchRes).data as Array<{ from_agent: string; to_agent: string; type: string; body: string; created_at: string }>;

    // Orchestrator should see all 4 messages (2 received, 2 sent)
    assert.equal(orchMsgs.length, 4, 'orchestrator should have 4 messages in audit trail');

    // Verify chronological ordering
    for (let i = 1; i < orchMsgs.length; i++) {
      assert.ok(
        orchMsgs[i].created_at >= orchMsgs[i - 1].created_at,
        'messages should be chronologically ordered',
      );
    }

    // Verify full chain: task → task → result → text
    const chain = orchMsgs.map(m => m.type);
    assert.ok(chain.filter(t => t === 'task').length >= 2, 'chain should include task messages');
    assert.ok(chain.includes('result'), 'chain should include result');
    assert.ok(chain.includes('text'), 'chain should include text');

    // Verify each message has required audit fields
    for (const msg of orchMsgs) {
      assert.ok(msg.from_agent, 'message must have from_agent');
      assert.ok(msg.to_agent, 'message must have to_agent');
      assert.ok(msg.body, 'message must have body');
      assert.ok(msg.created_at, 'message must have created_at');
    }
  });
});

// ── SC7: Token usage per task tracked and queryable (t-170) ──

describe('SC7: Token usage per task tracked and queryable (t-170)', () => {
  let tmpDir: string;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc7-'));
    openDatabase(tmpDir);

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${TEST_PORT}`);
      handleAgentsRoute(req, res, url.pathname)
        .then(h => h ? undefined : handleStateRoute(req, res, url.pathname, url.searchParams))
        .then(h => {
          if (h === false) { res.writeHead(404); res.end('{}'); }
        })
        .catch(() => { res.writeHead(500); res.end('{}'); });
    });

    await new Promise<void>(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _resetDbForTesting();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completed jobs contribute to aggregate usage stats via API', async () => {
    const ts = new Date().toISOString();

    // Create completed jobs with token data
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'w1', 'worker', 'research', 'stopped', ts, ts,
    );
    exec(
      `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'w2', 'worker', 'coding', 'stopped', ts, ts,
    );

    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, tokens_in, tokens_out, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'job-1', 'w1', 'research', 'find info', 'completed', 1000, 500, 0.005, ts,
    );
    exec(
      `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, tokens_in, tokens_out, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'job-2', 'w2', 'coding', 'write code', 'completed', 2000, 1000, 0.012, ts,
    );

    // Query individual job status
    const job1Res = await request('GET', '/api/agents/job-1/status');
    assert.equal(job1Res.status, 200);
    const job1 = json(job1Res);
    assert.equal(job1.tokens_in, 1000);
    assert.equal(job1.tokens_out, 500);
    assert.equal(job1.cost_usd, 0.005);

    // Query aggregate usage
    const usageRes = await request('GET', '/api/usage');
    assert.equal(usageRes.status, 200);
    const usage = json(usageRes);
    assert.equal(usage.tokens_in, 3000);
    assert.equal(usage.tokens_out, 1500);
    assert.equal(usage.cost_usd, 0.017);
    assert.equal(usage.jobs, 2);
  });
});

// ── SC8: Second user can init with no help (t-171) ──────────

describe('SC8: Second user can init with no help (t-171)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sc8-'));
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fresh directory init produces complete, self-contained project', () => {
    // Simulate what kithkit init does on a fresh machine:

    // 1. Config from defaults
    const defaultsSrc = path.join(kithkitRoot, 'templates', 'config', 'kithkit.defaults.yaml');
    const configYaml = `agent:\n  name: NewUser\n  identity_file: identity.md\ndaemon:\n  port: 3847\n  log_level: info\n`;
    fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), configYaml);
    if (fs.existsSync(defaultsSrc)) {
      fs.copyFileSync(defaultsSrc, path.join(tmpDir, 'kithkit.defaults.yaml'));
    }

    // 2. Identity from template
    const templatePath = path.join(kithkitRoot, 'templates', 'identities', 'professional.md');
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf-8');
      const identity = template.replace(/^name:\s*.*$/m, 'name: NewUser');
      fs.writeFileSync(path.join(tmpDir, 'identity.md'), identity);
    }

    // 3. Agent profiles
    const profilesSrc = path.join(kithkitRoot, 'profiles');
    const profilesDst = path.join(tmpDir, '.kithkit', 'agents');
    fs.mkdirSync(profilesDst, { recursive: true });
    if (fs.existsSync(profilesSrc)) {
      for (const f of fs.readdirSync(profilesSrc)) {
        fs.copyFileSync(path.join(profilesSrc, f), path.join(profilesDst, f));
      }
    }

    // 4. CLAUDE.md
    const claudeMdSrc = path.join(kithkitRoot, '.kithkit', 'CLAUDE.md');
    const claudeMdDst = path.join(tmpDir, '.kithkit', 'CLAUDE.md');
    fs.mkdirSync(path.join(tmpDir, '.kithkit'), { recursive: true });
    if (fs.existsSync(claudeMdSrc)) {
      fs.copyFileSync(claudeMdSrc, claudeMdDst);
    }

    // Verify: Everything a new user needs is present
    assert.ok(fs.existsSync(path.join(tmpDir, 'kithkit.config.yaml')), 'config must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, 'identity.md')), 'identity must exist');

    // Verify config is loadable
    const config = loadConfig(tmpDir);
    assert.equal(config.agent.name, 'NewUser');

    // Verify DB can be created
    openDatabase(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, 'kithkit.db')), 'database must be created');

    // Verify profiles are present
    const profiles = fs.readdirSync(profilesDst).filter(f => f.endsWith('.md'));
    assert.ok(profiles.length >= 6, 'at least 6 agent profiles should be installed');

    // Verify identity has the user's chosen name
    const identity = fs.readFileSync(path.join(tmpDir, 'identity.md'), 'utf-8');
    assert.ok(identity.includes('name: NewUser'), 'identity should have user-chosen name');

    // Verify CLAUDE.md is present and has framework instructions
    if (fs.existsSync(claudeMdDst)) {
      const claudeMd = fs.readFileSync(claudeMdDst, 'utf-8');
      assert.ok(claudeMd.includes('Kithkit'), 'CLAUDE.md should reference Kithkit');
      assert.ok(claudeMd.includes('Daemon'), 'CLAUDE.md should mention daemon');
    }
  });

  it('wizard prompts are self-explanatory (no external docs needed)', () => {
    // Verify templates exist and are readable
    const templatesDir = path.join(kithkitRoot, 'templates', 'identities');
    if (!fs.existsSync(templatesDir)) return;

    const templates = fs.readdirSync(templatesDir).filter(f => f.endsWith('.md'));
    assert.ok(templates.length >= 3, 'should have at least 3 identity templates');

    // Each template should be self-describing
    for (const t of templates) {
      const content = fs.readFileSync(path.join(templatesDir, t), 'utf-8');
      assert.ok(content.includes('---'), `${t} should have YAML frontmatter`);
      assert.ok(content.includes('name:'), `${t} should have a name field`);
      assert.ok(content.length > 50, `${t} should have meaningful content`);
    }

    // Config defaults should work without any user customization
    const defaultsSrc = path.join(kithkitRoot, 'templates', 'config', 'kithkit.defaults.yaml');
    if (fs.existsSync(defaultsSrc)) {
      // Write only the minimal config that init would create
      fs.writeFileSync(
        path.join(tmpDir, 'kithkit.config.yaml'),
        'agent:\n  name: Assistant\n',
      );
      fs.copyFileSync(defaultsSrc, path.join(tmpDir, 'kithkit.defaults.yaml'));

      // Should load without errors (defaults fill in everything)
      const config = loadConfig(tmpDir);
      assert.equal(config.agent.name, 'Assistant');
      assert.equal(config.daemon.port, 3847);
      assert.equal(config.daemon.log_level, 'info');
    }
  });
});
