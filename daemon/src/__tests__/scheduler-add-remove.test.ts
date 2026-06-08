/**
 * Tests for Scheduler.addTask() and Scheduler.removeTask() — dynamic hot-load API.
 *
 * Covers:
 * - addTask() is idempotent on the same task name
 * - addTask() registers a task that can have a handler attached
 * - removeTask() removes the task and clears its handler
 * - removeTask() is a no-op for unknown tasks
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-add-remove-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('Scheduler.addTask / removeTask', { concurrency: 1 }, () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    setupDb();
    scheduler = new Scheduler({ tasks: [], autoRegisterCoreTasks: false });
  });

  afterEach(() => {
    scheduler?.stop();
    teardownDb();
  });

  // ── addTask ────────────────────────────────────────────────────

  it('addTask registers a new task', () => {
    assert.equal(scheduler.getTasks().length, 0);

    scheduler.addTask({ name: 'dynamic-task', enabled: true, interval: '1h', config: {} });

    assert.equal(scheduler.getTasks().length, 1);
    assert.ok(scheduler.getTask('dynamic-task'));
  });

  it('addTask is idempotent — duplicate name does not add a second task', () => {
    scheduler.addTask({ name: 'dup-task', enabled: true, interval: '1h', config: {} });
    scheduler.addTask({ name: 'dup-task', enabled: true, interval: '2h', config: {} });

    const tasks = scheduler.getTasks().filter(t => t.name === 'dup-task');
    assert.equal(tasks.length, 1, 'Should only have one task with this name');
    // Second call is silently ignored — original schedule kept
    assert.deepEqual(tasks[0]!.schedule, { type: 'interval', ms: 3_600_000 });
  });

  it('addTask task can have a handler registered after adding', () => {
    scheduler.addTask({ name: 'handler-task', enabled: true, interval: '1h', config: {} });
    assert.equal(scheduler.hasHandler('handler-task'), false);

    scheduler.registerHandler('handler-task', async () => { /* no-op */ });
    assert.equal(scheduler.hasHandler('handler-task'), true);
  });

  it('addTask calculates nextRunAt when scheduler is already started', () => {
    scheduler.start();
    scheduler.addTask({ name: 'live-task', enabled: true, cron: '* * * * *', config: {} });

    const task = scheduler.getTask('live-task');
    assert.ok(task, 'Task should be registered');
    assert.ok(task.nextRunAt instanceof Date, 'nextRunAt should be calculated when scheduler is running');
    assert.ok(task.nextRunAt > new Date(), 'nextRunAt should be in the future');
  });

  // ── removeTask ────────────────────────────────────────────────

  it('removeTask removes the task from the scheduler', () => {
    scheduler.addTask({ name: 'removable', enabled: true, interval: '1h', config: {} });
    assert.ok(scheduler.getTask('removable'));

    scheduler.removeTask('removable');
    assert.equal(scheduler.getTask('removable'), undefined);
  });

  it('removeTask clears the registered handler', () => {
    scheduler.addTask({ name: 'handled', enabled: true, interval: '1h', config: {} });
    scheduler.registerHandler('handled', async () => { /* no-op */ });
    assert.equal(scheduler.hasHandler('handled'), true);

    scheduler.removeTask('handled');
    assert.equal(scheduler.hasHandler('handled'), false);
    assert.equal(scheduler.getTask('handled'), undefined);
  });

  it('removeTask is idempotent for unknown task names', () => {
    // Should not throw
    assert.doesNotThrow(() => {
      scheduler.removeTask('does-not-exist');
    });
  });

  // ── addTask + removeTask round-trip ─────────────────────────

  it('add → remove → add re-registers a task cleanly', () => {
    scheduler.addTask({ name: 'round-trip', enabled: true, interval: '1h', config: {} });
    scheduler.registerHandler('round-trip', async () => { /* no-op */ });
    scheduler.removeTask('round-trip');

    assert.equal(scheduler.getTask('round-trip'), undefined);
    assert.equal(scheduler.hasHandler('round-trip'), false);

    // Re-add — should work without error
    scheduler.addTask({ name: 'round-trip', enabled: true, interval: '2h', config: {} });
    assert.ok(scheduler.getTask('round-trip'));
    assert.deepEqual(scheduler.getTask('round-trip')!.schedule, { type: 'interval', ms: 7_200_000 });
  });
});
