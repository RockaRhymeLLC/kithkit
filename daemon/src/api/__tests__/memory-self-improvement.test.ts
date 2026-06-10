/**
 * Self-improvement loop — Story 1: Memory schema extension tests
 *
 * Tests for new fields: origin_agent, trigger, shareable, decay_policy
 * and inline soft-cap enforcement on POST /api/memory/store.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { runMigrations, getMigrationsDir } from '../../core/migrations.js';
import { handleMemoryRoute } from '../memory.js';

const TEST_PORT = 19877;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-si-memory-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleMemoryRoute(inReq, res, url.pathname)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err), timestamp: new Date().toISOString() }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    if (server?.listening) {
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    } else {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }
  });
}

describe('Memory self-improvement fields', { concurrency: 1 }, () => {

  // ── Test 1: Store with all new fields ──────────────────────

  describe('Store with all new fields', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('persists origin_agent, trigger, shareable, decay_policy and returns them', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'BMO rewired the task queue for better throughput',
        category: 'operational',
        origin_agent: 'bmo',
        trigger: 'post-deploy-review',
        shareable: true,
        decay_policy: 'sliding-30d',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.id, 'Should have an id');
      assert.equal(body.origin_agent, 'bmo');
      assert.equal(body.trigger, 'post-deploy-review');
      assert.equal(body.shareable, 1);
      assert.equal(body.decay_policy, 'sliding-30d');
      assert.ok(body.timestamp);
    });

    it('persists shareable=false as 0', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'private memory for internal tracking',
        shareable: false,
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.shareable, 0);
    });
  });

  // ── Test 2: Store without new fields — verify defaults ─────

  describe('Store without new fields — verify defaults', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns category-scoped shareable default and decay_policy=default when not provided', async () => {
      // 'core' is not a self-improvement/learning category → shareable defaults to 0.
      // See SHAREABLE_CATEGORIES in memory.ts for the full list.
      const res = await request('POST', '/api/memory/store', {
        content: 'Plain memory with no new fields',
        category: 'core',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.shareable, 0, 'shareable should default to 0 for non-learning category');
      assert.equal(body.decay_policy, 'default', 'decay_policy should default to "default"');
      assert.equal(body.origin_agent, null, 'origin_agent should default to null');
      assert.equal(body.trigger, null, 'trigger should default to null');
    });
  });

  // ── Test 3: Search returns new fields ──────────────────────

  describe('Search returns new fields', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('keyword search results include origin_agent, trigger, shareable, decay_policy', async () => {
      await request('POST', '/api/memory/store', {
        content: 'R2 completed the weekly code review',
        category: 'episodic',
        origin_agent: 'r2',
        trigger: 'weekly-review',
        shareable: true,
        decay_policy: 'expire-7d',
      });

      const res = await request('POST', '/api/memory/search', { query: 'weekly code review' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length >= 1);
      const m = body.data[0];
      assert.equal(m.origin_agent, 'r2');
      assert.equal(m.trigger, 'weekly-review');
      assert.equal(m.shareable, 1);
      assert.equal(m.decay_policy, 'expire-7d');
    });
  });

  // ── Test 4: Migration runs cleanly on existing DB with data ─

  describe('Migration 016 runs cleanly on existing DB with data', () => {
    it('new columns have correct defaults on rows inserted before migration', () => {
      const tmpMigrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-migr016-'));
      const dbPath = path.join(tmpMigrDir, 'test-migr.db');

      try {
        const realMigrDir = getMigrationsDir();

        // Build a temp migrations dir with only 001-015
        const preMigrDir = path.join(tmpMigrDir, 'pre-016');
        fs.mkdirSync(preMigrDir);
        for (const f of fs.readdirSync(realMigrDir)) {
          if (f.endsWith('.sql') && !f.startsWith('016')) {
            fs.copyFileSync(path.join(realMigrDir, f), path.join(preMigrDir, f));
          }
        }

        // Open DB with migrations 001-015 only
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        runMigrations(db, preMigrDir);

        // Insert test data before migration 016
        db.prepare(
          'INSERT INTO memories (content, category, tags) VALUES (?, ?, ?)',
        ).run('pre-existing memory', 'operational', '[]');

        // Now add migration 016 and apply it
        fs.copyFileSync(
          path.join(realMigrDir, '016-self-improvement-memory-fields.sql'),
          path.join(preMigrDir, '016-self-improvement-memory-fields.sql'),
        );
        const applied = runMigrations(db, preMigrDir);
        assert.equal(applied, 1, 'Should apply exactly migration 016');

        // Existing row should have correct defaults
        const row = db.prepare(
          'SELECT * FROM memories WHERE content = ?',
        ).get('pre-existing memory') as Record<string, unknown>;

        // The DDL default for shareable is 0; the category-scoped application-layer
        // default only applies at insert time through the API, not to pre-existing rows.
        // This is correct: backfilling existing rows is a deliberate operator decision.
        assert.equal(row['shareable'], 0, 'shareable DDL default is 0 for pre-existing rows');
        assert.equal(row['decay_policy'], 'default', 'decay_policy defaults to "default"');
        assert.equal(row['origin_agent'], null, 'origin_agent defaults to null');
        assert.equal(row['trigger'], null, 'trigger defaults to null');

        db.close();
      } finally {
        fs.rmSync(tmpMigrDir, { recursive: true, force: true });
      }
    });
  });

  // ── Test 5: Write-time category caps removed ────────────────
  // Per-category caps were removed by Dave directive 2026-05-09 (todo #341):
  // they silently dropped new entries. Lifecycle pruning is the consolidation
  // task's job, not a hard cap at write time. The original tests here asserted
  // the 51st memory was skipped — that is removed behavior; the current
  // contract is that stores are never cap-rejected.

  describe('Write-time category caps removed (todo #341)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('stores past the old 50-per-category cap without skipping', async () => {
      const category = 'test-cap-removed';

      for (let i = 0; i < 51; i++) {
        const r = await request('POST', '/api/memory/store', {
          content: `cap-test memory ${i}`,
          category,
        });
        assert.equal(r.status, 201, `Expected memory ${i} to be stored (got ${r.status})`);
        const body = JSON.parse(r.body);
        assert.equal(body.skipped, undefined, 'skipped should never be set');
      }
    });
  });

  // ── Test 6: Category-scoped shareable defaults ───────────────
  // Self-improvement/learning categories auto-share to peers (shareable=1).
  // All other categories stay local (shareable=0) unless explicitly overridden.

  describe('Category-scoped shareable defaults', () => {
    beforeEach(setup);
    afterEach(teardown);

    const shareableCategories = ['api-format', 'behavioral', 'process', 'tool-usage', 'communication'];
    const nonShareableCategories = ['event', 'technical', 'fact', 'person', 'user', 'private'];

    for (const cat of shareableCategories) {
      it(`defaults shareable=1 for self-improvement category: ${cat}`, async () => {
        const res = await request('POST', '/api/memory/store', {
          content: `category-scope test — ${cat}`,
          category: cat,
        });
        assert.equal(res.status, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.shareable, 1, `${cat} should default to shareable=1`);
      });
    }

    for (const cat of nonShareableCategories) {
      it(`defaults shareable=0 for non-sharing category: ${cat}`, async () => {
        const res = await request('POST', '/api/memory/store', {
          content: `category-scope test — ${cat}`,
          category: cat,
        });
        assert.equal(res.status, 201);
        const body = JSON.parse(res.body);
        assert.equal(body.shareable, 0, `${cat} should default to shareable=0`);
      });
    }

    it('defaults shareable=0 when no category is provided', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'no-category memory',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.shareable, 0, 'null category should default to shareable=0');
    });

    it('caller-supplied shareable=1 overrides default for any category', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'explicit override test',
        category: 'event',
        shareable: true,
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.shareable, 1, 'explicit shareable=true should override category default');
    });

    it('caller-supplied shareable=0 overrides default for sharing categories', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'explicit override test',
        category: 'behavioral',
        shareable: false,
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.shareable, 0, 'explicit shareable=false should override category default');
    });
  });
});
