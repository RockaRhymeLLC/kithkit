/**
 * t-catchup-guard: Persistent (restart-safe) catch-up guard regression tests
 *
 * Covers the bug introduced in commit 4aab8f15 where _detectAndFireCatchUp
 * used the in-memory lastRunAt (null on every restart) instead of a
 * persistent DB-backed guard. After any daemon restart, tasks whose
 * prev() occurrence fell within the 2-hour window would re-fire even if
 * they had already run that day.
 *
 * Tests:
 *   (a) THE REGRESSION — hasRunSince returns true → catch-up must NOT fire
 *   (b) hasRunSince returns false → catch-up MUST fire
 *   (c) hasRunSince not injected → falls back to lastRunAt (unchanged behaviour)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../core/db.js';
import { Scheduler } from '../scheduler.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-catchguard-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Catch-up persistent guard (t-catchup-guard)', { concurrency: 1 }, () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    setupDb();
  });

  afterEach(() => {
    scheduler?.stop();
    teardownDb();
  });

  // ── (a) THE REGRESSION ───────────────────────────────────────
  // Scenario: daemon just restarted. lastRunAt is null (in-memory only,
  // reset to null on every _loadTasks). The task DID already run for this
  // occurrence (ai-landscape-digest scenario — ran at 11:30, restart at 13:07).
  // hasRunSince returns true → catch-up must NOT fire.
  it('(a) does NOT fire catch-up when hasRunSince reports task already ran (restart-safe guard)', async () => {
    let completions = 0;
    // Stub: always says "yes, it already ran since that occurrence"
    const hasRunSince = (_taskName: string, _since: Date): boolean => true;

    scheduler = new Scheduler({
      tasks: [{
        name: 'catchup-guard-already-ran',
        enabled: true,
        // every minute — prev() is <1 min ago, well within the 2h window
        cron: '* * * * *',
        config: {},
      }],
      onTaskComplete: () => { completions++; },
      hasRunSince,
      autoRegisterCoreTasks: false,
    });
    scheduler.registerHandler('catchup-guard-already-ran', async () => {});
    // lastRunAt is null (simulating a fresh restart — the bug condition)
    assert.equal(scheduler.getTask('catchup-guard-already-ran')!.lastRunAt, null,
      'Precondition: lastRunAt must be null to reproduce the restart scenario');

    scheduler.start();
    await sleep(300);
    assert.equal(completions, 0,
      'Catch-up must NOT fire when hasRunSince() returns true (task already ran this occurrence)');
  });

  // ── (b) missed and not yet run → catch-up fires ───────────────
  // Scenario: daemon restarted, task genuinely missed (hasRunSince returns false).
  // Catch-up should fire exactly once.
  it('(b) fires catch-up when missed within window and hasRunSince returns false', async () => {
    let completions = 0;
    // Stub: always says "no, hasn't run since that occurrence"
    const hasRunSince = (_taskName: string, _since: Date): boolean => false;

    scheduler = new Scheduler({
      tasks: [{
        name: 'catchup-guard-missed',
        enabled: true,
        cron: '* * * * *', // prev() <1 min ago, within 2h window
        config: {},
      }],
      onTaskComplete: () => { completions++; },
      hasRunSince,
      autoRegisterCoreTasks: false,
    });
    scheduler.registerHandler('catchup-guard-missed', async () => {});
    scheduler.start();
    await sleep(500);
    assert.ok(completions >= 1,
      `Catch-up must fire when hasRunSince() returns false, got ${completions} completions`);
  });

  // ── (c) hasRunSince not injected → falls back to lastRunAt ───────
  // When hasRunSince is omitted, the old in-memory guard must still work
  // so existing unit tests that don't inject it are not broken.
  it('(c) falls back to lastRunAt guard when hasRunSince is not injected', async () => {
    let completions = 0;
    scheduler = new Scheduler({
      tasks: [{
        name: 'catchup-guard-fallback',
        enabled: true,
        cron: '* * * * *', // prev() <1 min ago
        config: {},
      }],
      onTaskComplete: () => { completions++; },
      // hasRunSince intentionally omitted
      autoRegisterCoreTasks: false,
    });
    scheduler.registerHandler('catchup-guard-fallback', async () => {});

    // Set lastRunAt to NOW — should suppress the catch-up (same as old test (c))
    scheduler.getTask('catchup-guard-fallback')!.lastRunAt = new Date();
    scheduler.start();
    await sleep(300);
    assert.equal(completions, 0,
      'lastRunAt fallback must suppress catch-up when lastRunAt >= prevOccurrence');
  });
});
