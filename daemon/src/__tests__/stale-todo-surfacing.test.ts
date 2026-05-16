/**
 * Tests for stale-todo-surfacing (#271)
 *
 * Verifies:
 * - Zero-items run exits silently (no fetch call)
 * - Populated run posts one fetch with expected IDs in the message body
 * - Cap test: 30 items with max_items=5 → exactly 5 bullets in the message
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { run } from '../automation/tasks/stale-todo-surfacing.js';

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-todo-surfacing-test-'));
  // Minimal config so loadConfig() succeeds
  fs.writeFileSync(path.join(dir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
  return dir;
}

/** Format a date N days ago in SQLite datetime format. */
function pastDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function seedTodo(title: string, status: string, updatedDaysAgo: number): number {
  const updatedAt = pastDate(updatedDaysAgo);
  const result = exec(
    `INSERT INTO todos (title, status, updated_at, created_at) VALUES (?, ?, ?, ?)`,
    title, status, updatedAt, updatedAt,
  );
  return result.lastInsertRowid as number;
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

describe('stale-todo-surfacing (t-271b)', () => {
  let tmpDir: string;
  let fetchCalls: FetchCall[];
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    _resetConfigForTesting();
    _resetDbForTesting();
    openDatabase(tmpDir);
    loadConfig(tmpDir); // prime the config singleton

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const rawBody = init?.body;
      const body = rawBody ? (JSON.parse(rawBody as string) as Record<string, unknown>) : {};
      fetchCalls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exits silently (no fetch call) when no stale todos exist', async () => {
    // Fresh todos — below the stale threshold
    seedTodo('Recent task', 'pending', 5);
    seedTodo('Active work', 'in_progress', 3);

    await run({ pending_days: 14, in_progress_days: 7 });

    assert.equal(fetchCalls.length, 0, 'should make no fetch call when no stale todos');
  });

  it('posts one fetch with stale IDs in the message body', async () => {
    const id1 = seedTodo('Old pending task', 'pending', 20);
    const id2 = seedTodo('Old in-progress task', 'in_progress', 10);
    // Fresh ones — should not appear
    seedTodo('Fresh pending', 'pending', 5);
    seedTodo('Fresh in-progress', 'in_progress', 3);

    await run({ pending_days: 14, in_progress_days: 7 });

    assert.equal(fetchCalls.length, 1, 'exactly one fetch call should be made');
    const message = fetchCalls[0]!.body.message as string;
    assert.ok(message.includes(`#${id1}`), `message should include pending todo #${id1}`);
    assert.ok(message.includes(`#${id2}`), `message should include in-progress todo #${id2}`);
    assert.ok(message.includes('Weekly stale-todo surfacing'), 'message should have header');
    assert.ok(message.includes('Reply /todo close'), 'message should include reply instructions');
  });

  it('caps output to max_items (30 inserted, max_items=5 → 5 bullets)', async () => {
    for (let i = 0; i < 30; i++) {
      seedTodo(`Stale task ${i}`, 'pending', 20);
    }

    await run({ pending_days: 14, in_progress_days: 7, max_items: 5 });

    assert.equal(fetchCalls.length, 1, 'should make one fetch call');
    const message = fetchCalls[0]!.body.message as string;
    // Count bullet characters (U+2022)
    const bulletCount = (message.match(/^\u2022 /gm) ?? []).length;
    assert.equal(bulletCount, 5, `message should contain exactly 5 bullets, got ${bulletCount}`);
  });

  it('does not include channel field when channel is null', async () => {
    seedTodo('Old pending', 'pending', 20);

    await run({ pending_days: 14, channel: null });

    assert.equal(fetchCalls.length, 1, 'should make one fetch call');
    assert.ok(!Object.prototype.hasOwnProperty.call(fetchCalls[0]!.body, 'channel'),
      'body should not include channel field when channel is null');
  });

  it('includes channel field when channel is set', async () => {
    seedTodo('Old pending', 'pending', 20);

    await run({ pending_days: 14, channel: 'telegram' });

    assert.equal(fetchCalls.length, 1, 'should make one fetch call');
    assert.equal(fetchCalls[0]!.body.channel, 'telegram', 'body should include channel field');
  });
});
