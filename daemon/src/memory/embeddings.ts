/**
 * Embeddings module — generate 384-dim vectors using all-MiniLM-L6-v2 via HuggingFace Transformers.
 *
 * Lazy-loads the model on first use. Model is downloaded and cached automatically
 * by the transformers library (~80MB, one-time download).
 */

// ── Types ────────────────────────────────────────────────────

export const EMBEDDING_DIMENSIONS = 384;

// We use dynamic import because @huggingface/transformers is ESM-only in some builds
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;
let _initPromise: Promise<void> | null = null;

// ── Initialization ───────────────────────────────────────────

async function ensureInitialized(): Promise<void> {
  if (_embedder) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const mod = await import('@huggingface/transformers');
    _pipeline = mod.pipeline;
    _embedder = await _pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  })();

  return _initPromise;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Generate a 384-dimensional embedding for the given text.
 * Returns a Float32Array suitable for sqlite-vec storage.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  await ensureInitialized();

  const output = await _embedder!(text, { pooling: 'mean', normalize: true });

  // output.data is a Float32Array of length 384
  return new Float32Array(output.data);
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await generateEmbedding(text));
  }
  return results;
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
 * Check if the model is loaded and ready.
 */
export function isModelLoaded(): boolean {
  return _embedder !== null;
}

/** Reset for testing. */
export function _resetEmbeddingsForTesting(): void {
  _embedder = null;
  _pipeline = null;
  _initPromise = null;
}
