/**
 * Post-task retro integration tests for orchestrator task PUT handler (Story 4).
 *
 * Tests:
 *   1. Completing a task with error field calls evaluateTask
 *   2. Completing a clean task calls evaluateTask (shouldTriggerRetro returns false internally)
 *   3. Failing a task calls evaluateTask
 *   4. Retro evaluation is non-blocking (PUT returns before evaluateTask resolves)
 *   5. Retro spawn is logged as task activity
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { handleTaskQueueRoute, _setEvaluateTaskFnForTesting } from '../task-queue.js';
import {
  _setSpawnFnForTesting,
  _setProfilesDirForTesting,
} from '../../self-improvement/retro-evaluator.js';

const TEST_PORT = 19872;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TestResponse {
  status: number;
  body: string;
  durationMs: number;
}

function request(method: string, urlPath: string, body?: unknown): Promise<TestResponse> {
  const start = Date.now();
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, durationMs: Date.now() - start }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

let server: http.Server;
let tmpDir: string;
let profilesDir: string;

function setup(): Promise<void> {
  _resetConfigForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-integ-'));
  profilesDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'retro.md'), RETRO_PROFILE_MD);
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  loadConfig(tmpDir); // default config — self_improvement disabled

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleTaskQueueRoute(inReq, res, url.pathname, url.searchParams)
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
  _setEvaluateTaskFnForTesting(null);
  _setSpawnFnForTesting(null);
  _setProfilesDirForTesting(null);
  _resetConfigForTesting();
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    if (server?.listening) {
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    } else {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }
  });
}

async function createTask(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await request('POST', '/api/orchestrator/tasks', {
    title: 'Retro test task',
    ...overrides,
  });
  assert.equal(res.status, 201);
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function advanceToInProgress(taskId: string): Promise<void> {
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, { status: 'assigned', assignee: 'orchestrator' });
  await request('PUT', `/api/orchestrator/tasks/${taskId}`, { status: 'in_progress' });
}

// ── Tests ─────────────────────────────────────────────────────

describe('Post-task retro integration', { concurrency: 1 }, () => {

  describe('evaluateTask called when completing task with error', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('calls evaluateTask with the task id when completing a task that has an error', async () => {
      let calledWith: string | null = null;
      _setEvaluateTaskFnForTesting(async (id) => { calledWith = id; });

      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done despite errors',
        error: 'Some workers failed',
      });
      assert.equal(res.status, 200);

      await sleep(30);
      assert.equal(calledWith, task.id, 'evaluateTask should be called with the task id');
    });
  });

  describe('evaluateTask called even for clean completion', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('calls evaluateTask for a clean completion (no error field)', async () => {
      let calledWith: string | null = null;
      _setEvaluateTaskFnForTesting(async (id) => { calledWith = id; });

      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'All done cleanly',
      });
      assert.equal(res.status, 200);

      await sleep(30);
      assert.equal(calledWith, task.id, 'evaluateTask should be called; internally shouldTriggerRetro returns false');
    });
  });

  describe('evaluateTask called when task fails', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('calls evaluateTask when a task is marked failed', async () => {
      let calledWith: string | null = null;
      _setEvaluateTaskFnForTesting(async (id) => { calledWith = id; });

      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed',
        error: 'Worker crashed unexpectedly',
      });
      assert.equal(res.status, 200);

      await sleep(30);
      assert.equal(calledWith, task.id, 'evaluateTask should be called for failed tasks');
    });
  });

  describe('retro evaluation is non-blocking', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('PUT response returns before evaluateTask resolves', async () => {
      const RETRO_DELAY = 400;
      _setEvaluateTaskFnForTesting(async (_id) => {
        await sleep(RETRO_DELAY);
      });

      const task = await createTask();
      await advanceToInProgress(task.id as string);

      const result = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'completed',
        result: 'Done',
      });

      assert.equal(result.status, 200, 'PUT should succeed');
      assert.ok(
        result.durationMs < RETRO_DELAY,
        `PUT (${result.durationMs}ms) should return before retro delay (${RETRO_DELAY}ms)`,
      );
    });
  });

  describe('retro spawn logged as task activity', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('logs a retro activity entry after spawn succeeds', async () => {
      // Enable self-improvement so evaluateTask proceeds to spawnRetro
      // Must reset before reloading to bypass the cached-config guard
      _resetConfigForTesting();
      fs.writeFileSync(
        path.join(tmpDir, 'kithkit.config.yaml'),
        'self_improvement:\n  enabled: true\n  retro:\n    enabled: true\n',
      );
      loadConfig(tmpDir);

      // Use real evaluateTask (do not mock it)
      _setEvaluateTaskFnForTesting(null);
      _setProfilesDirForTesting(profilesDir);

      const MOCK_JOB_ID = 'mock-retro-job-42';
      _setSpawnFnForTesting(async (_req) => ({
        jobId: MOCK_JOB_ID,
        status: 'running' as const,
      }));

      const task = await createTask();
      await advanceToInProgress(task.id as string);

      // Fail with an error to satisfy shouldTriggerRetro
      const res = await request('PUT', `/api/orchestrator/tasks/${task.id}`, {
        status: 'failed',
        error: 'Something broke',
      });
      assert.equal(res.status, 200);

      // Wait for async evaluateTask to complete
      await sleep(150);

      // Verify activity log contains a retro entry
      const actRes = await request('GET', `/api/orchestrator/tasks/${task.id}/activity`);
      assert.equal(actRes.status, 200);
      const body = JSON.parse(actRes.body) as { data: Array<{ stage: string; message: string }> };
      const retroEntry = body.data.find(a => a.stage === 'retro');
      assert.ok(retroEntry, 'activity log should contain a retro entry with stage=retro');
      assert.ok(
        retroEntry.message.includes(MOCK_JOB_ID),
        `retro entry should mention job id, got: ${retroEntry.message}`,
      );
    });
  });

});
