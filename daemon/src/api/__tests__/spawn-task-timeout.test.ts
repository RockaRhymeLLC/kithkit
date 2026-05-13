/**
 * Tests for Q5 — orch_tasks.timeout_seconds threading through to SDK adapter inactivity timer.
 *
 * Two test surfaces:
 *   1. resolveInactivityTimeout() — pure-function unit tests (no DB/HTTP needed)
 *   2. Spawn route integration — task_id lookup in agents.ts threads timeout to SpawnRequest
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { resolveInactivityTimeout } from '../../agents/sdk-adapter.js';
import { handleAgentsRoute, setProfilesDir, _setSpawnFnForTesting } from '../agents.js';
import type { SpawnRequest } from '../../agents/lifecycle.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 300000 — mirrors sdk-adapter's DEFAULT_TIMEOUT_MS
const TEST_PORT = 19885;

// A minimal coding profile .md file for tests
const CODING_PROFILE_MD = `---
name: coding
description: Implementation worker
tools: [Read, Glob, Grep, Edit, Write, Bash]
disallowedTools: []
model: sonnet
permissionMode: bypassPermissions
maxTurns: 40
---

You are a coding worker.
`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; data: unknown }> {
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
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, data: raw }); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('request timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── 1. Pure-function tests: resolveInactivityTimeout ──────────────────────────

describe('resolveInactivityTimeout', () => {
  it('returns task timeout when timeout_seconds = 600 (600 * 1000 = 600000 ms)', () => {
    const result = resolveInactivityTimeout(600_000, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, 600_000);
  });

  it('falls through to sdkDefault when taskTimeoutMs is undefined (null task.timeout_seconds)', () => {
    const result = resolveInactivityTimeout(undefined, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });

  it('falls through to sdkDefault when taskTimeoutMs is 0 (task.timeout_seconds = 0)', () => {
    const result = resolveInactivityTimeout(0, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });

  it('falls through to sdkDefault when taskTimeoutMs is negative (task.timeout_seconds = -5)', () => {
    const result = resolveInactivityTimeout(-5_000, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });

  it('falls through to sdkDefault when no task association (taskTimeoutMs = undefined)', () => {
    const result = resolveInactivityTimeout(undefined, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });

  it('uses capsTimeoutMs when taskTimeoutMs is unset and caps is positive', () => {
    const result = resolveInactivityTimeout(undefined, 120_000, DEFAULT_TIMEOUT_MS);
    assert.equal(result, 120_000);
  });

  it('skips capsTimeoutMs = 0 and falls through to sdkDefault', () => {
    const result = resolveInactivityTimeout(undefined, 0, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });

  it('taskTimeoutMs wins over capsTimeoutMs', () => {
    const result = resolveInactivityTimeout(900_000, 120_000, DEFAULT_TIMEOUT_MS);
    assert.equal(result, 900_000);
  });

  it('treats non-finite taskTimeoutMs as unset', () => {
    const result = resolveInactivityTimeout(Infinity, undefined, DEFAULT_TIMEOUT_MS);
    assert.equal(result, DEFAULT_TIMEOUT_MS);
  });
});

// ── 2. Integration tests: spawn route threads task timeout ─────────────────────

describe('spawn route — task_id timeout threading', () => {
  let server: http.Server;
  let tmpDir: string;
  let profilesDir: string;
  let capturedRequests: SpawnRequest[];

  before(() => new Promise<void>((resolve, reject) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-spawn-timeout-'));
    profilesDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, 'coding.md'), CODING_PROFILE_MD);

    _resetConfigForTesting();
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    loadConfig(tmpDir);
    setProfilesDir(profilesDir);

    server = http.createServer((inReq, res) => {
      const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
      handleAgentsRoute(inReq, res, url.pathname).then(handled => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      });
    });

    server.listen(TEST_PORT, '127.0.0.1', () => resolve());
    server.on('error', reject);
  }));

  after(() => new Promise<void>((resolve) => {
    _setSpawnFnForTesting(null);
    server.close(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve();
    });
  }));

  beforeEach(() => {
    capturedRequests = [];
    _setSpawnFnForTesting(async (req) => {
      capturedRequests.push(req);
      return { jobId: 'test-job-id', status: 'running' as const };
    });
  });

  afterEach(() => {
    _setSpawnFnForTesting(null);
  });

  function insertTask(id: string, timeoutSeconds: number | null): void {
    exec(
      `INSERT INTO orchestrator_tasks (id, title, status, priority, timeout_seconds, created_at, updated_at)
       VALUES (?, 'test task', 'in_progress', 0, ?, datetime('now'), datetime('now'))`,
      id, timeoutSeconds,
    );
  }

  it('task.timeout_seconds = 600 → spawnWorkerJob called with timeoutMs = 600000', async () => {
    const taskId = 'task-600s';
    insertTask(taskId, 600);

    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      task_id: taskId,
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, 600_000);
  });

  it('task.timeout_seconds = null → spawnWorkerJob called with timeoutMs = undefined (falls to default)', async () => {
    const taskId = 'task-null-timeout';
    insertTask(taskId, null);

    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      task_id: taskId,
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, undefined);
  });

  it('task.timeout_seconds = 0 → spawnWorkerJob called with timeoutMs = undefined (0 ignored)', async () => {
    const taskId = 'task-zero-timeout';
    insertTask(taskId, 0);

    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      task_id: taskId,
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, undefined);
  });

  it('task.timeout_seconds = -5 → spawnWorkerJob called with timeoutMs = undefined (negative ignored)', async () => {
    const taskId = 'task-neg-timeout';
    insertTask(taskId, -5);

    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      task_id: taskId,
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, undefined);
  });

  it('no task_id → spawnWorkerJob uses body.timeoutMs fallback (regression check)', async () => {
    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      timeoutMs: 120_000,
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, 120_000);
  });

  it('no task_id and no timeoutMs → spawnWorkerJob called with timeoutMs = undefined', async () => {
    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, undefined);
  });

  it('task_id timeout_seconds takes precedence over explicit body.timeoutMs', async () => {
    const taskId = 'task-precedence';
    insertTask(taskId, 900); // 900s = 900000ms

    const res = await request('POST', '/api/agents/spawn', {
      prompt: 'do work',
      profile: 'coding',
      task_id: taskId,
      timeoutMs: 60_000, // should be overridden by task value
    });

    assert.equal(res.status, 202);
    assert.equal(capturedRequests.length, 1);
    assert.equal(capturedRequests[0]!.timeoutMs, 900_000);
  });
});
