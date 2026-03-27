/**
 * Self-improvement stats endpoint tests (Story 9).
 *
 * Tests:
 *   1. Returns correct counts with seeded data
 *   2. Returns zeros with empty DB
 *   3. Reflects enabled/disabled status from config
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, getDatabase } from '../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { handleSelfImprovementRoute } from '../../api/self-improvement.js';

const TEST_PORT = 19901;

// ── HTTP helper ──────────────────────────────────────────────

function request(method: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: { 'Connection': 'close' },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// ── Server setup ─────────────────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-si-stats-'));
  _resetDbForTesting();
  _resetConfigForTesting();

  const dbPath = path.join(tmpDir, 'test.db');
  openDatabase(tmpDir, dbPath); // runs migrations internally

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    handleSelfImprovementRoute(inReq, res, url.pathname)
      .then((handled: boolean) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      })
      .catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  _resetConfigForTesting();
  _resetDbForTesting();
  return new Promise<void>((resolve) => {
    server.close(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

// ── Seed helper ──────────────────────────────────────────────

function seedMemory(overrides: {
  content?: string;
  category?: string | null;
  trigger?: string | null;
  origin_agent?: string | null;
  created_at?: string;
}): void {
  const db = getDatabase();
  const now = overrides.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (content, category, tags, trigger, origin_agent, created_at, updated_at)
     VALUES (?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    overrides.content ?? 'test memory',
    overrides.category ?? null,
    overrides.trigger ?? null,
    overrides.origin_agent ?? null,
    now,
    now,
  );
}

function seedActivity(stage: string, created_at?: string): void {
  const db = getDatabase();
  const now = created_at ?? new Date().toISOString();
  // Need a task first
  try {
    db.prepare(
      `INSERT OR IGNORE INTO orchestrator_tasks (id, title, status, created_at, updated_at)
       VALUES ('task-stats-test', 'stats test task', 'completed', ?, ?)`,
    ).run(now, now);
  } catch {
    // table may already have row
  }
  db.prepare(
    `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
     VALUES ('task-stats-test', 'orchestrator', 'progress', ?, 'stats test', ?)`,
  ).run(stage, now);
}

// ── Tests ─────────────────────────────────────────────────────

describe('GET /api/self-improvement/stats — empty database', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns 200 with all-zero counts', async () => {
    // Default config has self_improvement.enabled = false
    loadConfig(tmpDir);

    const { status, body } = await request('GET', '/api/self-improvement/stats');
    assert.equal(status, 200);

    const data = JSON.parse(body) as {
      enabled: boolean;
      learnings: {
        total: number;
        by_category: Record<string, number>;
        by_trigger: Record<string, number>;
        by_origin: Record<string, number>;
        created_last_7d: number;
        synced_last_7d: number;
      };
      retros: { triggered_last_7d: number; learnings_extracted_last_7d: number };
      transcript_reviews: { run_last_7d: number; learnings_extracted_last_7d: number };
    };

    assert.equal(data.enabled, false);
    assert.equal(data.learnings.total, 0);
    assert.deepEqual(data.learnings.by_category, {});
    assert.deepEqual(data.learnings.by_trigger, {});
    assert.deepEqual(data.learnings.by_origin, {});
    assert.equal(data.learnings.created_last_7d, 0);
    assert.equal(data.learnings.synced_last_7d, 0);
    assert.equal(data.retros.triggered_last_7d, 0);
    assert.equal(data.retros.learnings_extracted_last_7d, 0);
    assert.equal(data.transcript_reviews.run_last_7d, 0);
    assert.equal(data.transcript_reviews.learnings_extracted_last_7d, 0);
  });
});

describe('GET /api/self-improvement/stats — seeded data', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('counts total learnings by trigger', async () => {
    loadConfig(tmpDir);

    seedMemory({ trigger: 'retro', category: 'operational', origin_agent: 'orchestrator' });
    seedMemory({ trigger: 'retro', category: 'operational', origin_agent: 'orchestrator' });
    seedMemory({ trigger: 'transcript', category: 'preference', origin_agent: 'comms' });
    seedMemory({ trigger: 'correction', category: 'operational', origin_agent: 'comms' });
    seedMemory({ trigger: 'sync', category: 'decision', origin_agent: 'bmo' });
    seedMemory({ trigger: 'manual', category: 'core', origin_agent: 'comms' });
    // Non-SI memory — should NOT be counted
    seedMemory({ trigger: null, category: 'episodic', origin_agent: null });

    const { status, body } = await request('GET', '/api/self-improvement/stats');
    assert.equal(status, 200);

    const data = JSON.parse(body) as {
      learnings: {
        total: number;
        by_trigger: Record<string, number>;
        by_category: Record<string, number>;
        by_origin: Record<string, number>;
        created_last_7d: number;
        synced_last_7d: number;
      };
    };

    assert.equal(data.learnings.total, 6);
    assert.equal(data.learnings.by_trigger['retro'], 2);
    assert.equal(data.learnings.by_trigger['transcript'], 1);
    assert.equal(data.learnings.by_trigger['correction'], 1);
    assert.equal(data.learnings.by_trigger['sync'], 1);
    assert.equal(data.learnings.by_trigger['manual'], 1);
  });

  it('groups learnings by category and origin', async () => {
    loadConfig(tmpDir);

    seedMemory({ trigger: 'retro', category: 'operational', origin_agent: 'orchestrator' });
    seedMemory({ trigger: 'retro', category: 'preference', origin_agent: 'comms' });
    seedMemory({ trigger: 'sync', category: 'operational', origin_agent: 'bmo' });

    const { body } = await request('GET', '/api/self-improvement/stats');
    const data = JSON.parse(body) as {
      learnings: {
        by_category: Record<string, number>;
        by_origin: Record<string, number>;
      };
    };

    assert.equal(data.learnings.by_category['operational'], 2);
    assert.equal(data.learnings.by_category['preference'], 1);
    assert.equal(data.learnings.by_origin['orchestrator'], 1);
    assert.equal(data.learnings.by_origin['comms'], 1);
    assert.equal(data.learnings.by_origin['bmo'], 1);
  });

  it('counts created_last_7d and synced_last_7d correctly', async () => {
    loadConfig(tmpDir);

    // Recent memories (today)
    seedMemory({ trigger: 'retro' });
    seedMemory({ trigger: 'sync' });
    seedMemory({ trigger: 'sync' });

    // Old memory (more than 7 days ago) — should NOT count for *_last_7d
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    seedMemory({ trigger: 'retro', created_at: old });

    const { body } = await request('GET', '/api/self-improvement/stats');
    const data = JSON.parse(body) as {
      learnings: { total: number; created_last_7d: number; synced_last_7d: number };
    };

    assert.equal(data.learnings.total, 4);
    assert.equal(data.learnings.created_last_7d, 3);
    assert.equal(data.learnings.synced_last_7d, 2);
  });

  it('counts retro and transcript stats from activity and memories', async () => {
    loadConfig(tmpDir);

    // Retro activity entries (triggered in last 7d)
    seedActivity('retro');
    seedActivity('retro');

    // Retro learnings
    seedMemory({ trigger: 'retro' });

    // Transcript review activity
    seedActivity('transcript_review');

    // Transcript learnings
    seedMemory({ trigger: 'transcript' });
    seedMemory({ trigger: 'transcript' });

    const { body } = await request('GET', '/api/self-improvement/stats');
    const data = JSON.parse(body) as {
      retros: { triggered_last_7d: number; learnings_extracted_last_7d: number };
      transcript_reviews: { run_last_7d: number; learnings_extracted_last_7d: number };
    };

    assert.equal(data.retros.triggered_last_7d, 2);
    assert.equal(data.retros.learnings_extracted_last_7d, 1);
    assert.equal(data.transcript_reviews.run_last_7d, 1);
    assert.equal(data.transcript_reviews.learnings_extracted_last_7d, 2);
  });
});

describe('GET /api/self-improvement/stats — enabled flag', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns enabled: false when self_improvement disabled in config', async () => {
    // Default config — enabled is false
    loadConfig(tmpDir);

    const { body } = await request('GET', '/api/self-improvement/stats');
    const data = JSON.parse(body) as { enabled: boolean };
    assert.equal(data.enabled, false);
  });

  it('returns enabled: true when self_improvement enabled in config', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: true\n',
    );
    loadConfig(tmpDir);

    const { body } = await request('GET', '/api/self-improvement/stats');
    const data = JSON.parse(body) as { enabled: boolean };
    assert.equal(data.enabled, true);
  });
});
