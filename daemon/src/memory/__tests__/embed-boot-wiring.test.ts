/**
 * embed-boot-wiring.test.ts — Mutation-killing tests for #513 (Fix B only).
 *
 * NOTE: This file originally also carried a source-inspection test for
 * Fix A (extensions/index.ts boot wiring). That test is intentionally
 * excluded here — Fix A ships in a separate follow-up PR. Only the
 * bounded queue-wait timeout (Fix B) is covered below.
 *
 * 1. BOUNDED QUEUE WAIT: embed() must reject with 'embed-worker: request
 *    queue full' within QUEUE_WAIT_TIMEOUT_MS when no worker is running.
 *    Without this, queued requests wait indefinitely (HTTP hang).
 *
 *    MUTATION KILL: Remove the waitTimer from embed-client.ts QueuedRequest
 *    → the embed() promise never rejects → the test hangs and times out = RED.
 *
 * 2. END-TO-END FALLBACK: when the embed worker is not started and the queue
 *    times out, a hybrid memory search must return 200 with keyword results
 *    and degraded: 'keyword-fallback' instead of hanging.
 *
 *    MUTATION KILL: Remove the waitTimer from embed-client.ts → embed() hangs
 *    → hybridSearch hangs → HTTP response never arrives → test times out = RED.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use fake mode so no real ONNX model is loaded.
process.env['KITHKIT_EMBED_FAKE'] = '1';

import { embed, _resetForTesting as resetEmbedClient } from '../embed-client.js';
import { openDatabase, _resetDbForTesting, insert } from '../../core/db.js';
import {
  handleMemoryRoute,
  enableVectorSearch,
  _setVectorEnabledForTesting,
  _resetVectorForTesting,
} from '../../api/memory.js';

// ── Test 1: Bounded queue-wait timeout ────────────────────────
//
// With no worker started, embed() must reject within QUEUE_WAIT_TIMEOUT_MS.
//
// MUTATION KILL: Remove the waitTimer from embed-client.ts → embed() never
// rejects → this test times out (test framework marks it FAIL at timeout=15s).

describe('embed-client: queue-wait timeout rejects when no worker is running (#513)', {
  concurrency: 1,
  timeout: 15_000,
}, () => {
  before(() => {
    resetEmbedClient(); // ensure no worker is running
  });

  after(() => {
    resetEmbedClient();
  });

  it('[mutation-kill] embed() rejects with queue-full within 12s when no worker is started', async () => {
    const start = Date.now();
    // QUEUE_WAIT_TIMEOUT_MS = 10_000; allow 2s scheduler slack
    const MAX_EXPECTED_MS = 12_000;

    let threw = false;
    let errorMsg = '';
    try {
      await embed('test text for queue-wait timeout check');
    } catch (err) {
      threw = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    const elapsed = Date.now() - start;

    assert.ok(threw,
      'embed() must throw when no worker is started (missing waitTimer — mutation detected)');

    // Error must match what the #510 keyword fallback catches.
    assert.ok(
      errorMsg.includes('embed-worker: request queue full'),
      `expected error containing 'embed-worker: request queue full', got: ${errorMsg}`,
    );

    assert.ok(
      elapsed < MAX_EXPECTED_MS,
      `embed() must reject within ${MAX_EXPECTED_MS}ms; took ${elapsed}ms — ` +
      'possible missing waitTimer (queue-wait timeout not set)',
    );
  });
});

// ── Test 2: End-to-end keyword fallback via queue timeout ─────
//
// When the embed worker is not running and the queue wait times out, a hybrid
// memory search must degrade gracefully to keyword results (200, not hang).
//
// This is the end-to-end proof that Fix B (queue-wait timeout) correctly
// triggers the existing #510 keyword fallback.
//
// MUTATION KILL: Remove the waitTimer from embed-client.ts → embed() hangs
// → hybridSearch hangs → HTTP request hangs → test times out = RED.

const TEST_PORT = 19914;

describe('memory-search hybrid: keyword fallback via queue-wait timeout (#513)', {
  concurrency: 1,
  timeout: 20_000,
}, () => {
  let server: http.Server;
  let tmpDir: string;

  before(async () => {
    resetEmbedClient(); // no worker started
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-513-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Initialize sqlite-vec and enable vector search
    enableVectorSearch();
    // Mark _vectorEnabled = true so the handler enters the hybrid/vector branch
    _setVectorEnabledForTesting(true);

    // Seed a memory the keyword fallback can find
    insert('memories', {
      content: 'embed worker boot wiring is required for hybrid search to work',
      category: 'fact',
      tags: '[]',
      source: 'test',
      embedding: null,
    });

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

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, '127.0.0.1', resolve);
    });
  });

  after(async () => {
    _resetVectorForTesting();
    _resetDbForTesting();
    resetEmbedClient();
    await new Promise<void>((resolve) => {
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
  });

  it('[mutation-kill] hybrid search returns 200 keyword results when embed queue times out (no worker running)', async () => {
    // The real hybridSearch → vectorSearch → generateEmbedding → embed() path runs.
    // embed() queues the request. After QUEUE_WAIT_TIMEOUT_MS (10s) the timer fires,
    // embed() rejects with 'embed-worker: request queue full', hybridSearch propagates,
    // and the memory route catches it and falls back to keyword search.
    //
    // WITHOUT the waitTimer (mutation): embed() never rejects → hybridSearch never
    // returns → HTTP response never arrives → request times out here = RED.

    const REQUEST_TIMEOUT_MS = 13_000; // slightly longer than QUEUE_WAIT_TIMEOUT_MS

    const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: TEST_PORT,
        path: '/api/memory/search',
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'close',
        },
      }, (res) => {
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
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(
          'HTTP request timed out — embed() likely hung (missing waitTimer in embed-client.ts)',
        ));
      });
      req.write(JSON.stringify({ query: 'embed worker boot wiring', mode: 'hybrid' }));
      req.end();
    });

    // If waitTimer is missing (mutation), we never reach here — test fails with timeout above.
    assert.equal(result.status, 200,
      `expected 200 from keyword fallback; got ${result.status}; body: ${JSON.stringify(result.body)}`);

    const body = result.body as Record<string, unknown>;

    assert.equal(body['mode'], 'keyword',
      `expected mode='keyword' (degraded from hybrid); got '${String(body['mode'])}'`);

    assert.equal(body['degraded'], 'keyword-fallback',
      `expected degraded='keyword-fallback'; got '${String(body['degraded'])}'`);

    const data = body['data'] as unknown[];
    assert.ok(Array.isArray(data), `expected data array; got ${typeof data}`);
    assert.ok(data.length > 0,
      'expected at least one keyword result from fallback; seed memory not found');

    const first = data[0] as Record<string, unknown>;
    assert.ok(typeof first['content'] === 'string' && (first['content'] as string).length > 0,
      `expected result content string; got: ${JSON.stringify(first)}`);
  });
});
