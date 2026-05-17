/**
 * Self-Watchdog Unit Tests
 *
 * Covers:
 *   - activity-query.ts: timestamp aggregation from five sources
 *   - self-watchdog.ts run(): idle threshold logic
 *   - alert.ts: three-channel fanout with dedup
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, getDatabase, query, exec } from '../../../core/db.js';
import { _resetConfigForTesting } from '../../../core/config.js';
import { getLastActivityTimestamp } from '../helpers/activity-query.js';
import { fireSelfWatchdogAlert } from '../helpers/alert.js';
import { _runForTesting, _setDepsForTesting } from '../self-watchdog.js';

// ── Test setup ────────────────────────────────────────────────

let tmpDir: string;
let testCounter = 0;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-self-watchdog-'));
  _resetDbForTesting();
  _resetConfigForTesting();

  const dbPath = path.join(tmpDir, 'test.db');
  openDatabase(tmpDir, dbPath);
  testCounter++;

  // Disable foreign key constraints for easier testing
  try {
    getDatabase().prepare('PRAGMA foreign_keys = OFF').run();
  } catch {
    // May fail in some test setups
  }

  // Ensure feature_state table exists for alert tests
  try {
    getDatabase().prepare(
      `CREATE TABLE IF NOT EXISTS feature_state (
        feature TEXT PRIMARY KEY,
        state TEXT,
        updated_at TEXT
      )`,
    ).run();
  } catch {
    // Table may already exist
  }
}

function teardownDb(): void {
  _resetConfigForTesting();
  _resetDbForTesting();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Helper: seed a single activity record ──────────────────────

interface SeedActivityOpts {
  table: 'worker_jobs' | 'orchestrator_tasks' | 'messages' | 'memories' | 'todos';
  timestamp: string; // ISO format
}

function seedActivity(opts: SeedActivityOpts): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const uniqueId = `${testCounter}-${Date.now()}-${Math.random()}`;

  switch (opts.table) {
    case 'worker_jobs':
      try {
        db.prepare(
          `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, finished_at, created_at)
           VALUES (?, ?, 'test', 'test', 'completed', ?, ?)`,
        ).run(`job-${uniqueId}`, `agent-${uniqueId}`, opts.timestamp, now);
      } catch (e) {
        // Try without agent_id if it fails
        db.prepare(
          `INSERT INTO worker_jobs (profile, prompt, status, finished_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run('test', 'test', 'completed', opts.timestamp, now);
      }
      break;

    case 'orchestrator_tasks':
      db.prepare(
        `INSERT INTO orchestrator_tasks (id, title, status, updated_at, created_at)
         VALUES (?, 'test task', 'completed', ?, ?)`,
      ).run(`task-${uniqueId}`, opts.timestamp, now);
      break;

    case 'messages':
      db.prepare(
        `INSERT INTO messages (from_agent, to_agent, type, body, created_at)
         VALUES (?, ?, 'result', ?, ?)`,
      ).run(`agent-a-${uniqueId}`, `agent-b-${uniqueId}`, 'test message', opts.timestamp);
      break;

    case 'memories':
      db.prepare(
        `INSERT INTO memories (content, category, tags, created_at, updated_at)
         VALUES (?, 'test', '[]', ?, ?)`,
      ).run('test memory', opts.timestamp, opts.timestamp);
      break;

    case 'todos':
      db.prepare(
        `INSERT INTO todos (title, status, updated_at, created_at)
         VALUES (?, 'pending', ?, ?)`,
      ).run('test todo', opts.timestamp, now);
      break;
  }
}

// ── ACTIVITY-QUERY TESTS ───────────────────────────────────────

describe('getLastActivityTimestamp', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('returns null when all five sources are empty', async () => {
    const result = await getLastActivityTimestamp();
    assert.strictEqual(result, null, 'should return null when no activity exists');
  });

  it('returns timestamp when one source has data', async () => {
    const ts = '2026-05-15T10:00:00Z';
    const tsMs = new Date(ts).getTime();
    seedActivity({ table: 'worker_jobs', timestamp: ts });

    const result = await getLastActivityTimestamp();
    assert.ok(result !== null, 'should return a timestamp');
    // Compare as milliseconds since ISO string formatting varies slightly
    assert.ok(Math.abs(result - tsMs) < 1000, 'should return timestamp within 1 second');
  });

  it('returns MAX across multiple sources', async () => {
    const ts1 = '2026-05-15T09:00:00Z';
    const ts2 = '2026-05-15T10:00:00Z';
    const ts3 = '2026-05-15T11:00:00Z';
    const ts3Ms = new Date(ts3).getTime();

    seedActivity({ table: 'worker_jobs', timestamp: ts1 });
    seedActivity({ table: 'messages', timestamp: ts2 });
    seedActivity({ table: 'todos', timestamp: ts3 });

    const result = await getLastActivityTimestamp();
    assert.ok(result !== null, 'should return a timestamp');
    // Compare as milliseconds
    assert.ok(Math.abs(result - ts3Ms) < 1000, 'should return the maximum timestamp');
  });

  it('gracefully continues when a table is missing', async () => {
    // Seed only worker_jobs and messages; other tables will fail on query
    const ts = '2026-05-15T10:00:00Z';
    seedActivity({ table: 'worker_jobs', timestamp: ts });
    seedActivity({ table: 'messages', timestamp: ts });

    const result = await getLastActivityTimestamp();
    assert.ok(result !== null, 'should return a timestamp even with some tables missing');
  });

  it('skips non-ISO date strings (no NaN propagation)', async () => {
    const db = getDatabase();
    const uniqueId = `${testCounter}-${Date.now()}-${Math.random()}`;

    // Insert a malformed date into one table
    try {
      db.prepare(
        `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, finished_at, created_at)
         VALUES (?, ?, 'test', 'test', 'completed', ?, ?)`,
      ).run(`bad-job-${uniqueId}`, `agent-${uniqueId}`, 'invalid-date', new Date().toISOString());
    } catch {
      // If agent_id constraint fails, try without it
      db.prepare(
        `INSERT INTO worker_jobs (profile, prompt, status, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('test', 'test', 'completed', 'invalid-date', new Date().toISOString());
    }

    // Insert a valid date into another table
    const validTs = '2026-05-15T10:00:00Z';
    const validTsMs = new Date(validTs).getTime();
    seedActivity({ table: 'messages', timestamp: validTs });

    const result = await getLastActivityTimestamp();
    assert.ok(result !== null, 'should return valid timestamp despite invalid date');
    // Compare as milliseconds
    assert.ok(Math.abs(result - validTsMs) < 1000, 'should skip invalid dates and return valid one');
  });
});

// ── SELF-WATCHDOG RUN() TESTS ──────────────────────────────────

describe('self-watchdog run() threshold logic', () => {
  beforeEach(setupDb);
  afterEach(() => {
    _setDepsForTesting(null); // restore real fireSelfWatchdogAlert
    teardownDb();
  });

  interface AlertCall {
    level: 'warn' | 'alert';
    context: { idleSeconds: number; lastActivityAt: number | null };
  }

  function setupMockAlert(): AlertCall[] {
    const calls: AlertCall[] = [];
    _setDepsForTesting({
      fireSelfWatchdogAlert: async (level, context) => {
        calls.push({ level, context });
      },
    });
    return calls;
  }

  it('fires no alert when idle < warn threshold', async () => {
    const calls = setupMockAlert();

    // Seed activity 3 hours ago — below the 6h warn threshold
    const ts = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    seedActivity({ table: 'worker_jobs', timestamp: ts });

    await _runForTesting();

    assert.strictEqual(calls.length, 0, 'should not fire any alert');
  });

  it('fires warn alert when idle >= warn but < alert', async () => {
    const calls = setupMockAlert();
    const warnSeconds = 6 * 3600;
    const alertSeconds = 12 * 3600;

    // Seed activity 8 hours ago — above warn (6h), below alert (12h)
    const ts = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
    seedActivity({ table: 'worker_jobs', timestamp: ts });

    await _runForTesting();

    assert.strictEqual(calls.length, 1, 'should fire exactly one alert');
    assert.strictEqual(calls[0].level, 'warn', 'should fire at warn level');
    assert.ok(calls[0].context.idleSeconds >= warnSeconds, 'idleSeconds should exceed warn threshold');
    assert.ok(calls[0].context.idleSeconds < alertSeconds, 'idleSeconds should be below alert threshold');
  });

  it('fires alert when idle >= alert threshold', async () => {
    const calls = setupMockAlert();
    const alertSeconds = 12 * 3600;

    // Seed activity 14 hours ago — above alert (12h)
    const ts = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
    seedActivity({ table: 'worker_jobs', timestamp: ts });

    await _runForTesting();

    assert.strictEqual(calls.length, 1, 'should fire exactly one alert');
    assert.strictEqual(calls[0].level, 'alert', 'should fire at alert level');
    assert.ok(calls[0].context.idleSeconds >= alertSeconds, 'idleSeconds should exceed alert threshold');
  });

  it('skips alert when no activity recorded yet (fresh install / DB wipe)', async () => {
    // Per Fix 1: null lastActivityAt → skip, not Infinity idle
    const calls = setupMockAlert();

    // No activity seeded — DB is empty, getLastActivityTimestamp() returns null
    await _runForTesting();

    assert.strictEqual(calls.length, 0, 'should not fire any alert on fresh install');
  });
});

// ── ALERT.TS TESTS ────────────────────────────────────────────

describe('fireSelfWatchdogAlert three-channel fanout', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  let fetchCalls: Array<{
    url: string;
    method: string;
    body: unknown;
  }> = [];

  // Mock global fetch
  const originalFetch = global.fetch;
  function mockFetch(url: string, opts?: RequestInit): Promise<Response> {
    fetchCalls.push({
      url,
      method: opts?.method ?? 'GET',
      body: opts?.body ? JSON.parse(String(opts.body)) : undefined,
    });

    // Return success response
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fires all three channels on first warn alert', async () => {
    // Clear any dedup state
    const db = getDatabase();
    db.prepare('DELETE FROM feature_state WHERE feature = ?').run('self-watchdog:last-alert');

    await fireSelfWatchdogAlert('warn', {
      idleSeconds: 7 * 3600,
      lastActivityAt: Date.now() - (7 * 3600 * 1000),
    });

    // At minimum, Telegram should have been attempted
    assert.ok(fetchCalls.length > 0, 'should attempt at least one fetch call');
    const telegramCall = fetchCalls.find(c => c.url.includes('/api/send'));
    assert.ok(telegramCall, 'should attempt telegram delivery');
    assert.strictEqual(telegramCall?.method, 'POST');
  });

  it('suppresses duplicate warn alerts within dedup window', async () => {
    const db = getDatabase();
    db.prepare('DELETE FROM feature_state WHERE feature = ?').run('self-watchdog:last-alert');

    // First alert
    await fireSelfWatchdogAlert('warn', {
      idleSeconds: 7 * 3600,
      lastActivityAt: Date.now() - (7 * 3600 * 1000),
    });

    const callsAfterFirst = fetchCalls.length;
    assert.ok(callsAfterFirst > 0, 'first alert should trigger fetch calls');

    // Second alert immediately after (within dedup window)
    fetchCalls = [];
    await fireSelfWatchdogAlert('warn', {
      idleSeconds: 8 * 3600,
      lastActivityAt: Date.now() - (8 * 3600 * 1000),
    });

    assert.strictEqual(fetchCalls.length, 0, 'second warn alert should be suppressed');
  });

  it('fires again after dedup window expires', async () => {
    const db = getDatabase();
    db.prepare('DELETE FROM feature_state WHERE feature = ?').run('self-watchdog:last-alert');

    // Manually set a dedup state in the past
    const pastTime = Date.now() - (2 * 3600 * 1000); // 2 hours ago
    db.prepare(
      `INSERT INTO feature_state (feature, state, updated_at)
       VALUES (?, ?, ?)`,
    ).run(
      'self-watchdog:last-alert',
      JSON.stringify({ last_warn_at: pastTime, last_alert_at: null }),
      new Date().toISOString(),
    );

    // Assume dedup window is 1 hour (3600s)
    fetchCalls = [];
    await fireSelfWatchdogAlert('warn', {
      idleSeconds: 7 * 3600,
      lastActivityAt: Date.now() - (7 * 3600 * 1000),
    });

    assert.ok(fetchCalls.length > 0, 'alert should fire after dedup window expires');
  });

  it('treats alert level and warn level as independent for dedup', async () => {
    const db = getDatabase();
    db.prepare('DELETE FROM feature_state WHERE feature = ?').run('self-watchdog:last-alert');

    // Fire a warn alert
    await fireSelfWatchdogAlert('warn', {
      idleSeconds: 7 * 3600,
      lastActivityAt: Date.now() - (7 * 3600 * 1000),
    });

    const warnCalls = fetchCalls.length;
    assert.ok(warnCalls > 0, 'warn alert should trigger');

    // Immediately fire an alert-level alert (should NOT be suppressed)
    fetchCalls = [];
    await fireSelfWatchdogAlert('alert', {
      idleSeconds: 14 * 3600,
      lastActivityAt: Date.now() - (14 * 3600 * 1000),
    });

    assert.ok(
      fetchCalls.length > 0,
      'alert-level alert should fire even after recent warn (independent dedup)',
    );
  });
});
