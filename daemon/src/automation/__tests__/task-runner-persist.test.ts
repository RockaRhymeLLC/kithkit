/**
 * task-runner persistResult regression tests
 *
 * Covers:
 *   (a) persistResult stores and returns the actual inserted row (id > 0)
 *   (b) rows are fetched by lastInsertRowid — two results for the same
 *       task name don't read each other's rows
 *   (c) persistResult never throws when the DB is unavailable — returns a
 *       synthetic id=-1 result instead (previously runTask's promise could
 *       hang forever on a DB write failure)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase } from '../../core/db.js';
import { persistResult, type TaskResult } from '../task-runner.js';

let tmpDir: string;

describe('task-runner persistResult', { concurrency: 1 }, () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-taskrunner-test-'));
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try { closeDatabase(); } catch { /* already closed by test (c) */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a) returns the stored row with a real id', () => {
    const ts = new Date().toISOString();
    const result = persistResult('persist-test-a', 'success', 'hello', 42, ts, ts);

    assert.ok(result.id > 0, `expected a real row id, got ${result.id}`);
    assert.equal(result.task_name, 'persist-test-a');
    assert.equal(result.status, 'success');
    assert.equal(result.output, 'hello');
    assert.equal(result.duration_ms, 42);
  });

  it('(b) same-named results each get their own row (fetch by rowid, not latest-by-name)', () => {
    const ts = new Date().toISOString();
    const first = persistResult('persist-test-b', 'success', 'first', 1, ts, ts);
    const second = persistResult('persist-test-b', 'failure', 'second', 2, ts, ts);

    assert.notEqual(first.id, second.id, 'rows must be distinct');
    assert.equal(first.output, 'first');
    assert.equal(second.output, 'second');
    assert.equal(first.status, 'success');
    assert.equal(second.status, 'failure');
  });

  it('(c) never throws when the DB is unavailable — returns synthetic id=-1', () => {
    closeDatabase();

    const ts = new Date().toISOString();
    let result: TaskResult | undefined;
    assert.doesNotThrow(() => {
      result = persistResult('persist-test-c', 'failure', 'db gone', 5, ts, ts);
    });
    assert.ok(result, 'must still return a result');
    assert.equal(result!.id, -1, 'synthetic result must carry id=-1');
    assert.equal(result!.task_name, 'persist-test-c');
    assert.equal(result!.status, 'failure');
  });
});
