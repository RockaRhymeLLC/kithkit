/**
 * t-E-backfill-partial: Mutation-killing tests for Batch E backfillEmbeddings
 * per-row resilience and early bail-out behaviors.
 *
 * E behavior (1) — per-row try/catch: a failure on one row must NOT abort the
 * entire backfill. Remaining rows should still be processed.
 *
 * E behavior (2) — early bail-out: if the first 5 rows all fail (failures >= 5
 * && count === 0), the loop breaks early rather than grinding through the whole
 * table.
 *
 * RED when reverted:
 *   - Remove try/catch → test (1) throws instead of returning partial count.
 *   - Remove bail-out break → test (2) sees callCount = 10 instead of 5.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, insert } from '../../core/db.js';
import { initVectorSearch, backfillEmbeddings, _setGenerateEmbeddingFnForTesting, _resetVectorSearchForTesting } from '../vector-search.js';

// A pre-computed L2-unit vector (all components equal, |v| = 1).
// Safe for sqlite-vec: sum of squares = 384 * (1/sqrt(384))^2 = 1.0
const UNIT_COMPONENT = 1 / Math.sqrt(384);
function makeUnitEmbedding(): Float32Array {
  return new Float32Array(384).fill(UNIT_COMPONENT);
}

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-backfill-'));
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  initVectorSearch();
}

function teardownDb(): void {
  _setGenerateEmbeddingFnForTesting(null);
  _resetVectorSearchForTesting();
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Insert a memory row with NULL embedding (to be backfilled). */
function insertNullEmbeddingMemory(content: string): number {
  const row = insert<{ id: number }>('memories', {
    content,
    category: null,
    tags: '[]',
    source: 'test',
    embedding: null,
  });
  return row.id;
}

// ── Test 1: per-row try/catch ────────────────────────────────

describe('backfillEmbeddings: per-row failure does not abort backfill (t-E-backfill-partial-1)', { concurrency: 1 }, () => {
  beforeEach(() => { setupDb(); });
  afterEach(() => { teardownDb(); });

  it('returns partial count when first row fails but subsequent rows succeed', async () => {
    // Insert 4 memories with NULL embedding
    insertNullEmbeddingMemory('Memory alpha');
    insertNullEmbeddingMemory('Memory beta');
    insertNullEmbeddingMemory('Memory gamma');
    insertNullEmbeddingMemory('Memory delta');

    let callNum = 0;
    _setGenerateEmbeddingFnForTesting(async (_text) => {
      callNum++;
      if (callNum === 1) {
        // Row 1 fails
        throw new Error('Simulated embedding failure for row 1');
      }
      // Rows 2-4 succeed
      return makeUnitEmbedding();
    });

    // MUTATION KILL: without per-row try/catch, this rejects on row 1.
    // With E behavior, it catches the row-1 error and continues → count = 3.
    const count = await backfillEmbeddings();

    assert.equal(count, 3,
      'expected 3 successful backfills (rows 2-4); ' +
      'if this fails (throws or count < 3), per-row try/catch was removed');
    assert.equal(callNum, 4, 'generateEmbedding should have been called for all 4 rows');
  });

  it('returns 0 when all rows fail (does not throw)', async () => {
    insertNullEmbeddingMemory('Will fail');
    insertNullEmbeddingMemory('Also fails');

    _setGenerateEmbeddingFnForTesting(async () => {
      throw new Error('All rows fail');
    });

    // Must not throw — must return 0
    const count = await backfillEmbeddings();
    assert.equal(count, 0, 'expected 0 when all rows fail');
  });
});

// ── Test 2: early bail-out ────────────────────────────────────

describe('backfillEmbeddings: early bail-out after 5 consecutive failures (t-E-backfill-partial-2)', { concurrency: 1 }, () => {
  beforeEach(() => { setupDb(); });
  afterEach(() => { teardownDb(); });

  it('stops processing after exactly 5 failures when count=0', async () => {
    // Insert 10 memories — all will fail
    for (let i = 0; i < 10; i++) {
      insertNullEmbeddingMemory(`Row ${i}`);
    }

    let callCount = 0;
    _setGenerateEmbeddingFnForTesting(async () => {
      callCount++;
      throw new Error('All fail');
    });

    const count = await backfillEmbeddings();

    assert.equal(count, 0, 'should return 0 when all fail');

    // MUTATION KILL: without the bail-out break, callCount would be 10.
    // With E behavior: failures >= 5 && count === 0 → break after 5 calls.
    assert.equal(callCount, 5,
      'should stop after exactly 5 failures (bail-out); ' +
      'if callCount = 10, the early bail-out break was removed');
  });

  it('does NOT bail out early when some rows succeed (count > 0 resets bail condition)', async () => {
    // Insert 8 memories: row 1 succeeds, rows 2-6 fail, rows 7-8 succeed
    for (let i = 0; i < 8; i++) {
      insertNullEmbeddingMemory(`Row ${i}`);
    }

    let callNum = 0;
    _setGenerateEmbeddingFnForTesting(async () => {
      callNum++;
      if (callNum === 1 || callNum >= 7) {
        return makeUnitEmbedding(); // rows 1, 7, 8 succeed
      }
      throw new Error('Rows 2-6 fail'); // 5 failures but count=1, so no bail-out
    });

    const count = await backfillEmbeddings();

    // count=1 after row 1, so bail condition (failures >= 5 && count === 0) never triggers.
    // All 8 rows are processed; rows 1, 7, 8 succeed → count = 3.
    assert.equal(callNum, 8, 'all 8 rows should be attempted when count > 0');
    assert.equal(count, 3, 'rows 1, 7, 8 should have succeeded');
  });
});
