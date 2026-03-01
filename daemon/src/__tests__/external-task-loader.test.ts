/**
 * External task loader — tests for loading task handlers from configurable directories.
 *
 * Tests cover:
 * - Loading valid task files from a directory
 * - Handling missing directories gracefully
 * - Handling non-directory paths gracefully
 * - Handling task files without register() export
 * - Handling task files that throw on import
 * - Empty directories
 * - Multiple directories
 * - Scheduler.loadExternalTasks() integration
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';
import { loadExternalTasks } from '../automation/tasks/external-loader.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ext-task-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Create a valid external task file that registers a handler.
 */
function writeValidTaskFile(dir: string, taskName: string): string {
  const filePath = path.join(dir, `${taskName}.js`);
  fs.writeFileSync(filePath, `
export function register(scheduler) {
  scheduler.registerHandler('${taskName}', async (ctx) => {
    // External task handler for ${taskName}
  });
}
`);
  return filePath;
}

/**
 * Create an external task file without the register() export.
 */
function writeInvalidTaskFile(dir: string, name: string): string {
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, `
export function doSomethingElse() {
  return 42;
}
`);
  return filePath;
}

/**
 * Create an external task file that throws on import.
 */
function writeThrowingTaskFile(dir: string, name: string): string {
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, `
throw new Error('Module initialization failure');
`);
  return filePath;
}

/**
 * Create an external task file whose register() throws.
 */
function writeRegisterThrowsFile(dir: string, taskName: string): string {
  const filePath = path.join(dir, `${taskName}.js`);
  fs.writeFileSync(filePath, `
export function register(scheduler) {
  throw new Error('register() exploded');
}
`);
  return filePath;
}

describe('External task loader', { concurrency: 1 }, () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    setupDb();
  });

  afterEach(() => {
    scheduler?.stop();
    teardownDb();
  });

  // ── Loading valid task files ────────────────────────────────

  it('loads a valid external task file and registers handler', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeValidTaskFile(tasksDir, 'my-custom-task');

    scheduler = new Scheduler({
      tasks: [{
        name: 'my-custom-task',
        enabled: true,
        interval: '1h',
        config: {},
      }],
    });

    assert.equal(scheduler.hasHandler('my-custom-task'), false);

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.loaded.length, 1);
    assert.equal(results[0]!.loaded[0], 'my-custom-task.js');
    assert.equal(results[0]!.errors.length, 0);
    assert.equal(scheduler.hasHandler('my-custom-task'), true);
  });

  it('loads multiple valid task files from one directory', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeValidTaskFile(tasksDir, 'task-alpha');
    writeValidTaskFile(tasksDir, 'task-beta');

    scheduler = new Scheduler({
      tasks: [
        { name: 'task-alpha', enabled: true, interval: '1h', config: {} },
        { name: 'task-beta', enabled: true, interval: '1h', config: {} },
      ],
    });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 2);
    assert.ok(scheduler.hasHandler('task-alpha'));
    assert.ok(scheduler.hasHandler('task-beta'));
  });

  // ── Missing / invalid directories ──────────────────────────

  it('handles missing directory gracefully', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([missingDir], scheduler);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 0); // Missing dir is not an error, just a warning
  });

  it('handles path that is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'I am a file');

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([filePath], scheduler);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.loaded.length, 0);
  });

  // ── Empty directories ──────────────────────────────────────

  it('handles empty directory gracefully', async () => {
    const emptyDir = path.join(tmpDir, 'empty-tasks');
    fs.mkdirSync(emptyDir);

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([emptyDir], scheduler);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 0);
  });

  // ── Invalid task files ─────────────────────────────────────

  it('skips files without register() export', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeInvalidTaskFile(tasksDir, 'bad-task');

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 1);
    assert.ok(results[0]!.errors[0]!.error.includes('register()'));
  });

  it('handles files that throw on import', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeThrowingTaskFile(tasksDir, 'throwing-task');

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 1);
    assert.ok(results[0]!.errors[0]!.error.includes('Module initialization failure'));
  });

  it('handles files where register() throws', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeRegisterThrowsFile(tasksDir, 'register-throws');

    // Task must exist in scheduler config for registerHandler to work
    scheduler = new Scheduler({
      tasks: [{
        name: 'register-throws',
        enabled: true,
        interval: '1h',
        config: {},
      }],
    });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 1);
    assert.ok(results[0]!.errors[0]!.error.includes('register() exploded'));
  });

  // ── Non-.js files ignored ──────────────────────────────────

  it('ignores non-.js files', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    fs.writeFileSync(path.join(tasksDir, 'readme.md'), '# Tasks');
    fs.writeFileSync(path.join(tasksDir, 'config.json'), '{}');
    fs.writeFileSync(path.join(tasksDir, 'task.ts'), 'export function register() {}');

    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 0);
    assert.equal(results[0]!.errors.length, 0);
  });

  // ── Multiple directories ───────────────────────────────────

  it('loads from multiple directories', async () => {
    const dir1 = path.join(tmpDir, 'ext-tasks-1');
    const dir2 = path.join(tmpDir, 'ext-tasks-2');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    writeValidTaskFile(dir1, 'task-from-dir1');
    writeValidTaskFile(dir2, 'task-from-dir2');

    scheduler = new Scheduler({
      tasks: [
        { name: 'task-from-dir1', enabled: true, interval: '1h', config: {} },
        { name: 'task-from-dir2', enabled: true, interval: '1h', config: {} },
      ],
    });

    const results = await loadExternalTasks([dir1, dir2], scheduler);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.loaded.length, 1);
    assert.equal(results[1]!.loaded.length, 1);
    assert.ok(scheduler.hasHandler('task-from-dir1'));
    assert.ok(scheduler.hasHandler('task-from-dir2'));
  });

  // ── Empty dirs array ───────────────────────────────────────

  it('returns empty results for empty dirs array', async () => {
    scheduler = new Scheduler({ tasks: [] });

    const results = await loadExternalTasks([], scheduler);
    assert.equal(results.length, 0);
  });

  // ── Scheduler.loadExternalTasks() integration ──────────────

  it('Scheduler.loadExternalTasks() delegates to external loader', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeValidTaskFile(tasksDir, 'integrated-task');

    scheduler = new Scheduler({
      tasks: [{
        name: 'integrated-task',
        enabled: true,
        interval: '1h',
        config: {},
      }],
    });

    const results = await scheduler.loadExternalTasks([tasksDir]);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.loaded.length, 1);
    assert.ok(scheduler.hasHandler('integrated-task'));
  });

  // ── Mixed valid and invalid files ──────────────────────────

  it('loads valid files and skips invalid ones in same directory', async () => {
    const tasksDir = path.join(tmpDir, 'ext-tasks');
    fs.mkdirSync(tasksDir);
    writeValidTaskFile(tasksDir, 'good-task');
    writeInvalidTaskFile(tasksDir, 'no-register');
    writeThrowingTaskFile(tasksDir, 'broken-import');

    scheduler = new Scheduler({
      tasks: [{
        name: 'good-task',
        enabled: true,
        interval: '1h',
        config: {},
      }],
    });

    const results = await loadExternalTasks([tasksDir], scheduler);

    assert.equal(results[0]!.loaded.length, 1);
    assert.ok(results[0]!.loaded.includes('good-task.js'));
    assert.equal(results[0]!.errors.length, 2);
    assert.ok(scheduler.hasHandler('good-task'));
  });
});
