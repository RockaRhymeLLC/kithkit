/**
 * metrics-ingest: POST /api/metrics/ingest
 *
 * Tests the remote metrics ingestion endpoint — validation, upsert/merge
 * behaviour, shared-secret auth, and per-agent rate limiting.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDatabase, _resetDbForTesting, query } from '../core/db.js';
import { _resetConfigForTesting } from '../core/config.js';
import { handleMetricsRoute, _resetIngestRateLimitForTesting } from '../api/metrics.js';

const TEST_PORT = 19895;

// ── HTTP helpers ──────────────────────────────────────────────

interface Response {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(payload !== undefined
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        'Connection': 'close',
        ...extraHeaders,
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

// ── Test server ───────────────────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-metrics-ingest-'));
  _resetDbForTesting();
  _resetConfigForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT}`);
    res.setHeader('X-Timestamp', new Date().toISOString());
    handleMetricsRoute(inReq, res, url.pathname, url.searchParams)
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

  return new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
}

function teardown(): Promise<void> {
  _resetIngestRateLimitForTesting();
  _resetConfigForTesting();
  delete process.env['METRICS_INGEST_KEY'];
  return new Promise<void>((resolve) => {
    server.close(() => {
      _resetDbForTesting();
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

// ── Shared row fixture ────────────────────────────────────────

const sampleRow = {
  hour: '2026-03-02 14:00',
  endpoint: '/api/todos',
  method: 'GET',
  total_requests: 42,
  success_count: 40,
  error_4xx: 2,
  error_5xx: 0,
  avg_latency_ms: 3.5,
  p95_latency_ms: 12.0,
};

// ── Tests ─────────────────────────────────────────────────────

describe('POST /api/metrics/ingest', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns 404 for unrelated route', async () => {
    const res = await request('POST', '/api/other');
    assert.equal(res.status, 404);
  });

  it('returns 400 when agent field is missing', async () => {
    const res = await request('POST', '/api/metrics/ingest', { hourly: [sampleRow] });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('agent'));
  });

  it('returns 400 when hourly field is missing', async () => {
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2' });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('hourly'));
  });

  it('returns 400 when hourly is not an array', async () => {
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: 'bad' });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('hourly'));
  });

  it('returns 400 when hourly array exceeds 500 items', async () => {
    const tooMany = Array.from({ length: 501 }, () => ({ ...sampleRow }));
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: tooMany });
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('500'));
  });

  it('returns 400 when body is invalid JSON', async () => {
    const payload = 'not-json';
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/metrics/ingest',
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'close',
      },
    };
    const res = await new Promise<Response>((resolve, reject) => {
      const r = http.request(opts, (response) => {
        let data = '';
        response.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: data, headers: response.headers }),
        );
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });
    assert.equal(res.status, 400);
  });

  it('ingests a single valid row and returns ingested count', async () => {
    const res = await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [sampleRow],
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ingested, 1);
    assert.equal(body.agent, 'r2');
    assert.ok(body.timestamp, 'response should include timestamp');
  });

  it('stores the row in api_metrics_hourly with correct agent_id', async () => {
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [sampleRow],
    });
    const rows = query<{ agent_id: string; total_requests: number; success_count: number }>(
      `SELECT agent_id, total_requests, success_count
       FROM api_metrics_hourly
       WHERE hour = ? AND endpoint = ? AND method = ?`,
      sampleRow.hour, sampleRow.endpoint, sampleRow.method,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent_id, 'r2');
    assert.equal(rows[0]!.total_requests, 42);
    assert.equal(rows[0]!.success_count, 40);
  });

  it('ingests multiple rows in one batch', async () => {
    const rows = [
      { ...sampleRow, endpoint: '/api/todos', total_requests: 10 },
      { ...sampleRow, endpoint: '/api/calendar', total_requests: 5 },
      { ...sampleRow, endpoint: '/api/messages', total_requests: 3 },
    ];
    const res = await request('POST', '/api/metrics/ingest', { agent: 'skippy', hourly: rows });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ingested, 3);
  });

  it('silently skips rows missing required fields', async () => {
    const badRows = [
      { endpoint: '/api/todos', method: 'GET', total_requests: 5 }, // missing hour
      { hour: '2026-03-02 15:00', method: 'GET', total_requests: 5 }, // missing endpoint
      { hour: '2026-03-02 15:00', endpoint: '/api/todos', total_requests: 5 }, // missing method
      { hour: '2026-03-02 15:00', endpoint: '/api/todos', method: 'GET' }, // missing total_requests
      sampleRow, // valid
    ];
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: badRows });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ingested, 1, 'Only the valid row should be ingested');
  });

  it('upsert: second ingest replaces counts and keeps max p95', async () => {
    // First ingest
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [{ ...sampleRow, total_requests: 10, p95_latency_ms: 5.0 }],
    });

    // Second ingest with higher p95 — p95 should be kept as MAX
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [{ ...sampleRow, total_requests: 20, p95_latency_ms: 25.0 }],
    });

    const rows = query<{ total_requests: number; p95_latency_ms: number }>(
      `SELECT total_requests, p95_latency_ms
       FROM api_metrics_hourly
       WHERE hour = ? AND endpoint = ? AND method = ? AND agent_id = 'r2'`,
      sampleRow.hour, sampleRow.endpoint, sampleRow.method,
    );
    assert.equal(rows.length, 1, 'Should be one row after upsert');
    assert.equal(rows[0]!.total_requests, 20, 'total_requests should be replaced');
    assert.equal(rows[0]!.p95_latency_ms, 25.0, 'p95 should be kept as max');
  });

  it('upsert: second ingest with lower p95 keeps the higher existing value', async () => {
    // First ingest with high p95
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [{ ...sampleRow, p95_latency_ms: 50.0 }],
    });

    // Second ingest with lower p95
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [{ ...sampleRow, p95_latency_ms: 5.0 }],
    });

    const rows = query<{ p95_latency_ms: number }>(
      `SELECT p95_latency_ms
       FROM api_metrics_hourly
       WHERE hour = ? AND endpoint = ? AND method = ? AND agent_id = 'r2'`,
      sampleRow.hour, sampleRow.endpoint, sampleRow.method,
    );
    assert.equal(rows[0]!.p95_latency_ms, 50.0, 'p95 should be kept as max of old and new');
  });

  it('different agents store separate rows for the same hour/endpoint/method', async () => {
    await request('POST', '/api/metrics/ingest', {
      agent: 'r2',
      hourly: [{ ...sampleRow, total_requests: 100 }],
    });
    await request('POST', '/api/metrics/ingest', {
      agent: 'skippy',
      hourly: [{ ...sampleRow, total_requests: 200 }],
    });

    const rows = query<{ agent_id: string; total_requests: number }>(
      `SELECT agent_id, total_requests
       FROM api_metrics_hourly
       WHERE hour = ? AND endpoint = ? AND method = ?
       ORDER BY agent_id`,
      sampleRow.hour, sampleRow.endpoint, sampleRow.method,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.agent_id, 'r2');
    assert.equal(rows[0]!.total_requests, 100);
    assert.equal(rows[1]!.agent_id, 'skippy');
    assert.equal(rows[1]!.total_requests, 200);
  });

  it('optional numeric fields default to 0 when omitted', async () => {
    const minimalRow = {
      hour: '2026-03-02 16:00',
      endpoint: '/api/health',
      method: 'GET',
      total_requests: 7,
    };
    await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [minimalRow] });

    const rows = query<{
      success_count: number;
      error_4xx: number;
      error_5xx: number;
      avg_latency_ms: number;
      p95_latency_ms: number;
    }>(
      `SELECT success_count, error_4xx, error_5xx, avg_latency_ms, p95_latency_ms
       FROM api_metrics_hourly
       WHERE hour = ? AND endpoint = ? AND method = ? AND agent_id = 'r2'`,
      minimalRow.hour, minimalRow.endpoint, minimalRow.method,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.success_count, 0);
    assert.equal(rows[0]!.error_4xx, 0);
    assert.equal(rows[0]!.error_5xx, 0);
    assert.equal(rows[0]!.avg_latency_ms, 0);
    assert.equal(rows[0]!.p95_latency_ms, 0);
  });

  it('accepts an empty hourly array and returns ingested: 0', async () => {
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [] });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ingested, 0);
  });

  // ── Auth ──────────────────────────────────────────────────

  it('accepts request without key when METRICS_INGEST_KEY is not set', async () => {
    delete process.env['METRICS_INGEST_KEY'];
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [sampleRow] });
    assert.equal(res.status, 200);
  });

  it('returns 401 when key is required but missing', async () => {
    process.env['METRICS_INGEST_KEY'] = 'secret123';
    const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [sampleRow] });
    assert.equal(res.status, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.toLowerCase().includes('key'));
  });

  it('returns 401 when key is wrong', async () => {
    process.env['METRICS_INGEST_KEY'] = 'secret123';
    const res = await request(
      'POST', '/api/metrics/ingest',
      { agent: 'r2', hourly: [sampleRow] },
      { 'X-Metrics-Key': 'wrongkey' },
    );
    assert.equal(res.status, 401);
  });

  it('accepts request when correct key is provided', async () => {
    process.env['METRICS_INGEST_KEY'] = 'secret123';
    const res = await request(
      'POST', '/api/metrics/ingest',
      { agent: 'r2', hourly: [sampleRow] },
      { 'X-Metrics-Key': 'secret123' },
    );
    assert.equal(res.status, 200);
  });

  // ── Rate limiting ─────────────────────────────────────────

  it('returns 429 after more than 10 requests per minute from same agent', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [] });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429, '11th+ request should be rate-limited');
  });

  it('rate limit is per-agent — different agents are tracked independently', async () => {
    // Exhaust r2's limit
    for (let i = 0; i < 11; i++) {
      await request('POST', '/api/metrics/ingest', { agent: 'r2', hourly: [] });
    }
    // skippy should still be allowed
    const res = await request('POST', '/api/metrics/ingest', { agent: 'skippy', hourly: [] });
    assert.equal(res.status, 200, 'skippy should not be affected by r2 rate limit');
  });
});
