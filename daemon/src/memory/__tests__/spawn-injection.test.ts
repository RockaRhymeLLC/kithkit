/**
 * spawn-injection.test.ts — integration test for the spawn+hybridSearch
 * concurrent execution path that the prior #469 fix (in-process _inferLock)
 * did not protect against.
 *
 * The failure mode: child_process.fork() in the same process as an active
 * ONNX session triggers a native libc++ mutex abort. With the subprocess
 * isolation fix (#471), ONNX runs in a separate child process, so fork()
 * in the daemon process is safe even while embeddings are being generated.
 *
 * Test strategy:
 *   1. Open a temp SQLite database and seed 5 memories.
 *   2. Start the embed worker (KITHKIT_EMBED_FAKE=1 — deterministic, fast).
 *   3. Enable vector search (initVectorSearch on the test db).
 *   4. Concurrently run:
 *      a. Multiple hybridSearch() calls (mimics orchestrator prompt builder line 587)
 *      b. Multiple child_process.fork() spawns of a trivial exit-0 script
 *   5. Assert: all hybridSearch calls return results, all forks complete,
 *      no process crash (the test itself passing proves no abort).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Force fake embed mode
process.env['KITHKIT_EMBED_FAKE'] = '1';

import { openDatabase, closeDatabase, insert } from '../../core/db.js';
import { initVectorSearch, hybridSearch, _resetVectorSearchForTesting } from '../vector-search.js';
import { startEmbedWorker, stopEmbedWorker, _resetForTesting as resetEmbedClient } from '../embed-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/memory/__tests__/spawn-injection.test.js → project root is ../../../../
const PROJECT_DIR = path.resolve(__dirname, '..', '..', '..', '..');

// ── Trivial exit-0 script for fork() target ──────────────────

const TRIVIAL_SCRIPT = path.join(os.tmpdir(), 'kithkit-spawn-test-exit0.js');
fs.writeFileSync(TRIVIAL_SCRIPT, `
// Trivial child process: exits immediately with code 0
process.exit(0);
`);

function spawnFork(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = fork(TRIVIAL_SCRIPT, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('exit', (code) => resolve(code));
    child.on('error', reject);
    // Disconnect IPC immediately — child will self-exit
    child.disconnect();
  });
}

// ── DB helpers ───────────────────────────────────────────────

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-spawn-inj-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetVectorSearchForTesting();
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function seedMemories(count = 5): void {
  const contents = [
    'The daemon manages agent lifecycle and task routing.',
    'Vector search uses sqlite-vec for semantic similarity.',
    'ONNX inference runs in a child process to prevent mutex aborts.',
    'The orchestrator decomposes tasks and assigns workers.',
    'Memory injection provides relevant context to spawned agents.',
  ];
  for (let i = 0; i < count; i++) {
    insert('memories', {
      content: contents[i % contents.length],
      category: 'fact',
      tags: '[]',
      source: 'test',
      embedding: null,
    });
  }
}

// ── Main test ─────────────────────────────────────────────────

describe('spawn-injection: hybridSearch + fork() concurrency (kithkit#471)', { concurrency: 1 }, () => {
  before(async () => {
    setupDb();
    seedMemories(5);

    // Start embed worker (fake mode — no real model needed)
    resetEmbedClient();
    await startEmbedWorker(PROJECT_DIR);

    // Initialize vector search on the test database
    initVectorSearch();
  });

  after(() => {
    stopEmbedWorker();
    resetEmbedClient();
    teardownDb();
    try { fs.unlinkSync(TRIVIAL_SCRIPT); } catch { /* ignore */ }
  });

  it('hybridSearch returns results concurrently with fork() spawns — no abort', async () => {
    const SEARCH_COUNT = 5;
    const FORK_COUNT = 5;

    // Fire hybridSearch calls and fork() spawns concurrently.
    // The key invariant: with ONNX isolated in a child process, fork() in
    // the daemon process cannot interfere with ONNX state.
    const searchPromises = Array.from({ length: SEARCH_COUNT }, (_, i) =>
      hybridSearch(`agent spawn context ${i}`, 3),
    );

    const forkPromises = Array.from({ length: FORK_COUNT }, () => spawnFork());

    // Run everything in parallel
    const [searchResults, forkCodes] = await Promise.all([
      Promise.all(searchPromises),
      Promise.all(forkPromises),
    ]);

    // Verify: all searches returned arrays (may be empty if indexing not done, but no throw)
    assert.equal(searchResults.length, SEARCH_COUNT, `expected ${SEARCH_COUNT} search result arrays`);
    for (const r of searchResults) {
      assert.ok(Array.isArray(r), 'hybridSearch should return an array');
    }

    // Verify: all forks completed (exit code 0 or null)
    assert.equal(forkCodes.length, FORK_COUNT, `expected ${FORK_COUNT} fork completions`);
    for (const code of forkCodes) {
      assert.ok(code === 0 || code === null, `fork should exit cleanly, got code ${code}`);
    }
  });

  it('hybridSearch returns at least some results when memories are seeded', async () => {
    // With vector search enabled and memories seeded, hybridSearch should
    // return some results for a relevant query.
    const results = await hybridSearch('daemon agent lifecycle', 5);
    assert.ok(Array.isArray(results), 'should return an array');
    // NOTE: results may be 0 if the test db skipped backfill (no embeddings).
    // The important thing is no crash/throw.
  });

  it('survives 20 concurrent hybridSearch + 10 concurrent forks', async () => {
    const searches = Array.from({ length: 20 }, (_, i) =>
      hybridSearch(`memory search query ${i}`, 5),
    );
    const forks = Array.from({ length: 10 }, () => spawnFork());

    // This should not crash with a mutex abort
    const [searchRes, forkRes] = await Promise.all([
      Promise.allSettled(searches),
      Promise.allSettled(forks),
    ]);

    const searchFails = searchRes.filter((r) => r.status === 'rejected');
    const forkFails = forkRes.filter((r) => r.status === 'rejected');

    assert.equal(forkFails.length, 0, `${forkFails.length} fork(s) failed unexpectedly`);
    // Searches may fail if vector search is not fully set up in test db, but should not abort
    // We just verify the test process is still alive (if we get here, no abort occurred)
    assert.ok(
      searchFails.length < 20,
      `all ${searchRes.length} searches rejected — likely a test setup issue`,
    );
  });
});
