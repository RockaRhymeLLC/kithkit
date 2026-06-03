/**
 * Regression test: task-queue.ts tmux injector seam.
 *
 * Verifies that _setTmuxInjectorForTesting correctly intercepts all injectMessage
 * calls made by task-queue route handlers, and that the real injectMessage in
 * tmux.ts is NOT called when the stub is active.
 *
 * Exercises the terminal-status notification path (line ~1086 in task-queue.ts)
 * which fires injectMessage('comms', ...) on every terminal transition.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import {
  handleTaskQueueRoute,
  _setTmuxInjectorForTesting,
  _setEvaluateTaskFnForTesting,
} from '../task-queue.js';
import { _getInjectionAttempts, _resetInjectionAttempts } from '../../agents/tmux.js';

const TEST_PORT = 19879;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

let server: http.Server;
let tmpDir: string;

describe('task-queue tmux seam', () => {
  before((): Promise<void> => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-tq-seam-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    _setEvaluateTaskFnForTesting(async () => {});

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
  });

  after((): Promise<void> => {
    _setEvaluateTaskFnForTesting(null);
    _setTmuxInjectorForTesting(null);
    _resetInjectionAttempts();
    _resetDbForTesting();
    return new Promise<void>((resolve) => {
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
  });

  it('stub intercepts injectMessage on terminal transition; real injectMessage not called', async () => {
    // Arrange: install counter stub and reset the real tmux injection counter
    let stubCallCount = 0;
    _setTmuxInjectorForTesting((_agentId: string, _text: string) => {
      stubCallCount++;
      return false;
    });
    _resetInjectionAttempts();

    // Act: create a task, then transition it to a terminal state (pending → failed)
    const createRes = await request('POST', '/api/orchestrator/tasks', {
      title: 'Seam regression test task',
    });
    assert.equal(createRes.status, 201, `create task: expected 201, got ${createRes.status}: ${createRes.body}`);

    const created = JSON.parse(createRes.body) as { id: string; external_id?: string };
    const taskId = created.external_id ?? created.id;

    const failRes = await request('PUT', `/api/orchestrator/tasks/${taskId}`, {
      status: 'failed',
      error: 'seam test',
    });
    assert.equal(failRes.status, 200, `fail task: expected 200, got ${failRes.status}: ${failRes.body}`);

    // Assert: stub was called at least once (seam intercepted the terminal notification)
    assert.ok(stubCallCount > 0, `expected stub to be called at least once, got ${stubCallCount}`);

    // Assert: real injectMessage in tmux.ts was NOT called
    assert.equal(
      _getInjectionAttempts(),
      0,
      `expected 0 real tmux injection attempts, got ${_getInjectionAttempts()}`,
    );
  });
});
