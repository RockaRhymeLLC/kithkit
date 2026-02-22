/**
 * t-149, t-150, t-151, t-152: Scheduler engine
 *
 * Tests cron/interval scheduling, config reload, manual trigger, and task execution.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { openDatabase, closeDatabase, query } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';
import { getTaskHistory, type TaskResult } from '../automation/task-runner.js';
import { handleTasksRoute, setScheduler } from '../api/tasks.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sched-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Scheduler Engine', { concurrency: 1 }, () => {

  // ── t-149: Cron-scheduled task runs on schedule ────────────

  describe('Cron scheduling (t-149)', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      setupDb();
    });

    afterEach(() => {
      scheduler?.stop();
      teardownDb();
    });

    it('registers a cron task', () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'cron-test',
          enabled: true,
          cron: '* * * * *',
          config: { command: 'echo cron-ok' },
        }],
      });

      const tasks = scheduler.getTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.name, 'cron-test');
      assert.deepEqual(tasks[0]!.schedule, { type: 'cron', expression: '* * * * *' });
    });

    it('calculates next run time for cron task', () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'cron-next',
          enabled: true,
          cron: '* * * * *',
          config: { command: 'echo ok' },
        }],
      });

      scheduler.start();
      const task = scheduler.getTask('cron-next');
      assert.ok(task?.nextRunAt, 'Should have a next run time');
      assert.ok(task.nextRunAt instanceof Date, 'nextRunAt should be a Date');
      assert.ok(task.nextRunAt > new Date(), 'nextRunAt should be in the future');
    });

    it('executes cron task and stores result', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'cron-exec',
          enabled: true,
          cron: '* * * * *',
          config: { command: 'echo cron-ran' },
        }],
      });

      // Trigger manually (don't wait for minute boundary)
      const result = await scheduler.triggerTask('cron-exec');
      assert.equal(result.task_name, 'cron-exec');
      assert.equal(result.status, 'success');
      assert.ok(result.output?.includes('cron-ran'));
      assert.ok(result.duration_ms >= 0);
      assert.ok(result.started_at);
      assert.ok(result.finished_at);
    });

    it('stores task result in task_results table', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'cron-db',
          enabled: true,
          cron: '* * * * *',
          config: { command: 'echo db-check' },
        }],
      });

      await scheduler.triggerTask('cron-db');

      const rows = query<TaskResult>(
        'SELECT * FROM task_results WHERE task_name = ?',
        'cron-db',
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'success');
      assert.ok(rows[0]!.output?.includes('db-check'));
      assert.ok(rows[0]!.duration_ms! >= 0);
    });
  });

  // ── t-150: Interval-scheduled task runs repeatedly ─────────

  describe('Interval scheduling (t-150)', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      setupDb();
    });

    afterEach(() => {
      scheduler?.stop();
      teardownDb();
    });

    it('registers an interval task', () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'interval-test',
          enabled: true,
          interval: '5s',
          config: { command: 'echo interval-ok' },
        }],
      });

      const tasks = scheduler.getTasks();
      assert.equal(tasks.length, 1);
      assert.deepEqual(tasks[0]!.schedule, { type: 'interval', ms: 5000 });
    });

    it('runs interval task multiple times', async () => {
      let completions = 0;
      scheduler = new Scheduler({
        tasks: [{
          name: 'interval-repeat',
          enabled: true,
          interval: '1s',
          config: { command: 'echo run' },
        }],
        tickIntervalMs: 200,
        onTaskComplete: () => { completions++; },
      });

      scheduler.start();

      // Wait for at least 2 runs (1s interval + tick time)
      await sleep(2800);

      assert.ok(completions >= 2, `Expected at least 2 completions, got ${completions}`);

      // Verify in DB
      const history = getTaskHistory('interval-repeat');
      assert.ok(history.length >= 2, `Expected at least 2 history records, got ${history.length}`);
    });

    it('calculates next run from last run time', () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'interval-next',
          enabled: true,
          interval: '10s',
          config: { command: 'echo ok' },
        }],
      });

      scheduler.start();
      const task = scheduler.getTask('interval-next');
      assert.ok(task?.nextRunAt, 'Should have a next run time');

      // Next run should be ~10s from now
      const diff = task.nextRunAt.getTime() - Date.now();
      assert.ok(diff > 5000 && diff <= 11000, `Next run should be ~10s away, got ${diff}ms`);
    });
  });

  // ── t-151: Task auto-discovery from config changes ─────────

  describe('Config reload (t-151)', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      setupDb();
    });

    afterEach(() => {
      scheduler?.stop();
      teardownDb();
    });

    it('starts with 2 tasks', () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
          { name: 'task-b', enabled: true, cron: '0 * * * *', config: { command: 'echo b' } },
        ],
      });

      assert.equal(scheduler.getTasks().length, 2);
    });

    it('adds new task via reload', () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
          { name: 'task-b', enabled: true, cron: '0 * * * *', config: { command: 'echo b' } },
        ],
      });

      scheduler.start();

      // Reload with 3 tasks
      scheduler.reload([
        { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
        { name: 'task-b', enabled: true, cron: '0 * * * *', config: { command: 'echo b' } },
        { name: 'task-c', enabled: true, interval: '3m', config: { command: 'echo c' } },
      ]);

      const tasks = scheduler.getTasks();
      assert.equal(tasks.length, 3);
      assert.ok(tasks.find(t => t.name === 'task-c'), 'New task should exist');
    });

    it('removes deleted task via reload', () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
          { name: 'task-b', enabled: true, cron: '0 * * * *', config: { command: 'echo b' } },
        ],
      });

      scheduler.reload([
        { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
      ]);

      const tasks = scheduler.getTasks();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.name, 'task-a');
    });

    it('updates existing task config via reload', () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo old' } },
        ],
      });

      scheduler.reload([
        { name: 'task-a', enabled: false, interval: '5m', config: { command: 'echo new' } },
      ]);

      const task = scheduler.getTask('task-a');
      assert.equal(task?.enabled, false);
      assert.equal(task?.command, 'echo new');
    });

    it('new task gets nextRunAt when scheduler is running', () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
        ],
      });

      scheduler.start();

      scheduler.reload([
        { name: 'task-a', enabled: true, interval: '5m', config: { command: 'echo a' } },
        { name: 'task-new', enabled: true, interval: '10s', config: { command: 'echo new' } },
      ]);

      const newTask = scheduler.getTask('task-new');
      assert.ok(newTask?.nextRunAt, 'New task should have nextRunAt set');
    });
  });

  // ── t-152: Manual task trigger via API ─────────────────────

  describe('Manual trigger and Tasks API (t-152)', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
      setupDb();
    });

    afterEach(() => {
      scheduler?.stop();
      teardownDb();
    });

    it('triggerTask runs immediately and returns result', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'manual-test',
          enabled: true,
          interval: '1h',
          config: { command: 'echo manual-trigger' },
        }],
      });

      const result = await scheduler.triggerTask('manual-test');
      assert.equal(result.status, 'success');
      assert.ok(result.output?.includes('manual-trigger'));
    });

    it('triggerTask throws for unknown task', async () => {
      scheduler = new Scheduler({ tasks: [] });

      await assert.rejects(
        () => scheduler.triggerTask('nonexistent'),
        (err: Error) => {
          assert.ok(err.message.includes('not found'));
          return true;
        },
      );
    });

    it('captures failed task output', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'fail-test',
          enabled: true,
          interval: '1h',
          config: { command: 'echo error-output && exit 1' },
        }],
      });

      const result = await scheduler.triggerTask('fail-test');
      assert.equal(result.status, 'failure');
      assert.ok(result.output?.includes('error-output'));
    });

    it('disabled task still triggerable manually', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'disabled-trigger',
          enabled: false,
          interval: '1h',
          config: { command: 'echo disabled-but-ran' },
        }],
      });

      const result = await scheduler.triggerTask('disabled-trigger');
      assert.equal(result.status, 'success');
      assert.ok(result.output?.includes('disabled-but-ran'));
    });

    it('task history returns execution records', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'history-test',
          enabled: true,
          interval: '1h',
          config: { command: 'echo history-item' },
        }],
      });

      await scheduler.triggerTask('history-test');
      await scheduler.triggerTask('history-test');

      const history = getTaskHistory('history-test');
      assert.equal(history.length, 2);
      assert.equal(history[0]!.task_name, 'history-test');
    });

    // API route tests
    it('GET /api/tasks returns task list', async () => {
      scheduler = new Scheduler({
        tasks: [
          { name: 'api-task-1', enabled: true, interval: '5m', config: { command: 'echo 1' } },
          { name: 'api-task-2', enabled: false, cron: '0 * * * *', config: { command: 'echo 2' } },
        ],
      });
      setScheduler(scheduler);

      const { status, body } = await fakeRequest('GET', '/api/tasks');
      assert.equal(status, 200);
      assert.equal(body.data.length, 2);
      assert.equal(body.data[0].name, 'api-task-1');
      assert.equal(body.data[1].enabled, false);
      assert.ok(body.timestamp);
    });

    it('POST /api/tasks/:name/run triggers task', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'api-run',
          enabled: true,
          interval: '1h',
          config: { command: 'echo api-triggered' },
        }],
      });
      setScheduler(scheduler);

      const { status, body } = await fakeRequest('POST', '/api/tasks/api-run/run');
      assert.equal(status, 200);
      assert.equal(body.data.status, 'success');
      assert.ok(body.data.output.includes('api-triggered'));
    });

    it('POST /api/tasks/:name/run returns 404 for unknown task', async () => {
      scheduler = new Scheduler({ tasks: [] });
      setScheduler(scheduler);

      const { status, body } = await fakeRequest('POST', '/api/tasks/nope/run');
      assert.equal(status, 404);
      assert.ok(body.error.includes('not found'));
    });

    it('GET /api/tasks/:name/history returns history', async () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'api-history',
          enabled: true,
          interval: '1h',
          config: { command: 'echo hist' },
        }],
      });
      setScheduler(scheduler);

      await scheduler.triggerTask('api-history');

      const { status, body } = await fakeRequest('GET', '/api/tasks/api-history/history');
      assert.equal(status, 200);
      assert.equal(body.data.length, 1);
    });

    it('scheduler start/stop lifecycle', () => {
      scheduler = new Scheduler({
        tasks: [{
          name: 'lifecycle',
          enabled: true,
          interval: '5m',
          config: { command: 'echo ok' },
        }],
      });

      assert.equal(scheduler.isRunning(), false);
      scheduler.start();
      assert.equal(scheduler.isRunning(), true);
      scheduler.stop();
      assert.equal(scheduler.isRunning(), false);
    });

    it('throws for task without cron or interval', () => {
      assert.throws(
        () => new Scheduler({
          tasks: [{ name: 'bad-task', enabled: true, config: { command: 'echo bad' } }],
        }),
        (err: Error) => {
          assert.ok(err.message.includes('must have either cron or interval'));
          return true;
        },
      );
    });
  });
});

// ── Fake HTTP request helper ─────────────────────────────────

async function fakeRequest(
  method: string,
  pathname: string,
  body?: unknown,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    const fakeRes = {
      statusCode: 0,
      _headers: {} as Record<string, string>,
      headersSent: false,
    };
    const res = Object.assign(fakeRes, {
      writeHead(status: number, headers?: Record<string, string>) {
        fakeRes.statusCode = status;
        if (headers) Object.assign(fakeRes._headers, headers);
        fakeRes.headersSent = true;
        return res;
      },
      setHeader(name: string, value: string) {
        fakeRes._headers[name] = value;
      },
      end(data?: string) {
        if (data) chunks.push(Buffer.from(data));
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: fakeRes.statusCode,
          body: raw ? JSON.parse(raw) : {},
        });
      },
    }) as unknown as http.ServerResponse;

    const bodyStr = body ? JSON.stringify(body) : '';
    const req = {
      method,
      url: pathname,
      headers: { 'content-type': 'application/json' },
      on(event: string, cb: (data?: unknown) => void) {
        if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr));
        if (event === 'end') cb();
        return this;
      },
    } as unknown as http.IncomingMessage;

    handleTasksRoute(req, res, pathname);
  });
}
