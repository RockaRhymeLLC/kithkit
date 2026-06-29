/**
 * morning-briefing — todo-bounding tests (t-briefing-bound)
 *
 * Verifies that gatherTodos():
 *   - Caps at TODO_CAP (20) items when >20 open todos exist, appending a
 *     "+N more open todos" summary line with the correct remainder count.
 *   - Shows all todos when <=cap, with no summary line.
 *   - Excludes 'done' and 'cancelled' todos.
 *   - Returns the empty sentinel when the table has no open rows.
 *
 * Uses a real (in-memory) test DB per the project's existing test pattern.
 * NODE_ENV=test is set by the test runner, so injectText is unconditionally
 * suppressed — no live session can be touched.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../../../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../../../core/config.js';
import { gatherTodos } from '../morning-briefing.js';

// ── Shared helpers ────────────────────────────────────────────

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-briefing-test-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks: []
`);
  _resetConfigForTesting();
  loadConfig(tmpDir);
  _resetDbForTesting();
  openDatabase(tmpDir);
}

function teardownDb(): void {
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function seedTodo(
  title: string,
  priority: string = 'medium',
  status: string = 'pending',
): void {
  exec(
    `INSERT INTO tasks (kind, title, priority, status) VALUES ('todo', ?, ?, ?)`,
    title,
    priority,
    status,
  );
}

// ── Tests ─────────────────────────────────────────────────────

describe('morning-briefing gatherTodos — todo bounding (t-briefing-bound)', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('>20 open todos → exactly 20 rendered + correct "+N more open todos" summary', () => {
    const TOTAL = 25;
    const CAP = 20;
    for (let i = 0; i < TOTAL; i++) {
      seedTodo(`Todo item ${i}`, 'medium', 'pending');
    }

    const result = gatherTodos();
    const lines = result.split('\n');

    const bulletLines = lines.filter(l => l.startsWith('• '));
    assert.equal(
      bulletLines.length,
      CAP,
      `Expected exactly ${CAP} bullet lines, got ${bulletLines.length}`,
    );

    const summaryLine = lines.find(l => l.startsWith('+'));
    assert.ok(summaryLine, 'Summary line should exist when over cap');
    assert.equal(
      summaryLine,
      `+${TOTAL - CAP} more open todos`,
      'Summary line should show correct remainder count',
    );
  });

  it('exactly at cap (20) → all shown, no summary line', () => {
    for (let i = 0; i < 20; i++) {
      seedTodo(`Todo ${i}`, 'medium', 'pending');
    }

    const result = gatherTodos();
    const lines = result.split('\n');

    const bulletLines = lines.filter(l => l.startsWith('• '));
    assert.equal(bulletLines.length, 20, 'All 20 todos should be shown at exactly cap');

    const summaryLine = lines.find(l => l.startsWith('+'));
    assert.equal(summaryLine, undefined, 'No summary line when at exactly cap');
  });

  it('<= cap (15 todos) → all shown, no summary line', () => {
    for (let i = 0; i < 15; i++) {
      seedTodo(`Task ${i}`, 'medium', 'pending');
    }

    const result = gatherTodos();
    const lines = result.split('\n');

    const bulletLines = lines.filter(l => l.startsWith('• '));
    assert.equal(bulletLines.length, 15, 'All 15 todos should be shown');

    const summaryLine = lines.find(l => l.startsWith('+'));
    assert.equal(summaryLine, undefined, 'No summary line when under cap');
  });

  it('"+N more open todos" has the correct N when total is 27', () => {
    const TOTAL = 27;
    const CAP = 20;
    const EXPECTED_REMAINDER = TOTAL - CAP;
    for (let i = 0; i < TOTAL; i++) {
      seedTodo(`Todo ${i}`, 'low', 'pending');
    }

    const result = gatherTodos();
    const summaryLine = result.split('\n').find(l => l.startsWith('+'));
    assert.ok(summaryLine, 'Summary line must be present');
    assert.equal(summaryLine, `+${EXPECTED_REMAINDER} more open todos`);
  });

  it('done and cancelled todos are excluded from the count and display', () => {
    seedTodo('Active pending', 'high', 'pending');
    seedTodo('Active in_progress', 'medium', 'in_progress');
    seedTodo('Completed — should be hidden', 'high', 'completed');
    seedTodo('Cancelled — should be hidden', 'low', 'cancelled');

    const result = gatherTodos();
    const lines = result.split('\n');
    const bulletLines = lines.filter(l => l.startsWith('• '));

    // Only the 2 open ones should appear
    assert.equal(bulletLines.length, 2, 'Only non-done, non-cancelled todos shown');
    assert.ok(!result.includes('Completed — should be hidden'), 'Completed todo must not appear');
    assert.ok(!result.includes('Cancelled — should be hidden'), 'Cancelled todo must not appear');
  });

  it('zero open todos → returns "No open todos." sentinel', () => {
    // Seed only closed todos — nothing open
    seedTodo('Already completed', 'medium', 'completed');

    const result = gatherTodos();
    assert.equal(result, 'No open todos.');
  });

  it('empty table → returns "No open todos." sentinel', () => {
    const result = gatherTodos();
    assert.equal(result, 'No open todos.');
  });
});
