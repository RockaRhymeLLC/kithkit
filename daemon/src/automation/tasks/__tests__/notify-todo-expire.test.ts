/**
 * Tests for notify-todo-expire scheduler handler.
 *
 * Covers:
 *   - by-date-passed NOTIFY todo expires when due_date is in the past
 *   - untouched NOTIFY older than TTL expires
 *   - touched/updated todo does NOT expire (has non-'created' task_action)
 *   - financial/urgent todos are protected (never auto-expired)
 *   - real user work todos (NULL source, non-auto source) are never targeted
 *   - dry_run=true: no DB changes made
 *   - enabled=false: no changes at all
 *   - mutation kill: protection guard prevents expiry of financial-keyword todos
 *
 * Uses a real (in-memory) test DB via openDatabase(tmpDir).
 * The tasks table is created by migration 024 (run by openDatabase).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query } from '../../../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../../../core/config.js';
import { _runForTesting, PROTECTED_FINANCIAL_KEYWORDS } from '../notify-todo-expire.js';

// ── Test harness ──────────────────────────────────────────────

let tmpDir: string;

function setupTestEnv(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-notify-expire-'));
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

  // Disable FK constraints for simpler test seeding
  try {
    exec('PRAGMA foreign_keys = OFF');
  } catch {
    // best-effort
  }
}

function cleanupTestEnv(): void {
  _resetDbForTesting();
  _resetConfigForTesting();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Seed helpers ──────────────────────────────────────────────

interface SeedOpts {
  title?: string;
  source?: string | null;
  priority?: string;
  status?: string;
  due_date?: string | null;
  daysAgo?: number;
}

/**
 * Seed a todo into the unified tasks table.
 * Returns the inserted row id.
 */
function seedTodo(opts: SeedOpts = {}): number {
  const title = opts.title ?? 'Test NOTIFY todo';
  const source = opts.source !== undefined ? opts.source : 'auto:notify';
  const priority = opts.priority ?? 'medium';
  const status = opts.status ?? 'pending';
  const daysAgo = opts.daysAgo ?? 0;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const updatedAt = createdAt;

  if (source === null) {
    exec(
      `INSERT INTO tasks (kind, title, priority, status, created_at, updated_at) VALUES ('todo', ?, ?, ?, ?, ?)`,
      title, priority, status, createdAt, updatedAt,
    );
  } else {
    exec(
      `INSERT INTO tasks (kind, title, source, priority, status, created_at, updated_at) VALUES ('todo', ?, ?, ?, ?, ?, ?)`,
      title, source, priority, status, createdAt, updatedAt,
    );
  }

  if (opts.due_date !== undefined && opts.due_date !== null) {
    const rows = query<{ id: number }>(
      `SELECT id FROM tasks WHERE kind='todo' AND title=? ORDER BY id DESC LIMIT 1`,
      title,
    );
    const id = rows[0]?.id;
    if (id != null) {
      exec(`UPDATE tasks SET due_date=? WHERE id=?`, opts.due_date, id);
    }
  }

  const rows = query<{ id: number }>(
    `SELECT id FROM tasks WHERE kind='todo' AND title=? ORDER BY id DESC LIMIT 1`,
    title,
  );
  const id = rows[0]?.id;
  if (id == null) throw new Error(`Failed to seed todo: ${title}`);
  return id;
}

/**
 * Get the current status of a task by id.
 */
function getStatus(id: number): string | null {
  const rows = query<{ status: string }>('SELECT status FROM tasks WHERE id = ?', id);
  return rows[0]?.status ?? null;
}

/**
 * Get auto-expired task_actions for a todo.
 */
function getAutoExpiredActions(todoId: number): Array<{ action: string; note: string | null }> {
  return query<{ action: string; note: string | null }>(
    `SELECT action, note FROM task_actions WHERE task_id = ? AND action = 'auto-expired'`,
    todoId,
  );
}

// ── Config ────────────────────────────────────────────────────

const BASE_CONFIG: Record<string, unknown> = {
  enabled: true,
  ttl_days: 14,
  dry_run: false,
};

// ── Tests ─────────────────────────────────────────────────────

describe('notify-todo-expire: by-date-passed expiry', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('(a) expires a NOTIFY todo whose due_date is in the past', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]!;
    const id = seedTodo({
      source: 'auto:notify',
      priority: 'medium',
      due_date: yesterday,
      daysAgo: 2,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'cancelled', 'past-due todo should be cancelled');
    const actions = getAutoExpiredActions(id);
    assert.ok(actions.length > 0, 'auto-expired task_action should be inserted');
    assert.ok(
      actions[0]!.note?.includes('due_date'),
      'action note should mention due_date',
    );
  });
});

describe('notify-todo-expire: TTL-based expiry', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('(b) expires an untouched NOTIFY todo older than ttl_days', async () => {
    const id = seedTodo({
      source: 'auto:notify',
      priority: 'medium',
      due_date: null,
      daysAgo: 20, // older than 14-day TTL
    });
    // No extra task_actions seeded — untouched

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'cancelled', 'stale untouched todo should be cancelled');
    const actions = getAutoExpiredActions(id);
    assert.ok(actions.length > 0, 'auto-expired task_action should be inserted');
  });

  it('(c) does NOT expire a todo that has been touched (has non-created task_action)', async () => {
    const id = seedTodo({
      source: 'auto:notify',
      priority: 'medium',
      due_date: null,
      daysAgo: 20,
    });

    // Seed a non-'created' task_action to simulate the todo being touched
    exec(
      `INSERT INTO task_actions (task_id, action, note) VALUES (?, 'note', 'someone reviewed this')`,
      id,
    );

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'pending', 'touched todo should NOT be expired');
    const actions = getAutoExpiredActions(id);
    assert.strictEqual(actions.length, 0, 'no auto-expired action should be added for touched todo');
  });
});

describe('notify-todo-expire: protection guards', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('(d) does NOT expire urgent-priority todo', async () => {
    const urgentId = seedTodo({
      source: 'auto:notify',
      priority: 'urgent',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(urgentId), 'pending', 'urgent todo must not be auto-expired');
  });

  it('(d) does NOT expire todo with financial keyword in title', async () => {
    const financialId = seedTodo({
      title: 'Check payment status',
      source: 'auto:notify',
      priority: 'medium',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(financialId), 'pending', 'financial-keyword todo must not be auto-expired');
  });

  it('mutation kill: protection guard — todo with financial keyword survives', async () => {
    // This test goes RED if the PROTECTED_FINANCIAL_KEYWORDS check is removed
    // from the source code. The guard must reject any todo whose title/description
    // contains a protected keyword, even if all other expiry conditions are met.
    const id = seedTodo({
      title: 'Your bank account alert',
      source: 'auto:notify',
      priority: 'medium',
      daysAgo: 30, // well past TTL
    });

    await _runForTesting({ ...BASE_CONFIG });

    // If the financial/urgent exclusion were removed, this would be 'cancelled'.
    // The test assertion is the mutation kill.
    assert.strictEqual(
      getStatus(id),
      'pending',
      'todo with financial keyword must survive — removing PROTECTED_FINANCIAL_KEYWORDS guard would make this fail',
    );
  });

  it('PROTECTED_FINANCIAL_KEYWORDS is exported and non-empty', () => {
    assert.ok(Array.isArray(PROTECTED_FINANCIAL_KEYWORDS), 'PROTECTED_FINANCIAL_KEYWORDS should be an array');
    assert.ok(PROTECTED_FINANCIAL_KEYWORDS.length > 0, 'PROTECTED_FINANCIAL_KEYWORDS should not be empty');
    assert.ok(PROTECTED_FINANCIAL_KEYWORDS.includes('payment'), 'should include "payment"');
    assert.ok(PROTECTED_FINANCIAL_KEYWORDS.includes('billing'), 'should include "billing"');
  });
});

describe('notify-todo-expire: real user todos are never targeted', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('(e) does NOT expire todo with NULL source', async () => {
    const id = seedTodo({
      source: null,
      priority: 'medium',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'pending', 'NULL source todo must not be auto-expired');
  });

  it('(e) does NOT expire todo with source="human"', async () => {
    const id = seedTodo({
      source: 'human',
      priority: 'medium',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'pending', 'human-sourced todo must not be auto-expired');
  });
});

describe('notify-todo-expire: dry_run mode', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('dry_run=true: does not change status or insert task_actions', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]!;
    const id = seedTodo({
      source: 'auto:notify',
      priority: 'medium',
      due_date: yesterday,
      daysAgo: 2,
    });

    await _runForTesting({ ...BASE_CONFIG, dry_run: true });

    assert.strictEqual(getStatus(id), 'pending', 'dry_run should not change task status');
    const actions = getAutoExpiredActions(id);
    assert.strictEqual(actions.length, 0, 'dry_run should not insert task_actions');
  });
});

describe('notify-todo-expire: enabled=false', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('enabled=false: no changes at all', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]!;
    const id = seedTodo({
      source: 'auto:notify',
      priority: 'medium',
      due_date: yesterday,
      daysAgo: 2,
    });

    await _runForTesting({ enabled: false, ttl_days: 14, dry_run: false });

    assert.strictEqual(getStatus(id), 'pending', 'disabled handler should not change task status');
    const actions = getAutoExpiredActions(id);
    assert.strictEqual(actions.length, 0, 'disabled handler should not insert task_actions');
  });
});

describe('notify-todo-expire: auto:reflection and auto:granola sources', { concurrency: 1 }, () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  it('expires stale auto:reflection todo past TTL', async () => {
    const id = seedTodo({
      source: 'auto:reflection',
      priority: 'low',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'cancelled', 'auto:reflection todo should be expired past TTL');
  });

  it('expires stale auto:granola todo past TTL', async () => {
    const id = seedTodo({
      source: 'auto:granola',
      priority: 'medium',
      daysAgo: 20,
    });

    await _runForTesting({ ...BASE_CONFIG });

    assert.strictEqual(getStatus(id), 'cancelled', 'auto:granola todo should be expired past TTL');
  });
});
