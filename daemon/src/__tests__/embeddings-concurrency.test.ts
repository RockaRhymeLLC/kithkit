/**
 * t-468: Serialized ONNX inference — concurrency guard
 *
 * Regression test for kithkit#468: concurrent calls to _embedder() hit a
 * non-reentrant native ONNX session, causing a std::system_error mutex crash.
 * The fix wraps inference in a promise-chain lock so exactly one call runs at a time.
 *
 * Mutation-killing: this test MUST fail (observed max concurrency > 1) when
 * the serialization lock is removed, and PASS (max concurrency === 1) with it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEmbedding,
  _resetEmbeddingsForTesting,
  _setEmbedderForTesting,
} from '../memory/embeddings.js';

// ── Mock embedder ─────────────────────────────────────────────────────────────
//
// Tracks live concurrency (increment on entry / decrement on exit) and records
// the observed maximum. An async delay forces concurrent callers to overlap in
// the event loop, making non-serialized access clearly visible.

const MOCK_DELAY_MS = 10;
const FAKE_EMBEDDING_DIM = 384;

let liveConcurrency = 0;
let observedMaxConcurrency = 0;

async function mockEmbedder(_text: string, _opts: unknown): Promise<{ data: Float32Array }> {
  liveConcurrency++;
  if (liveConcurrency > observedMaxConcurrency) {
    observedMaxConcurrency = liveConcurrency;
  }
  // Yield to the event loop so concurrent callers can interleave if the lock is absent
  await new Promise<void>((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
  liveConcurrency--;
  return { data: new Float32Array(FAKE_EMBEDDING_DIM).fill(0.1) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('embeddings: inference serialization lock (kithkit#468)', () => {
  before(() => {
    _resetEmbeddingsForTesting();
    _setEmbedderForTesting(mockEmbedder);
  });

  after(() => {
    _resetEmbeddingsForTesting();
  });

  it('serializes concurrent generateEmbedding() calls (max concurrency === 1)', async () => {
    liveConcurrency = 0;
    observedMaxConcurrency = 0;

    const N = 8; // >= 5 as required
    // Fire N calls simultaneously — without the lock they run concurrently
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => generateEmbedding(`text ${i}`))
    );

    assert.strictEqual(results.length, N, 'all N calls must complete');
    assert.ok(
      results.every((r) => r instanceof Float32Array && r.length === FAKE_EMBEDDING_DIM),
      'each result must be a Float32Array of the correct length'
    );

    assert.strictEqual(
      observedMaxConcurrency,
      1,
      `Expected max concurrency === 1 (serialized) but observed ${observedMaxConcurrency}. ` +
        'The inference serialization lock is missing or broken.'
    );
  });
});
