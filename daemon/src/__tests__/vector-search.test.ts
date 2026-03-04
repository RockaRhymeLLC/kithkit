/**
 * t-128, t-129: Vector search (sqlite-vec + all-MiniLM-L6-v2)
 *
 * Tests vector similarity search and hybrid keyword+vector merging.
 * NOTE: These tests load the ONNX model (~80MB first run, cached after).
 * They are slower than other tests (~5-10s for model loading).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, insert, query } from '../core/db.js';
import { generateEmbedding, embeddingToBuffer, EMBEDDING_DIMENSIONS } from '../memory/embeddings.js';
import {
  initVectorSearch,
  indexEmbedding,
  vectorSearch,
  hybridSearch,
  _resetVectorSearchForTesting,
} from '../memory/vector-search.js';

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-vec-test-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  initVectorSearch();
}

function teardownDb(): void {
  _resetVectorSearchForTesting();
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

interface Memory {
  id: number;
  content: string;
  category: string | null;
  tags: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
}

async function storeMemoryWithEmbedding(content: string, opts?: { category?: string; tags?: string[] }): Promise<number> {
  const embedding = await generateEmbedding(content);
  const buf = embeddingToBuffer(embedding);

  const mem = insert<Memory>('memories', {
    content,
    category: opts?.category ?? null,
    tags: JSON.stringify(opts?.tags ?? []),
    source: 'test',
    embedding: buf,
  });

  indexEmbedding(mem.id, embedding);
  return mem.id;
}

describe('Vector Search', { concurrency: 1, timeout: 60000 }, () => {

  // ── t-128: Vector similarity search ────────────────────────

  describe('Vector similarity search (t-128)', () => {
    beforeEach(() => { setupDb(); });
    afterEach(() => { teardownDb(); });

    it('generates 384-dim embeddings', async () => {
      const embedding = await generateEmbedding('Test sentence');
      assert.equal(embedding.length, EMBEDDING_DIMENSIONS);
      assert.ok(embedding instanceof Float32Array);
    });

    it('embedding is normalized (unit length)', async () => {
      const embedding = await generateEmbedding('Test sentence');
      let sumSq = 0;
      for (const v of embedding) sumSq += v * v;
      const magnitude = Math.sqrt(sumSq);
      assert.ok(Math.abs(magnitude - 1.0) < 0.01, `Magnitude should be ~1.0, got ${magnitude}`);
    });

    it('stores memories with auto-generated embeddings', async () => {
      const id = await storeMemoryWithEmbedding('The cat sat on the mat');
      assert.ok(id > 0);

      const rows = query<{ id: number; embedding: Buffer }>('SELECT id, embedding FROM memories WHERE id = ?', id);
      assert.equal(rows.length, 1);
      assert.ok(rows[0]!.embedding, 'Should have embedding blob');
      assert.equal(rows[0]!.embedding!.length, EMBEDDING_DIMENSIONS * 4, 'Should be 384 * 4 bytes (float32)');
    });

    it('finds semantically similar memories (cat/feline)', async () => {
      await storeMemoryWithEmbedding('The cat sat on the mat');
      await storeMemoryWithEmbedding('Dogs enjoy playing fetch in the park');
      await storeMemoryWithEmbedding('Python is a programming language used for data science');

      const results = await vectorSearch('feline animals resting');
      assert.ok(results.length > 0, 'Should have results');
      assert.equal(results[0]!.content, 'The cat sat on the mat',
        'Cat memory should be ranked first for feline query');
    });

    it('finds semantically similar memories (programming/software)', async () => {
      await storeMemoryWithEmbedding('The cat sat on the mat');
      await storeMemoryWithEmbedding('Dogs enjoy playing fetch in the park');
      await storeMemoryWithEmbedding('Python is a programming language used for data science');

      const results = await vectorSearch('software development');
      assert.ok(results.length > 0, 'Should have results');
      assert.equal(results[0]!.content, 'Python is a programming language used for data science',
        'Python memory should be ranked first for software query');
    });

    it('returns distance and score fields', async () => {
      await storeMemoryWithEmbedding('Hello world');

      const results = await vectorSearch('Hi there');
      assert.ok(results.length > 0);
      assert.ok(typeof results[0]!.distance === 'number');
      assert.ok(typeof results[0]!.score === 'number');
      assert.ok(results[0]!.score >= 0 && results[0]!.score <= 1, 'Score should be 0-1');
    });

    it('respects limit parameter', async () => {
      await storeMemoryWithEmbedding('Memory one');
      await storeMemoryWithEmbedding('Memory two');
      await storeMemoryWithEmbedding('Memory three');

      const results = await vectorSearch('memory', 2);
      assert.equal(results.length, 2);
    });

    it('returns empty array for no matches', async () => {
      // No memories stored
      const results = await vectorSearch('anything');
      assert.equal(results.length, 0);
    });
  });

  // ── t-129: Hybrid search merges keyword + vector results ───

  describe('Hybrid search (t-129)', () => {
    beforeEach(() => { setupDb(); });
    afterEach(() => { teardownDb(); });

    it('returns results from both keyword and vector matches', async () => {
      // Store diverse memories
      await storeMemoryWithEmbedding('API configuration settings for the web server');
      await storeMemoryWithEmbedding('Database connection pool management');
      await storeMemoryWithEmbedding('Setting up environment variables for deployment');
      await storeMemoryWithEmbedding('User authentication flow with OAuth');
      await storeMemoryWithEmbedding('Configuring nginx reverse proxy');
      await storeMemoryWithEmbedding('React component lifecycle methods');
      await storeMemoryWithEmbedding('Docker container orchestration with Kubernetes');
      await storeMemoryWithEmbedding('TypeScript type inference and generics');
      await storeMemoryWithEmbedding('REST API endpoint design patterns');
      await storeMemoryWithEmbedding('SSL certificate renewal process');

      const results = await hybridSearch('API configuration settings');
      assert.ok(results.length > 0, 'Should have results');

      // The exact keyword match should be near the top
      const topIds = results.slice(0, 3).map(r => r.content);
      assert.ok(
        topIds.some(c => c.includes('API configuration')),
        'API configuration memory should be in top 3',
      );
    });

    it('results have keyword_score, vector_score, and combined_score', async () => {
      await storeMemoryWithEmbedding('Test memory for hybrid scoring');
      await storeMemoryWithEmbedding('Another memory about testing');

      const results = await hybridSearch('test memory');
      assert.ok(results.length > 0);

      for (const r of results) {
        assert.ok(typeof r.keyword_score === 'number', 'Should have keyword_score');
        assert.ok(typeof r.vector_score === 'number', 'Should have vector_score');
        assert.ok(typeof r.combined_score === 'number', 'Should have combined_score');
      }
    });

    it('results sorted by combined_score descending', async () => {
      await storeMemoryWithEmbedding('Alpha memory');
      await storeMemoryWithEmbedding('Beta memory');
      await storeMemoryWithEmbedding('Gamma memory');

      const results = await hybridSearch('memory');
      for (let i = 1; i < results.length; i++) {
        assert.ok(
          results[i - 1]!.combined_score >= results[i]!.combined_score,
          'Results should be sorted by combined score',
        );
      }
    });

    it('merges duplicates (same memory from both keyword and vector)', async () => {
      const id = await storeMemoryWithEmbedding('JavaScript closures and scope');
      await storeMemoryWithEmbedding('Python decorators and generators');

      // This query should match "JavaScript closures" both by keyword and semantics
      const results = await hybridSearch('JavaScript closures');

      // Check no duplicate IDs
      const ids = results.map(r => r.id);
      const uniqueIds = new Set(ids);
      assert.equal(ids.length, uniqueIds.size, 'Should have no duplicate entries');

      // The JS closures memory should appear once with both scores
      const jsResult = results.find(r => r.id === id);
      assert.ok(jsResult, 'JavaScript memory should be in results');
      assert.ok(jsResult!.keyword_score > 0, 'Should have keyword score');
      assert.ok(jsResult!.vector_score > 0, 'Should have vector score');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await storeMemoryWithEmbedding(`Memory number ${i} about various topics`);
      }

      const results = await hybridSearch('memory topics', 5);
      assert.ok(results.length <= 5, 'Should respect limit');
    });
  });
});
