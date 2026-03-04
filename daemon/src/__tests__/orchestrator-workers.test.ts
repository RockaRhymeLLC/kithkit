/**
 * Orchestrator Workers API tests.
 *
 * Tests spawn-with-linkage, list, get, and kill endpoints under
 * /api/orchestrator/workers/.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query } from '../core/db.js';
import {
  handleOrchestratorWorkersRoute,
  setProfilesDir,
} from '../api/orchestrator-workers.js';
import { _resetForTesting as resetLifecycle } from '../agents/lifecycle.js';
import {
  _setQueryFnForTesting,
  _resetWorkersForTesting,
} from '../agents/sdk-adapter.js';

const TEST_PORT = 19890;

// ── Helpers ──────────────────────────────────────────────────

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

let server: http.Server;
let tmpDir: string;
let profilesDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-orch-workers-'));
  profilesDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(profilesDir, { recursive: true });

  // Create a minimal test profile
  fs.writeFileSync(path.join(profilesDir, 'coding.md'), [
    '---',
    'name: coding',
    'description: Coding worker',
    'model: sonnet',
    '---',
    'You are a coding assistant.',
  ].join('\n'));

  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  // Mock SDK adapter to avoid real Claude API calls
  _setQueryFnForTesting(async function* (_args: { prompt: string; options?: unknown }) {
    yield { type: 'result', content: 'done' };
  });

  setProfilesDir(profilesDir);

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);

    // Buffer body before routing (mirrors main.ts behavior)
    const bodyChunks: Buffer[] = [];
    inReq.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    inReq.on('end', () => {
      (inReq as unknown as Record<string, unknown>)._rawBody = Buffer.concat(bodyChunks);
      res.setHeader('X-Timestamp', new Date().toISOString());
      handleOrchestratorWorkersRoute(inReq, res, url.pathname, url.searchParams)
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
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _setQueryFnForTesting(null);
    _resetWorkersForTesting();
    resetLifecycle();
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

/** Insert a minimal task row directly for test setup. */
function insertTask(id: string): void {
  const ts = new Date().toISOString();
  exec(
    `INSERT INTO orchestrator_tasks (id, title, description, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    id, 'Test task', 'Test description', ts, ts,
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe('Orchestrator Workers API', { concurrency: 1 }, () => {

  describe('POST /api/orchestrator/workers/spawn', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('spawns a worker without task linkage', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Write a hello world function',
      });
      assert.equal(res.status, 202, `body: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(body.jobId, 'Should have a jobId');
      assert.ok(['running', 'queued'].includes(body.status), `status: ${body.status}`);
      assert.equal(body.task_id, null, 'task_id should be null when not provided');
      assert.ok(body.timestamp, 'Should have timestamp');
    });

    it('spawns a worker and links it to a task', async () => {
      const taskId = 'test-task-uuid-1234';
      insertTask(taskId);

      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Implement feature X',
        task_id: taskId,
      });
      assert.equal(res.status, 202, `body: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.ok(body.jobId, 'Should have a jobId');
      assert.equal(body.task_id, taskId, 'task_id should match');

      // Verify the link was inserted in orchestrator_task_workers
      const links = query<{ task_id: string; worker_id: string; role: string }>(
        'SELECT task_id, worker_id, role FROM orchestrator_task_workers WHERE task_id = ?',
        taskId,
      );
      assert.equal(links.length, 1, 'Should have one task-worker link');
      assert.equal(links[0]!.worker_id, body.jobId);
      assert.equal(links[0]!.role, 'coding');
    });

    it('returns 400 when prompt is missing', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('prompt'));
    });

    it('returns 400 when profile is missing', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        prompt: 'Do something',
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('profile'));
    });

    it('returns 400 when profile is not found', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'nonexistent-profile',
        prompt: 'Do something',
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('nonexistent-profile'));
    });

    it('returns 404 when task_id does not exist', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Do something',
        task_id: 'nonexistent-task-uuid',
      });
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('nonexistent-task-uuid'));
    });

    it('sets spawned_by to orchestrator', async () => {
      const res = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Test task',
      });
      assert.equal(res.status, 202);
      const body = JSON.parse(res.body);

      const jobs = query<{ spawned_by: string }>(
        'SELECT spawned_by FROM worker_jobs WHERE id = ?',
        body.jobId,
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.spawned_by, 'orchestrator');
    });
  });

  describe('GET /api/orchestrator/workers', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('lists workers spawned by orchestrator', async () => {
      // Spawn two workers
      await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Worker 1',
      });
      await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Worker 2',
      });

      const res = await request('GET', '/api/orchestrator/workers');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data), 'data should be an array');
      assert.ok(body.data.length >= 2, `Expected at least 2 workers, got ${body.data.length}`);
      assert.ok(body.timestamp, 'Should have timestamp');
    });

    it('filters workers by task_id', async () => {
      const taskId = 'filter-test-task-uuid';
      insertTask(taskId);

      // Spawn one worker linked to task, one without
      const r1 = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Linked worker',
        task_id: taskId,
      });
      await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Unlinked worker',
      });

      const res = await request('GET', `/api/orchestrator/workers?task_id=${taskId}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1, 'Should only return the task-linked worker');
      const linkedJobId = JSON.parse(r1.body).jobId;
      assert.equal(body.data[0]!.id, linkedJobId);
    });

    it('returns empty array when no orchestrator workers exist', async () => {
      const res = await request('GET', '/api/orchestrator/workers');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.data));
      assert.equal(body.data.length, 0);
    });
  });

  describe('GET /api/orchestrator/workers/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns worker status by id', async () => {
      const spawnRes = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Test prompt',
      });
      assert.equal(spawnRes.status, 202);
      const { jobId } = JSON.parse(spawnRes.body);

      const res = await request('GET', `/api/orchestrator/workers/${jobId}`);
      assert.equal(res.status, 200, `body: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.id, jobId);
      assert.ok(body.profile, 'Should have profile');
      assert.ok(body.status, 'Should have status');
    });

    it('returns 404 for nonexistent worker', async () => {
      const res = await request('GET', '/api/orchestrator/workers/nonexistent-worker-id');
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('not found'));
    });
  });

  describe('DELETE /api/orchestrator/workers/:id', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('kills a queued worker', async () => {
      // Force queue by setting max concurrent agents to 0
      const { setMaxConcurrentAgents } = await import('../agents/lifecycle.js');
      setMaxConcurrentAgents(0);

      const spawnRes = await request('POST', '/api/orchestrator/workers/spawn', {
        profile: 'coding',
        prompt: 'Test prompt',
      });
      assert.equal(spawnRes.status, 202);
      const { jobId } = JSON.parse(spawnRes.body);

      // Kill the queued worker
      const res = await request('DELETE', `/api/orchestrator/workers/${jobId}`);
      assert.equal(res.status, 200, `body: ${res.body}`);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'killed');
      assert.equal(body.worker_id, jobId);
    });

    it('returns 404 for nonexistent worker', async () => {
      const res = await request('DELETE', '/api/orchestrator/workers/nonexistent-worker-id');
      assert.equal(res.status, 404);
    });
  });

  describe('Route non-match', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns false (404) for unrelated paths', async () => {
      const res = await request('GET', '/api/something-else');
      assert.equal(res.status, 404);
    });

    it('returns false (404) for /api/orchestrator/tasks', async () => {
      // This path is handled by handleTaskQueueRoute, not this handler
      const res = await request('GET', '/api/orchestrator/tasks');
      assert.equal(res.status, 404);
    });
  });
});
