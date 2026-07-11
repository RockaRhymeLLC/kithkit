/**
 * embed-queue-full-fallback.test.ts — Mutation-killing tests for kithkit#509.
 *
 * When the embed-worker queue is full (QUEUE_MAX reached), vector and hybrid
 * memory searches must NOT error the request. Instead, they must gracefully
 * degrade to keyword search and return results with `degraded: 'keyword-fallback'`
 * in the response body.
 *
 * CATCH POINT: daemon/src/api/memory.ts — handleMemoryRoute, inside the
 * `mode === 'vector'` and `mode === 'hybrid'` branches. The endpoint handler is
 * the cleanest catch point because:
 *   1. The degraded flag naturally belongs in the HTTP response body.
 *   2. All HTTP callers (API route, memory-context hook, etc.) benefit
 *      from a single catch location.
 *   3. vectorSearch/hybridSearch return-type signatures remain unchanged.
 *
 * MUTATION-KILL shape:
 *   - Revert: comment out the try/catch and let errors propagate.
 *   - Expected RED: both tests fail because the server returns 500
 *     (unhandled queue-full error) instead of 200 with keyword results.
 *   - Proof provided in test comments + PR description.
 *
 * HARD CONSTRAINT RESPECTED: QUEUE_MAX is untouched; embed-worker
 * serialization/bounded-queue backpressure is untouched. This fix is
 * backpressure HANDLING only.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, insert } from '../../core/db.js';
import {
  handleMemoryRoute,
  _setVectorEnabledForTesting,
  _setVectorSearchFnForTesting,
  _setHybridSearchFnForTesting,
  _resetVectorForTesting,
} from '../memory.js';

const TEST_PORT = 19910;

// ── HTTP helpers ─────────────────────────────────────────────

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
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
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── Server lifecycle ─────────────────────────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-509-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://127.0.0.1:${TEST_PORT}`);
    handleMemoryRoute(inReq, res, url.pathname)
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
  _resetVectorForTesting();
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

/** Insert a memory directly into the DB for keyword-search matching. */
function seedMemory(content: string): void {
  insert('memories', {
    content,
    category: 'fact',
    tags: '[]',
    source: 'test',
    embedding: null,
  });
}

// ── Shared queue-full mock ────────────────────────────────────

const QUEUE_FULL_ERROR = new Error('embed-worker: request queue full');

// ── Suite: vector mode queue-full → keyword fallback ─────────

describe('memory-search vector→keyword fallback on embed queue full (#509)', { concurrency: 1 }, () => {
  before(setup);
  after(teardown);

  beforeEach(() => {
    // Enable vector search path so the handler enters the vector/hybrid branch
    // (without this it short-circuits at the "Vector search not initialized" 503 guard).
    _setVectorEnabledForTesting(true);

    // Inject a vectorSearch mock that throws the exact queue-full error.
    // MUTATION TARGET: the try/catch block that catches this and falls back.
    // Without the try/catch, this error propagates to the HTTP server catch
    // and the client gets a 500 instead of 200.
    _setVectorSearchFnForTesting(() => Promise.reject(QUEUE_FULL_ERROR));
  });

  afterEach(() => {
    _resetVectorForTesting();
  });

  it('[mutation-kill] returns 200 with keyword results and degraded flag when embed queue is full (vector mode)', async () => {
    // Seed a memory that the keyword fallback will find
    seedMemory('the orchestrator handles task decomposition and worker spawning');

    const res = await request('POST', '/api/memory/search', {
      query: 'orchestrator task',
      mode: 'vector',
    });

    // MUTATION KILL: without the try/catch fallback, this is 500 (queue-full
    // propagates as an unhandled error). With the fallback it is 200.
    assert.equal(res.status, 200,
      `expected 200 from keyword fallback, got ${res.status}; ` +
      `body: ${JSON.stringify(res.body)}`);

    const body = res.body as Record<string, unknown>;

    // mode must be 'keyword' (not 'vector' — vector path threw)
    assert.equal(body.mode, 'keyword',
      `expected mode='keyword' (degraded), got '${body.mode}'`);

    // degraded flag must be present and set to 'keyword-fallback'
    assert.equal(body.degraded, 'keyword-fallback',
      `expected degraded='keyword-fallback', got '${String(body.degraded)}'`);

    // data must be an array with actual content (not empty, not an error object)
    // This makes the test non-vacuous: if fallback returns empty default we catch it.
    const data = body.data as unknown[];
    assert.ok(Array.isArray(data), `expected data to be an array, got ${typeof data}`);
    assert.ok(data.length > 0,
      'expected at least one keyword result — seed memory must be found; ' +
      'if data is empty the fallback may have used an empty/wrong query');

    // Each result must have content (not just IDs or error objects)
    const first = data[0] as Record<string, unknown>;
    assert.ok(typeof first['content'] === 'string' && first['content'].length > 0,
      `expected result to have content string, got: ${JSON.stringify(first)}`);
  });

  it('[mutation-kill] non-queue-full embedding errors still propagate as 500 (not silently swallowed)', async () => {
    // A different error (not queue-full) must NOT be caught by the fallback.
    // This guards against accidentally blanket-catching all embedding errors.
    _setVectorSearchFnForTesting(() => Promise.reject(new Error('ONNX model crashed')));

    const res = await request('POST', '/api/memory/search', {
      query: 'any query',
      mode: 'vector',
    });

    // Without the specificity guard (`if (!isEmbedQueueFull(err)) throw err`),
    // this would wrongly return 200 (all errors caught). With the guard, non-
    // queue-full errors propagate and produce a 500.
    assert.equal(res.status, 500,
      `expected 500 for non-queue-full error, got ${res.status}; ` +
      'if 200, the catch is blanket instead of specific');
  });
});

// ── Suite: hybrid mode queue-full → keyword fallback ─────────

describe('memory-search hybrid→keyword fallback on embed queue full (#509)', { concurrency: 1 }, () => {
  before(setup);
  after(teardown);

  beforeEach(() => {
    _setVectorEnabledForTesting(true);
    // hybridSearch combines vector + keyword; when queue is full, hybridSearch
    // itself rejects because it calls vectorSearch internally.
    _setHybridSearchFnForTesting(() => Promise.reject(QUEUE_FULL_ERROR));
  });

  afterEach(() => {
    _resetVectorForTesting();
  });

  it('[mutation-kill] returns 200 with keyword results and degraded flag when embed queue is full (hybrid mode)', async () => {
    seedMemory('daemon memory API exposes keyword vector and hybrid search modes');

    const res = await request('POST', '/api/memory/search', {
      query: 'daemon keyword',
      mode: 'hybrid',
    });

    // MUTATION KILL: without the fallback, this is 500.
    assert.equal(res.status, 200,
      `expected 200 from keyword fallback, got ${res.status}; ` +
      `body: ${JSON.stringify(res.body)}`);

    const body = res.body as Record<string, unknown>;

    assert.equal(body.mode, 'keyword',
      `expected mode='keyword' (degraded from hybrid), got '${body.mode}'`);

    assert.equal(body.degraded, 'keyword-fallback',
      `expected degraded='keyword-fallback', got '${String(body.degraded)}'`);

    const data = body.data as unknown[];
    assert.ok(Array.isArray(data), `expected data array, got ${typeof data}`);
    assert.ok(data.length > 0,
      'expected at least one keyword result from fallback; ' +
      'if empty, the seed memory content does not match the query');

    const first = data[0] as Record<string, unknown>;
    assert.ok(typeof first['content'] === 'string' && first['content'].length > 0,
      `expected result content string, got: ${JSON.stringify(first)}`);
  });

  it('[mutation-kill] non-queue-full hybrid errors still propagate as 500', async () => {
    _setHybridSearchFnForTesting(() => Promise.reject(new Error('sqlite-vec internal error')));

    const res = await request('POST', '/api/memory/search', {
      query: 'any query',
      mode: 'hybrid',
    });

    assert.equal(res.status, 500,
      `expected 500 for non-queue-full error, got ${res.status}; ` +
      'if 200, the catch is blanket instead of specific');
  });
});
