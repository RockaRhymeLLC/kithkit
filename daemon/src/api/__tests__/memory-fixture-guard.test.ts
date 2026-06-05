/**
 * Regression tests for memory-fixture-guard (kithkit#301).
 *
 * Two layers of coverage:
 *   1. Unit: isCanaryOrFixtureContent() predicate — fast, no DB.
 *   2. Integration: POST /api/memory/store returns 200 (skipped) for fixture content
 *      and 201 (stored) for legitimate content, via a real in-memory DB + HTTP server.
 *
 * These tests prove that:
 *   - Known canary/fixture content is blocked at the extraction layer.
 *   - Legitimate operational content is NOT blocked.
 *   - The skipped response shape is correct (action: 'skipped_fixture_content').
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { isCanaryOrFixtureContent, FIXTURE_PATTERNS } from '../memory-fixture-guard.js';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { handleMemoryRoute } from '../memory.js';

// ── HTTP helper ───────────────────────────────────────────────

const TEST_PORT = 19891;

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
        Connection: 'close',
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

// ── Unit tests: isCanaryOrFixtureContent() ────────────────────

describe('isCanaryOrFixtureContent — unit', () => {

  // ── Canary content that MUST be detected ─────────────────────

  it('rejects alice@example.com (RFC 2606 test domain)', () => {
    assert.ok(isCanaryOrFixtureContent('alice@example.com is a safe sender'));
  });

  it('rejects eve@example.com (RFC 2606 test domain, blocked sender canary)', () => {
    assert.ok(isCanaryOrFixtureContent('eve@example.com is in the blocked list'));
  });

  it('rejects bob@example.com (RFC 2606 test domain)', () => {
    assert.ok(isCanaryOrFixtureContent('recipient is bob@example.com'));
  });

  it('rejects @example.org (RFC 2606 alt TLD)', () => {
    assert.ok(isCanaryOrFixtureContent('test@example.org sent a message'));
  });

  it('rejects @example.net (RFC 2606 alt TLD)', () => {
    assert.ok(isCanaryOrFixtureContent('user@example.net is registered'));
  });

  it('rejects canary-regression-guard-test (literal tmux canary)', () => {
    assert.ok(isCanaryOrFixtureContent('injected canary-regression-guard-test into session'));
  });

  it('rejects KITHKIT_ALLOW_TEST_INJECT (test env var)', () => {
    assert.ok(isCanaryOrFixtureContent('KITHKIT_ALLOW_TEST_INJECT=1 was set during run'));
  });

  it('rejects KITHKIT_SUPPRESS_NOTIFICATIONS (test isolation env var)', () => {
    assert.ok(isCanaryOrFixtureContent('KITHKIT_SUPPRESS_NOTIFICATIONS must be unset'));
  });

  it('rejects mixed-case @example.COM (case-insensitive domain match)', () => {
    assert.ok(isCanaryOrFixtureContent('alice@EXAMPLE.COM is in the allow-list'));
  });

  it('rejects content where fixture string is embedded mid-sentence', () => {
    assert.ok(
      isCanaryOrFixtureContent(
        'Approved email recipients: alice@example.com, bob@example.com',
      ),
    );
  });

  // ── Real operational content that MUST NOT be detected ───────

  it('allows legitimate production memory (api fact)', () => {
    assert.equal(isCanaryOrFixtureContent('POST /api/memory/store accepts content, category, and tags fields'), false);
  });

  it('allows memory referencing real email domains', () => {
    assert.equal(isCanaryOrFixtureContent('Dave prefers replies from dave@acme.co'), false);
  });

  it('allows memory about plan-approval workflow (production context)', () => {
    assert.equal(
      isCanaryOrFixtureContent(
        '[plan approval needed] Task "Deploy v2.3" requires review before proceeding.',
      ),
      false,
    );
  });

  it('allows memory about access control without canary emails', () => {
    assert.equal(
      isCanaryOrFixtureContent(
        'Access control audit verified: all A2A messages signed correctly.',
      ),
      false,
    );
  });

  it('allows memory referencing alice as a real person name (no email domain)', () => {
    assert.equal(
      isCanaryOrFixtureContent('Alice approved the design proposal in Slack.'),
      false,
    );
  });

  it('allows memory about test environment setup (no fixture strings)', () => {
    assert.equal(
      isCanaryOrFixtureContent(
        'Unit tests use an in-memory SQLite DB via openDatabase() to avoid touching production state.',
      ),
      false,
    );
  });

  it('allows empty string (vacuously safe)', () => {
    assert.equal(isCanaryOrFixtureContent(''), false);
  });

  // ── Structural: FIXTURE_PATTERNS is non-empty ─────────────────

  it('FIXTURE_PATTERNS exports a non-empty array', () => {
    assert.ok(Array.isArray(FIXTURE_PATTERNS));
    assert.ok(FIXTURE_PATTERNS.length > 0);
  });
});

// ── Integration tests: POST /api/memory/store ────────────────

describe('POST /api/memory/store — fixture guard integration', () => {
  let server: http.Server;
  let tmpDir: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-guard-test-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    server = http.createServer((req, res) => {
      handleMemoryRoute(req, res, req.url ?? '/').catch(() => {
        if (!res.headersSent) res.writeHead(500).end('internal error');
      });
    });
    await new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Canary content → skipped (200, not 201) ───────────────────

  it('returns 200 skipped_fixture_content for alice@example.com content', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'alice@example.com is a verified safe sender in the access control list',
      category: 'technical',
      source: 'auto-extraction',
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(parsed.action, 'skipped_fixture_content');
    assert.ok(typeof parsed.message === 'string' && parsed.message.length > 0);
  });

  it('returns 200 skipped_fixture_content for eve@example.com content', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'eve@example.com is in the blocked senders list per access control fixture',
      source: 'transcript',
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(parsed.action, 'skipped_fixture_content');
  });

  it('returns 200 skipped_fixture_content for canary-regression-guard-test string', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'session received canary-regression-guard-test injection confirming guard is active',
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(parsed.action, 'skipped_fixture_content');
  });

  it('returns 200 skipped_fixture_content for KITHKIT_ALLOW_TEST_INJECT mention', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'set KITHKIT_ALLOW_TEST_INJECT=1 to enable real-inject assertions in tmux tests',
      source: 'auto-extraction',
    });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(parsed.action, 'skipped_fixture_content');
  });

  it('does NOT store fixture content in the DB (guard fires before insert)', async () => {
    const unique = `alice@example.com unique-marker-${Date.now()}`;
    const storeRes = await request('POST', '/api/memory/store', { content: unique });
    assert.equal(storeRes.status, 200);
    assert.equal(JSON.parse(storeRes.body).action, 'skipped_fixture_content');

    // Search should return zero results for the unique marker
    const searchRes = await request('POST', '/api/memory/search', {
      query: unique,
      mode: 'keyword',
    });
    assert.equal(searchRes.status, 200);
    const searchBody = JSON.parse(searchRes.body) as { data?: unknown[] };
    assert.equal((searchBody.data ?? []).length, 0, 'fixture content must not appear in search results');
  });

  // ── Legitimate content → stored (201) ─────────────────────────

  it('returns 201 and stores legitimate operational content', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'POST /api/memory/store accepts content, category, tags, and source fields.',
      category: 'api-format',
      tags: ['memory', 'api'],
      source: 'auto-extraction',
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.body}`);
    const parsed = JSON.parse(res.body) as { id?: number; content?: string };
    assert.ok(typeof parsed.id === 'number', 'response should include id');
    assert.ok(parsed.content?.includes('POST /api/memory/store'));
  });

  it('returns 201 for plan-approval workflow memory (no canary strings)', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'Plan approval flow: orchestrator submits plan, comms reviews, approve or reject via API.',
      category: 'process',
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}: ${res.body}`);
  });

  it('returns 400 for missing content (guard does not interfere with validation)', async () => {
    const res = await request('POST', '/api/memory/store', { category: 'technical' });
    assert.equal(res.status, 400);
  });
});
