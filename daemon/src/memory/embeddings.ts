/**
 * Embeddings module — thin delegation layer to the embed worker child process.
 *
 * The actual ONNX model (all-MiniLM-L6-v2) runs in a forked child process
 * (embed-worker.ts) to prevent the native libc++ mutex abort that fires when
 * child_process.fork() and ONNX inference coexist in the same process
 * (kithkit#469/#471).
 *
 * Public API is preserved exactly — zero call-site changes required.
 *
 * Testing shims: _setEmbedderForTesting / _resetEmbeddingsForTesting are kept
 * for backward compatibility. When a test embedder is set via
 * _setEmbedderForTesting, generateEmbedding() uses it directly (bypassing the
 * worker process), preserving the existing concurrency-lock tests (t-468).
 */

import {
  embed,
  embedBatch,
  isEmbedWorkerReady,
  _resetForTesting as _clientReset,
} from './embed-client.js';

// ── Constants ────────────────────────────────────────────────

export const EMBEDDING_DIMENSIONS = 384;

// ── Testing shim state ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _testEmbedder: ((text: string, opts: unknown) => Promise<{ data: Float32Array }>) | null = null;

// Serialization lock for the test embedder path (mirrors the worker's own lock).
// Without this, the t-468 concurrency test would fail because the test embedder
// runs in-process and is not serialized by the worker.
let _testInferLock: Promise<unknown> = Promise.resolve();

// ── Public API ───────────────────────────────────────────────

/**
 * Generate a 384-dimensional embedding for the given text.
 * Returns a Float32Array suitable for sqlite-vec storage.
 *
 * When a test embedder is set via _setEmbedderForTesting, uses it directly
 * (with serialization lock) instead of delegating to the worker.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (_testEmbedder) {
    // Test path: serialize through _testInferLock so t-468 observes max concurrency = 1
    const run = _testInferLock.then(() => _testEmbedder!(text, { pooling: 'mean', normalize: true }));
    _testInferLock = run.catch(() => undefined);
    const output = await run;
    return new Float32Array(output.data);
  }
  return embed(text);
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (_testEmbedder) {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await generateEmbedding(text));
    }
    return results;
  }
  return embedBatch(texts);
}

/**
 * Convert a Float32Array embedding to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert a SQLite BLOB Buffer back to a Float32Array.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(ab);
}

/**
 * Check if the embed worker is running and ready.
 * Returns true if the child process is alive and ready.
 * When a test embedder is set, returns true (mock is always "ready").
 */
export function isModelLoaded(): boolean {
  if (_testEmbedder) return true;
  return isEmbedWorkerReady();
}

// ── Testing shims ────────────────────────────────────────────

/** Reset for testing — clears the test embedder and delegates to embed-client reset. */
export function _resetEmbeddingsForTesting(): void {
  _testEmbedder = null;
  _testInferLock = Promise.resolve();
  _clientReset();
}

/**
 * Inject a mock embedder for testing (bypasses the worker process).
 * When set, generateEmbedding() calls this function with the same signature
 * as the real embedder: (text, opts) => Promise<{ data: Float32Array }>.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setEmbedderForTesting(fn: any): void {
  _testEmbedder = fn;
  _testInferLock = Promise.resolve(); // reset lock for each test run
}
