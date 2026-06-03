/**
 * JobsWatcher — integration tests for hot-loading scheduled job files.
 *
 * Covers:
 * - Add: register-shape file dropped → handler registered within 500ms
 * - Change: file rewritten → NEW handler active (cache-bust verified)
 * - Unlink: file removed → handler and task removed
 * - Default-export shape: defineTask pattern correctly adapted
 * - Broken file: import throws → daemon doesn't crash; error logged
 * - Non-existent directory → no-op (opt-in feature)
 *
 * Each test uses a unique temp directory and cleans up after itself.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../core/db.js';
import { Scheduler } from '../automation/scheduler.js';
import { JobsWatcher } from '../automation/jobs-watcher.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-jobs-watcher-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Debounce (300ms) + file system propagation headroom = 500ms */
const SETTLE_MS = 500;

/** Write a Shape A (register function) task file. */
function writeRegisterFile(dir: string, taskName: string): void {
  fs.writeFileSync(path.join(dir, `${taskName}.js`), `
export function register(scheduler) {
  scheduler.registerHandler('${taskName}', async (ctx) => 'register-v1');
}
`);
}

/** Write a Shape B (default export) task file returning a given output string. */
function writeDefaultExportFile(dir: string, taskName: string, output: string, scheduleMs = 3_600_000): void {
  fs.writeFileSync(path.join(dir, `${taskName}.js`), `
export default {
  name: '${taskName}',
  schedule: { type: 'interval', ms: ${scheduleMs} },
  async run(ctx) { return '${output}'; },
};
`);
}

/** Write a file that throws on import. */
function writeBrokenFile(dir: string, taskName: string): void {
  fs.writeFileSync(path.join(dir, `${taskName}.js`), `
throw new Error('Broken module — import should fail gracefully');
`);
}

describe('JobsWatcher', { concurrency: 1 }, () => {
  let scheduler: Scheduler;
  let watcher: JobsWatcher;
  let watchDir: string;
  let logDir: string;

  beforeEach(() => {
    setupDb();
    watchDir = path.join(tmpDir, 'scheduled-jobs');
    logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(watchDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    scheduler = new Scheduler({ tasks: [], autoRegisterCoreTasks: false });
  });

  afterEach(() => {
    watcher?.stop();
    scheduler?.stop();
    teardownDb();
  });

  // ── Add (Shape A — register function) ─────────────────────────

  it('registers handler when a register-shape .js file is added', async () => {
    // Pre-configure the task in the scheduler (required for Shape A registerHandler)
    scheduler.addTask({ name: 'hot-register-task', enabled: true, interval: '1h', config: {} });

    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    writeRegisterFile(watchDir, 'hot-register-task');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('hot-register-task'), true, 'Handler should be registered after file add');
  });

  // ── Add (Shape B — default export) ────────────────────────────

  it('registers task and handler when a default-export (defineTask) file is added', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    writeDefaultExportFile(watchDir, 'auto-task', 'initial-output');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('auto-task'), true, 'Handler should be registered');
    assert.ok(scheduler.getTask('auto-task'), 'Task should exist in scheduler');
  });

  // ── Change ─────────────────────────────────────────────────────

  it('reloads with fresh handler when a file is changed (cache-bust verified)', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    // Drop v1
    writeDefaultExportFile(watchDir, 'changing-task', 'v1-output');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('changing-task'), true, 'v1 handler should be registered');

    const r1 = await scheduler.triggerTask('changing-task');
    assert.equal(r1.output, 'v1-output', 'v1 handler should produce v1-output');

    // Overwrite with v2 — fs.writeFileSync updates mtime → different cache-bust key
    writeDefaultExportFile(watchDir, 'changing-task', 'v2-output');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('changing-task'), true, 'v2 handler should be registered after reload');

    const r2 = await scheduler.triggerTask('changing-task');
    assert.equal(r2.output, 'v2-output', 'New handler (v2) should run after file change');
  });

  // ── Unlink ────────────────────────────────────────────────────

  it('removes task and handler when the file is deleted', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    writeDefaultExportFile(watchDir, 'ephemeral-task', 'some-output');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('ephemeral-task'), true, 'Handler should exist before deletion');

    fs.unlinkSync(path.join(watchDir, 'ephemeral-task.js'));
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('ephemeral-task'), false, 'Handler should be gone after file deletion');
    assert.equal(scheduler.getTask('ephemeral-task'), undefined, 'Task should be removed after file deletion');
  });

  // ── Broken file (import throws) ────────────────────────────────

  it('does not crash when a broken file is added; logs the error', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    writeBrokenFile(watchDir, 'broken-job');
    await sleep(SETTLE_MS);

    // Daemon must not have crashed — we're still here
    assert.equal(scheduler.hasHandler('broken-job'), false, 'No handler should be registered for a broken file');

    // Error should be logged to logs/agent-tasks/broken-job.log
    const logFile = path.join(logDir, 'agent-tasks', 'broken-job.log');
    assert.ok(fs.existsSync(logFile), 'Error log file should exist');
    const logContent = fs.readFileSync(logFile, 'utf8');
    assert.ok(logContent.includes('ERROR'), 'Log should contain ERROR marker');
  });

  // ── Non-existent directory — opt-in no-op ─────────────────────

  it('is a no-op when the watched directory does not exist', async () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');

    watcher = new JobsWatcher(scheduler, missingDir, 300, logDir);
    // Should not throw
    assert.doesNotThrow(() => watcher.start());

    // Scheduler should remain empty
    assert.equal(scheduler.getTasks().length, 0);
  });

  // ── Initial scan ──────────────────────────────────────────────

  it('loads pre-existing files on start (initial scan)', async () => {
    // Drop file BEFORE starting the watcher
    writeDefaultExportFile(watchDir, 'pre-existing', 'pre-output');

    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    // Initial scan is synchronous scan, async load — wait for it
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('pre-existing'), true, 'Pre-existing file should be loaded on start');
  });

  // ── .ts files ignored with warning ───────────────────────────

  it('ignores .ts files in the watched directory', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();

    fs.writeFileSync(path.join(watchDir, 'not-supported.ts'), 'export function register(s) {}');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.getTasks().length, 0, 'TypeScript file should not be loaded');
  });

  // ── stop() cleans up ──────────────────────────────────────────

  it('stop() prevents further events from being processed', async () => {
    watcher = new JobsWatcher(scheduler, watchDir, 300, logDir);
    watcher.start();
    watcher.stop();

    // Drop a file AFTER stopping — should not be picked up
    writeDefaultExportFile(watchDir, 'after-stop-task', 'output');
    await sleep(SETTLE_MS);

    assert.equal(scheduler.hasHandler('after-stop-task'), false, 'File added after stop() should not be loaded');
  });
});
