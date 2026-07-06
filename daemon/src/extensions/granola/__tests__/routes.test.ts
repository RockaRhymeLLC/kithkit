/**
 * Granola routes tests — GET /api/granola/notes pagination.
 *
 * granola_notes has no core migration in this repo (the extension owns its
 * own schema as a hot-loadable plugin), so the fixture table is created
 * directly here for test isolation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, getDatabase, _resetDbForTesting } from '../../../core/db.js';
import { handleGranolaNotes } from '../routes.js';

const TEST_PORT = 19871;

function request(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method: 'GET',
        timeout: 5000,
        headers: { 'Connection': 'close' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

let server: http.Server;
let tmpDir: string;

function ensureNotesTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS granola_notes (
      note_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary_markdown TEXT,
      summary_text TEXT,
      web_url TEXT,
      calendar_event_id TEXT,
      event_title TEXT,
      scheduled_start_time TEXT,
      scheduled_end_time TEXT,
      organiser TEXT,
      attendees_json TEXT,
      owner_email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
}

/** Seed `count` notes with distinct, monotonically decreasing scheduled_start_time
 * (so DESC ordering is deterministic: note-0 is newest, note-{count-1} is oldest). */
function seedNotes(count: number): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO granola_notes
      (note_id, title, scheduled_start_time, created_at, updated_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < count; i++) {
    // Later index -> earlier time, so ORDER BY scheduled_start_time DESC yields note-0 first.
    const scheduled = new Date(Date.UTC(2026, 0, 1, 0, 0, count - i)).toISOString();
    stmt.run(`note-${i}`, `Note ${i}`, scheduled, now, now, now);
  }
}

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-granola-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  ensureNotesTable();

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    handleGranolaNotes(inReq, res, url.pathname, url.searchParams)
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

describe('Granola notes pagination', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns the 20 newest notes by default (unchanged behavior)', async () => {
    seedNotes(30);
    const res = await request('/api/granola/notes');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 20);
    assert.equal(body.data[0].note_id, 'note-0');
    assert.equal(body.data[19].note_id, 'note-19');
  });

  it('honors the limit param', async () => {
    seedNotes(30);
    const res = await request('/api/granola/notes?limit=5');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].note_id, 'note-0');
    assert.equal(body.data[4].note_id, 'note-4');
  });

  it('pages through a full fixture of more than 20 rows with no gaps or overlaps', async () => {
    const TOTAL = 46;
    seedNotes(TOTAL);
    const pageSize = 10;
    const seen: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += pageSize) {
      const res = await request(`/api/granola/notes?limit=${pageSize}&offset=${offset}`);
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      for (const note of body.data) seen.push(note.note_id);
    }
    // No gaps or overlaps: union of all pages equals the full seeded set, each exactly once.
    assert.equal(seen.length, TOTAL);
    assert.deepEqual(
      [...seen].sort(),
      Array.from({ length: TOTAL }, (_, i) => `note-${i}`).sort(),
    );
  });

  it('returns an empty array with HTTP 200 for an out-of-range offset', async () => {
    seedNotes(10);
    const res = await request('/api/granola/notes?limit=20&offset=1000');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data, []);
  });

  it('clamps a negative offset to 0 instead of erroring', async () => {
    seedNotes(5);
    const res = await request('/api/granola/notes?offset=-5');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].note_id, 'note-0');
  });

  it('clamps limit above the 200 upper bound', async () => {
    seedNotes(201);
    const res = await request('/api/granola/notes?limit=99999');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 200);
  });

  it('falls back to default limit on non-numeric limit input', async () => {
    seedNotes(30);
    const res = await request('/api/granola/notes?limit=abc');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 20);
  });

  it('clamps limit=0 up to 1 instead of returning zero rows', async () => {
    seedNotes(5);
    const res = await request('/api/granola/notes?limit=0');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].note_id, 'note-0');
  });

  it('falls back offset to 0 on non-numeric offset input', async () => {
    seedNotes(5);
    const res = await request('/api/granola/notes?offset=abc');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 5);
    assert.equal(body.data[0].note_id, 'note-0');
  });

  it('falls back to default limit on empty-string limit param', async () => {
    seedNotes(30);
    const res = await request('/api/granola/notes?limit=');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 20);
  });

  it('still honors the date filter branch (unaffected by pagination change)', async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO granola_notes (note_id, title, scheduled_start_time, created_at, updated_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('note-date', 'Dated note', '2026-03-15T10:00:00.000Z', now, now, now);

    const res = await request('/api/granola/notes?date=2026-03-15');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].note_id, 'note-date');
  });
});
