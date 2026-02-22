/**
 * t-126, t-127, t-178: Memory system + structured search
 *
 * Uses a shared DB singleton so must run sequentially (concurrency: 1).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { handleMemoryRoute } from '../api/memory.js';

const TEST_PORT = 19861;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memory-'));
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

describe('Memory API', { concurrency: 1 }, () => {

  // ── t-126: Memory store and retrieve ──────────────────────────

  describe('Memory store and retrieve (t-126)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('stores a memory via POST /memory/store', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'Dave prefers dark mode',
        type: 'fact',
        category: 'preferences',
        tags: ['ui', 'settings'],
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.ok(body.id, 'Should have an auto-generated id');
      assert.equal(body.content, 'Dave prefers dark mode');
      assert.equal(body.type, 'fact');
      assert.equal(body.category, 'preferences');
      assert.deepEqual(body.tags, ['ui', 'settings']);
      assert.ok(body.timestamp, 'Response should include timestamp');
      assert.ok(body.created_at, 'Should have created_at');
    });

    it('retrieves a memory via GET /memory/:id', async () => {
      const createRes = await request('POST', '/api/memory/store', {
        content: 'Dave prefers dark mode',
        type: 'fact',
        category: 'preferences',
        tags: ['ui', 'settings'],
      });
      const created = JSON.parse(createRes.body);

      const res = await request('GET', `/api/memory/${created.id}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, created.id);
      assert.equal(body.content, 'Dave prefers dark mode');
      assert.equal(body.type, 'fact');
      assert.equal(body.category, 'preferences');
      assert.deepEqual(body.tags, ['ui', 'settings']);
    });

    it('deletes a memory and subsequent GET returns 404', async () => {
      const createRes = await request('POST', '/api/memory/store', {
        content: 'Something to delete',
        type: 'episodic',
      });
      const created = JSON.parse(createRes.body);

      const delRes = await request('DELETE', `/api/memory/${created.id}`);
      assert.equal(delRes.status, 204);

      const getRes = await request('GET', `/api/memory/${created.id}`);
      assert.equal(getRes.status, 404);
    });

    it('returns 404 for nonexistent memory', async () => {
      const res = await request('GET', '/api/memory/99999');
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.ok(body.timestamp);
    });

    it('returns 404 when deleting nonexistent memory', async () => {
      const res = await request('DELETE', '/api/memory/99999');
      assert.equal(res.status, 404);
    });

    it('stores memory with defaults (type defaults to fact)', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'Simple memory without optional fields',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.type, 'fact');
      assert.deepEqual(body.tags, []);
      assert.equal(body.category, null);
    });

    it('stores memory with source field', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'From a conversation',
        source: 'telegram',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.content, 'From a conversation');
    });
  });

  // ── t-127: Keyword search for memories ────────────────────────

  describe('Keyword search (t-127)', () => {
    beforeEach(setup);
    afterEach(teardown);

    async function seedMemories(): Promise<void> {
      await request('POST', '/api/memory/store', {
        content: 'Dave prefers dark mode in all applications',
        type: 'fact',
        category: 'preferences',
        tags: ['ui', 'settings'],
      });
      await request('POST', '/api/memory/store', {
        content: 'The deployment script is at scripts/deploy.sh',
        type: 'procedural',
        category: 'devops',
        tags: ['scripts', 'deploy'],
      });
      await request('POST', '/api/memory/store', {
        content: 'Met with Alex to discuss dark mode implementation',
        type: 'episodic',
        category: 'meetings',
        tags: ['alex', 'ui'],
      });
      await request('POST', '/api/memory/store', {
        content: 'Coffee machine is on the second floor',
        type: 'fact',
        category: 'office',
        tags: ['location'],
      });
      await request('POST', '/api/memory/store', {
        content: 'Use bun for package management, not npm',
        type: 'procedural',
        category: 'preferences',
        tags: ['tools', 'settings'],
      });
    }

    it('searches by keyword query', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { query: 'dark mode' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.data.length >= 2, 'Should find at least 2 memories with "dark mode"');
      // Relevance: both should contain "dark mode"
      for (const m of body.data) {
        assert.ok(
          m.content.toLowerCase().includes('dark') || m.content.toLowerCase().includes('mode'),
          'Each result should contain at least one search term',
        );
      }
    });

    it('searches by tags and category combined', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', {
        tags: ['ui'],
        category: 'preferences',
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1, 'Only one memory matches both tag=ui AND category=preferences');
      assert.equal(body.data[0].content, 'Dave prefers dark mode in all applications');
    });

    it('searches by category alone', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { category: 'preferences' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2, 'Two memories in preferences category');
    });

    it('searches by tags alone', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { tags: ['ui'] });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2, 'Two memories with tag ui');
    });

    it('returns empty array for no matches', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { query: 'nonexistent-term-xyz' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.data, []);
    });

    it('searches by type filter', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { type: 'procedural' });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2, 'Two procedural memories');
    });

    it('composes keyword + category + tags', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', {
        query: 'dark',
        category: 'preferences',
        tags: ['ui'],
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
      assert.ok(body.data[0].content.includes('dark mode'));
    });

    it('searches by date range', async () => {
      await seedMemories();
      // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' (no T, no Z)
      // Use same format for date range queries
      const pad = (n: number) => String(n).padStart(2, '0');
      const fmtSqlite = (d: Date) =>
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      const from = fmtSqlite(new Date(Date.now() - 60000));
      const to = fmtSqlite(new Date(Date.now() + 60000));
      const res = await request('POST', '/api/memory/search', {
        date_from: from,
        date_to: to,
      });
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 5, 'All 5 memories should be in date range');
    });

    it('results include timestamp', async () => {
      await seedMemories();
      const res = await request('POST', '/api/memory/search', { query: 'dark' });
      const body = JSON.parse(res.body);
      assert.ok(body.timestamp, 'Search response should include timestamp');
    });
  });

  // ── t-178: Negative — memory store rejects invalid input ──────

  describe('Invalid memory input (t-178)', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('rejects POST /memory/store with empty body (missing content)', async () => {
      const res = await request('POST', '/api/memory/store', {});
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'content is required');
      assert.ok(body.timestamp);
    });

    it('rejects invalid type', async () => {
      const res = await request('POST', '/api/memory/store', {
        content: 'test',
        type: 'invalid-type',
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('fact'));
      assert.ok(body.error.includes('episodic'));
      assert.ok(body.error.includes('procedural'));
    });

    it('rejects search with empty query and no filters', async () => {
      const res = await request('POST', '/api/memory/search', {});
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'query or at least one filter required');
    });

    it('rejects malformed JSON without crashing', async () => {
      const res = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const opts: http.RequestOptions = {
          host: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/memory/store',
          method: 'POST',
          timeout: 5000,
          headers: {
            'Content-Type': 'application/json',
            'Connection': 'close',
          },
        };
        const r = http.request(opts, (httpRes) => {
          let data = '';
          httpRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          httpRes.on('end', () => resolve({ status: httpRes.statusCode ?? 0, body: data, headers: httpRes.headers }));
        });
        r.on('error', reject);
        r.write('{"broken json');
        r.end();
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'Invalid JSON');
    });
  });
});
