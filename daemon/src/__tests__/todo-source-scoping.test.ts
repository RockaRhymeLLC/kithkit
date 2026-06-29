/**
 * Tests for todo source-based audience scoping.
 *
 * Covers:
 *  - source-stamp-on-create: POST /api/todos persists source; absent source uses config default
 *  - ?source= API filter: GET /api/todos?source=X returns ONLY X's rows
 *  - scoped gatherTodos: audienceSource param filters tasks; non-matching excluded
 *  - backfill: simulate NULL-source rows, run UPDATE, verify result
 *
 * All tests use the unified `tasks` table (kind='todo'), never the legacy `todos` table.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec, query, getDatabase } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { handleStateRoute } from '../api/state.js';
import { gatherTodos } from '../automation/tasks/morning-briefing.js';

const TEST_PORT = 19870;

// ── HTTP test helper ─────────────────────────────────────────

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

// ── Server setup / teardown ──────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-todo-source-'));
  _resetDbForTesting();
  _resetConfigForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  // Prime config from tmpDir (fresh temp dir has no kithkit.config.yaml → no
  // todos.default_source). Without this, loadConfig() in the POST handler falls
  // back to process.cwd() which may have an instance-specific default_source.
  loadConfig(tmpDir);

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleStateRoute(inReq, res, url.pathname, url.searchParams)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      })
      .catch((err) => {
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
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    _resetConfigForTesting();
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

// ── Test suites ───────────────────────────────────────────────

describe('Todo source scoping', { concurrency: 1 }, () => {

  // ── 1. source-stamp-on-create ─────────────────────────────────

  describe('source-stamp-on-create', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('POST /api/todos with explicit source persists it', async () => {
      const res = await request('POST', '/api/todos', {
        title: 'Sourced todo',
        source: 'alice',
      });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, 'alice', 'source field should be returned in response');

      // Verify it was actually stored in the tasks table
      const db = getDatabase();
      const row = db.prepare(
        "SELECT source FROM tasks WHERE kind='todo' AND title='Sourced todo'",
      ).get() as { source: string } | undefined;
      assert.ok(row, 'row should exist in tasks table');
      assert.equal(row.source, 'alice');
    });

    it('POST /api/todos without source and no config default → source is null', async () => {
      // No kithkit.config.yaml in tmpDir, so no todos.default_source
      const res = await request('POST', '/api/todos', { title: 'No source todo' });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      // source should be null/undefined when no config default
      assert.ok(body.source === null || body.source === undefined,
        'source should be null when not provided and no config default');

      const db = getDatabase();
      const row = db.prepare(
        "SELECT source FROM tasks WHERE kind='todo' AND title='No source todo'",
      ).get() as { source: string | null } | undefined;
      assert.ok(row, 'row should exist');
      assert.equal(row.source, null, 'source should be NULL in DB');
    });

    it('POST /api/todos without source uses todos.default_source from config when set', async () => {
      // Write a minimal kithkit.config.yaml with todos.default_source
      const configYaml = [
        'agent:',
        '  name: "TestAgent"',
        'daemon:',
        '  port: 13847',
        '  log_level: "info"',
        '  log_dir: "logs"',
        '  log_rotation:',
        '    max_size_mb: 10',
        '    max_files: 5',
        'scheduler:',
        '  tasks: []',
        'security:',
        '  rate_limits:',
        '    incoming_max_per_minute: 5',
        '    outgoing_max_per_minute: 10',
        'todos:',
        '  default_source: "agent-x"',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), configYaml);
      // Reset config cache so it re-reads from tmpDir
      _resetConfigForTesting();
      // Reload config from tmpDir (simulates a running daemon in that dir)
      loadConfig(tmpDir);

      const res = await request('POST', '/api/todos', { title: 'Default source todo' });
      assert.equal(res.status, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.source, 'agent-x', 'source should be the configured default');

      const db = getDatabase();
      const row = db.prepare(
        "SELECT source FROM tasks WHERE kind='todo' AND title='Default source todo'",
      ).get() as { source: string } | undefined;
      assert.ok(row, 'row should exist');
      assert.equal(row.source, 'agent-x');
    });
  });

  // ── 2. ?source= API filter ───────────────────────────────────

  describe('?source= GET filter', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('GET /api/todos?source=X returns ONLY todos with that source', async () => {
      // Insert todos with different sources directly into tasks table
      const db = getDatabase();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice task', 'alice', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Bob task', 'bob', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Also Alice', 'alice', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'No source task', NULL, 'pending', 'medium')",
      ).run();

      // Filter by alice
      const aliceRes = await request('GET', '/api/todos?source=alice');
      assert.equal(aliceRes.status, 200);
      const aliceBody = JSON.parse(aliceRes.body);
      assert.equal(aliceBody.data.length, 2, 'should return exactly 2 alice todos');
      for (const todo of aliceBody.data) {
        assert.equal(todo.source, 'alice', 'all returned todos should have source=alice');
      }
      // Verify bob's task is NOT included
      const titles = aliceBody.data.map((t: { title: string }) => t.title);
      assert.ok(!titles.includes('Bob task'), 'bob task must not appear in alice filter');
      assert.ok(!titles.includes('No source task'), 'null-source task must not appear');
    });

    it('GET /api/todos?source=bob returns only bob todos', async () => {
      const db = getDatabase();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice task', 'alice', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Bob only', 'bob', 'pending', 'medium')",
      ).run();

      const res = await request('GET', '/api/todos?source=bob');
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].title, 'Bob only');
    });

    it('GET /api/todos (no source filter) returns all todos regardless of source', async () => {
      const db = getDatabase();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice task', 'alice', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Bob task', 'bob', 'pending', 'medium')",
      ).run();

      const res = await request('GET', '/api/todos');
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 2, 'unfiltered GET should return all todos');
    });

    it('?status= and ?source= filters combine correctly', async () => {
      const db = getDatabase();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice pending', 'alice', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice completed', 'alice', 'completed', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Bob pending', 'bob', 'pending', 'medium')",
      ).run();

      const res = await request('GET', '/api/todos?source=alice&status=pending');
      const body = JSON.parse(res.body);
      assert.equal(body.data.length, 1, 'combined filter should match only alice+pending');
      assert.equal(body.data[0].title, 'Alice pending');
    });
  });

  // ── 3. scoped gatherTodos ────────────────────────────────────

  describe('scoped gatherTodos', () => {
    let gatherTmpDir: string;

    before(() => {
      gatherTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-gathertodos-'));
      _resetDbForTesting();
      _resetConfigForTesting();
      openDatabase(gatherTmpDir, path.join(gatherTmpDir, 'test.db'));

      // Seed: alice's todo (open), bob's todo (open), alice's completed (should be excluded)
      const db = getDatabase();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice open task', 'alice', 'pending', 'high')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Bob open task', 'bob', 'pending', 'medium')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Alice done', 'alice', 'completed', 'low')",
      ).run();
      db.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'No source task', NULL, 'pending', 'low')",
      ).run();
    });

    after(() => {
      _resetDbForTesting();
      _resetConfigForTesting();
      fs.rmSync(gatherTmpDir, { recursive: true, force: true });
    });

    it('gatherTodos(audienceSource) returns ONLY open todos for that source', () => {
      const result = gatherTodos('alice');
      assert.ok(result.includes('Alice open task'), 'should include alice open task');
      assert.ok(!result.includes('Bob open task'), 'must NOT include bob task');
      assert.ok(!result.includes('Alice done'), 'must NOT include completed tasks');
      assert.ok(!result.includes('No source task'), 'must NOT include null-source task');
    });

    it('gatherTodos(audienceSource) excludes tasks from other sources', () => {
      const result = gatherTodos('bob');
      assert.ok(result.includes('Bob open task'), 'should include bob task');
      assert.ok(!result.includes('Alice open task'), 'must NOT include alice task');
    });

    it('gatherTodos reads from tasks table (kind=todo), not legacy todos table', () => {
      // The legacy todos table does NOT exist in a fresh migration-024+ DB.
      // If gatherTodos still queries FROM todos, it would throw since that table
      // may not exist. Verify it runs cleanly (reads from tasks) and finds alice's row.
      const db = getDatabase();
      // Drop the todos table if it exists (simulates a post-migration cleanup env)
      try {
        db.prepare('DROP TABLE IF EXISTS todos').run();
      } catch {
        // ignore
      }
      // gatherTodos should still work — it reads from tasks
      const result = gatherTodos('alice');
      assert.ok(!result.includes('unavailable'), 'gatherTodos should succeed reading from tasks table');
      assert.ok(result.includes('Alice open task'), 'should find alice task in tasks table');
    });
  });

  // ── 4. backfill migration ────────────────────────────────────

  describe('backfill migration simulation', () => {
    let backfillTmpDir: string;
    let backfillDb: ReturnType<typeof getDatabase>;

    before(() => {
      backfillTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-backfill-'));
      _resetDbForTesting();
      _resetConfigForTesting();
      openDatabase(backfillTmpDir, path.join(backfillTmpDir, 'test.db'));
      backfillDb = getDatabase();

      // Seed: mix of NULL-source and already-sourced todos
      backfillDb.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Null source 1', NULL, 'pending', 'medium')",
      ).run();
      backfillDb.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Null source 2', NULL, 'pending', 'low')",
      ).run();
      backfillDb.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('todo', 'Already sourced', 'alice', 'pending', 'medium')",
      ).run();
      // A non-todo task (orchestrator kind) with NULL source — must NOT be touched
      backfillDb.prepare(
        "INSERT INTO tasks (kind, title, source, status, priority) VALUES ('orchestrator', 'Orch task', NULL, 'pending', 'medium')",
      ).run();
    });

    after(() => {
      _resetDbForTesting();
      _resetConfigForTesting();
      fs.rmSync(backfillTmpDir, { recursive: true, force: true });
    });

    it('backfill UPDATE stamps a source value on NULL-source todos, leaves others untouched', () => {
      // This tests the generic pattern used by instance-specific backfill migrations:
      // UPDATE tasks SET source=<agent-name> WHERE kind='todo' AND source IS NULL
      const backfillSource = 'my-agent';
      backfillDb.prepare(
        `UPDATE tasks SET source='${backfillSource}' WHERE kind='todo' AND source IS NULL`,
      ).run();

      // NULL-source todos should now have the backfill value
      const nullTodos = backfillDb.prepare(
        "SELECT source FROM tasks WHERE kind='todo' AND title LIKE 'Null source%'",
      ).all() as { source: string }[];
      assert.equal(nullTodos.length, 2, 'should have 2 previously-null todos');
      for (const row of nullTodos) {
        assert.equal(row.source, backfillSource, 'previously null-source todo should now be stamped');
      }

      // Already-sourced row must be untouched
      const alice = backfillDb.prepare(
        "SELECT source FROM tasks WHERE kind='todo' AND title='Already sourced'",
      ).get() as { source: string } | undefined;
      assert.ok(alice, 'alice row should still exist');
      assert.equal(alice.source, 'alice', 'already-sourced row must not be overwritten');

      // Orchestrator task with NULL source must NOT be touched
      const orchRow = backfillDb.prepare(
        "SELECT source FROM tasks WHERE kind='orchestrator' AND title='Orch task'",
      ).get() as { source: string | null } | undefined;
      assert.ok(orchRow, 'orchestrator row should still exist');
      assert.equal(orchRow.source, null, 'orchestrator task source must remain null');
    });
  });

});
