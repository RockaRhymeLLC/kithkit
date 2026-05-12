/**
 * Tests for calibration-hint.ts:
 *   classifyTaskType() — keyword-based classifier mirroring back-fill.py
 *   getCalibrationHint() — type-specific hint with overall fallback below MIN_SAMPLES
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, getDatabase } from '../../core/db.js';
import { classifyTaskType, getCalibrationHint } from '../calibration-hint.js';

function setup(): void {
  _resetDbForTesting();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-hint-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  const migration = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/migrations/calibration-log.sql'),
    'utf8',
  );
  getDatabase().exec(migration);
}

function seedRow(taskType: string, estimated: number, actual: number): void {
  const mult = actual / estimated;
  exec(
    `INSERT INTO orch_task_calibrations
       (orch_task_id, escalated_at, estimated_minutes, actual_minutes, task_type,
        complexity, workers_used, completion_status, estimation_method, estimate_multiplier)
     VALUES (NULL, datetime('now','-1 hour'), ?, ?, ?, 'M', 0, 'completed', 'gut', ?)`,
    estimated, actual, taskType, mult,
  );
}

describe('classifyTaskType()', () => {
  it('matches "framework" via harness/migration/endpoint keywords', () => {
    assert.equal(classifyTaskType('Build a small endpoint that adds attachment routing — schema and SQL change'), 'framework');
    assert.equal(classifyTaskType('A/B test harness for the new agent'), 'framework');
  });

  it('matches "data" via digest/report/csv keywords', () => {
    assert.equal(classifyTaskType('Daily AI Landscape Digest for today'), 'data');
    assert.equal(classifyTaskType('Pull a quick CSV report from the calibration table'), 'data');
  });

  it('matches "docs" via spec/blog/readme keywords', () => {
    assert.equal(classifyTaskType('Draft a blog post per todo #495'), 'docs');
    assert.equal(classifyTaskType('Write the design doc for v2 schema'), 'docs');
  });

  it('matches "coding" via build/implement/refactor keywords', () => {
    assert.equal(classifyTaskType('Build the new player runtime'), 'coding');
  });

  it('returns "other" when no pattern matches', () => {
    assert.equal(classifyTaskType('Just hanging out'), 'other');
  });

  it('returns "other" for empty input', () => {
    assert.equal(classifyTaskType(''), 'other');
  });
});

describe('getCalibrationHint()', () => {
  beforeEach(setup);

  it('returns null when no calibration data exists', () => {
    assert.equal(getCalibrationHint('framework'), null);
  });

  it('returns null when type cohort has fewer than MIN_SAMPLES (=3) rows AND overall is also too small', () => {
    seedRow('framework', 60, 6);
    seedRow('framework', 60, 6);
    // Only 2 framework rows, no other types — below threshold
    assert.equal(getCalibrationHint('framework'), null);
  });

  it('returns type-specific hint when cohort meets MIN_SAMPLES', () => {
    seedRow('data', 60, 12);
    seedRow('data', 60, 9);
    seedRow('data', 60, 15);
    const hint = getCalibrationHint('data');
    assert.ok(hint);
    assert.equal(hint!.taskType, 'data');
    assert.equal(hint!.n, 3);
    assert.ok(Math.abs(hint!.multiplier - 0.2) < 0.01);
    assert.match(hint!.hint, /similar data tasks \(n=3\) ran at 0\.20× of stated time budget/);
  });

  it('falls back to overall mean when type cohort is too small but overall is large enough', () => {
    seedRow('data', 60, 12);
    seedRow('docs', 30, 4);
    seedRow('coding', 60, 10);
    // Only 1 framework row → falls back to overall (3 rows)
    seedRow('framework', 60, 6);
    const hint = getCalibrationHint('framework');
    assert.ok(hint);
    // Should land on overall — n=4, all four rows
    assert.equal(hint!.taskType, 'overall');
    assert.equal(hint!.n, 4);
  });

  it('treats unknown taskType as overall', () => {
    seedRow('data', 60, 12);
    seedRow('docs', 30, 4);
    seedRow('coding', 60, 10);
    const hint = getCalibrationHint('not-a-real-type');
    assert.ok(hint);
    assert.equal(hint!.taskType, 'overall');
    assert.equal(hint!.n, 3);
  });
});
