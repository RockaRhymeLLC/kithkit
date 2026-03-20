/**
 * Story 8 — Memory Consolidation Enhancement tests.
 *
 * Tests for:
 * 1. Decay enforcement (default, short, evergreen policies)
 * 2. Category cap pruning
 * 3. Enhanced merge strategy (2-member and 3+ member clusters)
 * 4. Merge threshold (0.85)
 * 5. Graceful handling of zero self-improvement memories
 *
 * Uses in-memory SQLite via temp dir. No network calls (vector search disabled).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, closeDatabase, _resetDbForTesting, getDatabase } from '../../../../core/db.js';
import { embeddingToBuffer, EMBEDDING_DIMENSIONS } from '../../../../memory/embeddings.js';
import {
  _enforceDecayForTesting,
  _enforceCategoryCapForTesting,
  _processClusterForTesting,
  _buildClustersForTesting,
  _mergeClusterForTesting,
  _runForTesting,
} from '../memory-consolidation.js';
import type {
  _MemoryRowForTesting as MemoryRow,
  _MergeClusterForTesting as MergeCluster,
} from '../memory-consolidation.js';

// ── Helpers ───────────────────────────────────────────────────

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-mc-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetDbForTesting();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Insert a memory with explicit fields. Returns the row id. */
function insertMemory(opts: {
  content?: string;
  category?: string;
  decay_policy?: string | null;
  last_accessed?: string | null;
  importance?: number;
  expires_at?: string | null;
  tags?: string;
  embedding?: Buffer | null;
}): number {
  const db = getDatabase();
  const result = db.prepare(
    `INSERT INTO memories (content, category, tags, source, decay_policy, last_accessed, importance, expires_at, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.content ?? 'test memory',
    opts.category ?? 'operational',
    opts.tags ?? '[]',
    'test',
    opts.decay_policy ?? 'default',
    opts.last_accessed ?? null,
    opts.importance ?? 3,
    opts.expires_at ?? null,
    opts.embedding ?? null,
  );
  return Number(result.lastInsertRowid);
}

/** Get a memory row by id. */
function getMemory(id: number): Record<string, unknown> | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

/** Make a normalized Float32Array of the given dimension. */
function makeVec(values: number[]): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS).fill(0);
  let norm = 0;
  for (let i = 0; i < values.length && i < EMBEDDING_DIMENSIONS; i++) {
    arr[i] = values[i]!;
    norm += values[i]! * values[i]!;
  }
  // normalize
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i]! / norm; // already normalized below
  return arr;
}

/**
 * Create a unit vector aligned with dimension 0 ([1, 0, 0, ...]).
 */
function unitVec(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS).fill(0);
  arr[0] = 1.0;
  return arr;
}

/**
 * Create a unit vector with a given cosine similarity to unitVec().
 * cos = similarity → v = [similarity, sqrt(1-similarity²), 0, ...]
 */
function vecWithSim(similarity: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS).fill(0);
  arr[0] = similarity;
  arr[1] = Math.sqrt(Math.max(0, 1 - similarity * similarity));
  return arr;
}

/** Build a minimal MemoryRow for cluster tests (no DB needed). */
function makeRow(opts: Partial<MemoryRow> & { id: number; category: string }): MemoryRow {
  return {
    content: 'test content',
    tags: '[]',
    source: null,
    embedding: null,
    created_at: new Date().toISOString(),
    last_accessed: null,
    importance: 3,
    expires_at: null,
    decay_policy: 'default',
    ...opts,
  };
}

// ── Test 1: Default decay ────────────────────────────────────

describe('Memory Consolidation Enhanced', { concurrency: 1 }, () => {

  describe('Decay enforcement — default policy', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('archives memories unaccessed for >30 days (default policy)', () => {
      const cutoff35 = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff25 = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString();

      const staleId = insertMemory({ decay_policy: 'default', last_accessed: cutoff35 });
      const recentId = insertMemory({ decay_policy: 'default', last_accessed: cutoff25 });

      const archived = _enforceDecayForTesting({ default: '30d', short: '7d', evergreen: 'never' });

      assert.equal(archived, 1, 'should archive exactly 1 memory');

      const stale = getMemory(staleId);
      const recent = getMemory(recentId);

      assert.ok(stale!['expires_at'] !== null, 'stale memory should be archived');
      assert.equal(recent!['expires_at'], null, 'recently-accessed memory should not be archived');
    });
  });

  // ── Test 2: Short decay ──────────────────────────────────────

  describe('Decay enforcement — short policy', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('archives memories unaccessed for >7 days (short policy)', () => {
      const cutoff10 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

      const staleId = insertMemory({ decay_policy: 'short', last_accessed: cutoff10 });
      const recentId = insertMemory({ decay_policy: 'short', last_accessed: cutoff5 });

      const archived = _enforceDecayForTesting({ default: '30d', short: '7d', evergreen: 'never' });

      assert.equal(archived, 1, 'should archive exactly 1 short-policy memory');

      const stale = getMemory(staleId);
      const recent = getMemory(recentId);

      assert.ok(stale!['expires_at'] !== null, 'stale short-policy memory should be archived');
      assert.equal(recent!['expires_at'], null, 'recently-accessed short-policy memory should not be archived');
    });
  });

  // ── Test 3: Evergreen never archived ────────────────────────

  describe('Decay enforcement — evergreen policy', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('never archives evergreen memories regardless of last_accessed age', () => {
      const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

      const id = insertMemory({ decay_policy: 'evergreen', last_accessed: longAgo });

      const archived = _enforceDecayForTesting({ default: '30d', short: '7d', evergreen: 'never' });

      assert.equal(archived, 0, 'should archive 0 evergreen memories');
      const mem = getMemory(id);
      assert.equal(mem!['expires_at'], null, 'evergreen memory should not be archived');
    });
  });

  // ── Test 4: Category cap ─────────────────────────────────────

  describe('Category cap pruning', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('archives least-important memory when count exceeds cap of 50', () => {
      const db = getDatabase();

      // Insert 51 memories in same category with importance values 1..51
      const ids: number[] = [];
      for (let i = 1; i <= 51; i++) {
        const id = insertMemory({
          content: `cap-test memory ${i}`,
          category: 'operational',
          importance: i,
          // stagger created_at so ordering is deterministic
          last_accessed: null,
        });
        // update created_at to be sequential
        db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
          new Date(Date.now() - (51 - i) * 1000).toISOString(),
          id,
        );
        ids.push(id);
      }

      const capEnforced = _enforceCategoryCapForTesting(50);

      assert.equal(capEnforced, 1, 'should archive exactly 1 memory');

      // The memory with importance=1 (lowest) should be archived
      const lowestImportanceId = ids[0]!; // inserted first with importance=1
      const archived = getMemory(lowestImportanceId);
      assert.ok(archived!['expires_at'] !== null, 'least-important memory should be archived');

      // Active count should now be 50
      const active = db.prepare(
        `SELECT COUNT(*) as cnt FROM memories WHERE expires_at IS NULL AND category = 'operational'`,
      ).get() as { cnt: number };
      assert.equal(active.cnt, 50, 'active memories should be at cap');
    });
  });

  // ── Test 5: 2-memory merge ───────────────────────────────────

  describe('2-memory merge strategy', () => {
    it('preserves highest importance and most specific (evergreen) decay policy', () => {
      const memberA: MemoryRow = makeRow({
        id: 1,
        category: 'operational',
        content: 'memory A — lower importance',
        importance: 2,
        decay_policy: 'short',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const memberB: MemoryRow = makeRow({
        id: 2,
        category: 'operational',
        content: 'memory B — higher importance and evergreen',
        importance: 5,
        decay_policy: 'evergreen',
        created_at: '2026-01-02T00:00:00.000Z',
      });

      const cluster: MergeCluster = { members: [memberA, memberB] };
      const result = _mergeClusterForTesting(cluster);

      assert.equal(result.importance, 5, 'merged memory should have highest importance');
      assert.equal(result.decay_policy, 'evergreen', 'merged memory should have most specific (evergreen) policy');
      assert.equal(result.content, memberB.content, 'merged content should come from highest-importance member');
      assert.equal(result.created_at, memberB.created_at, 'merged created_at should be newest');
    });

    it('uses newest created_at when importance is tied', () => {
      const memberA: MemoryRow = makeRow({
        id: 1,
        category: 'operational',
        content: 'older memory',
        importance: 3,
        decay_policy: 'default',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const memberB: MemoryRow = makeRow({
        id: 2,
        category: 'operational',
        content: 'newer memory',
        importance: 3,
        decay_policy: 'default',
        created_at: '2026-02-01T00:00:00.000Z',
      });

      const result = _mergeClusterForTesting({ members: [memberA, memberB] });

      assert.equal(result.content, memberB.content, 'should use content from newer memory on tied importance');
      assert.equal(result.created_at, memberB.created_at, 'created_at should be newest');
    });

    it('combines tags from all merged members', () => {
      const memberA: MemoryRow = makeRow({
        id: 1,
        category: 'operational',
        tags: '["alpha","beta"]',
        importance: 3,
        decay_policy: 'default',
        created_at: '2026-01-01T00:00:00.000Z',
      });

      const memberB: MemoryRow = makeRow({
        id: 2,
        category: 'operational',
        tags: '["beta","gamma"]',
        importance: 3,
        decay_policy: 'default',
        created_at: '2026-01-02T00:00:00.000Z',
      });

      const result = _mergeClusterForTesting({ members: [memberA, memberB] });

      assert.ok(result.tags.includes('alpha'), 'should include alpha tag');
      assert.ok(result.tags.includes('beta'), 'should include beta tag (deduplicated)');
      assert.ok(result.tags.includes('gamma'), 'should include gamma tag');
      assert.equal(result.tags.length, 3, 'should have exactly 3 unique tags');
    });
  });

  // ── Test 6: 3-memory merge ───────────────────────────────────

  describe('3-memory merge — highest-importance base survives', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('keeps highest-importance memory unchanged and archives the rest', async () => {
      const idA = insertMemory({ content: 'memory A', category: 'operational', importance: 3 });
      const idB = insertMemory({ content: 'memory B — highest', category: 'operational', importance: 5 });
      const idC = insertMemory({ content: 'memory C', category: 'operational', importance: 1 });

      const db = getDatabase();
      const rowA = db.prepare('SELECT * FROM memories WHERE id = ?').get(idA) as MemoryRow;
      const rowB = db.prepare('SELECT * FROM memories WHERE id = ?').get(idB) as MemoryRow;
      const rowC = db.prepare('SELECT * FROM memories WHERE id = ?').get(idC) as MemoryRow;

      const cluster: MergeCluster = { members: [rowA, rowB, rowC] };
      const result = await _processClusterForTesting(cluster);

      assert.equal(result.merged, true, 'should return merged=true');
      assert.equal(result.archivedCount, 2, 'should archive 2 other memories');

      // Base memory (highest importance) should still be active
      const baseAfter = getMemory(idB);
      assert.equal(baseAfter!['expires_at'], null, 'highest-importance memory should not be archived');

      // Others should be archived
      const aAfter = getMemory(idA);
      const cAfter = getMemory(idC);
      assert.ok(aAfter!['expires_at'] !== null, 'lower-importance memory A should be archived');
      assert.ok(cAfter!['expires_at'] !== null, 'lowest-importance memory C should be archived');

      // Total memory count should still be 3 (no new record created)
      const count = db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number };
      assert.equal(count.cnt, 3, 'no new memory record should be created for 3+ merge');
    });

    it('breaks ties in base selection by newest created_at', async () => {
      const db = getDatabase();

      const idA = insertMemory({ content: 'memory A — older', category: 'test-tie', importance: 5 });
      const idB = insertMemory({ content: 'memory B — newer', category: 'test-tie', importance: 5 });
      const idC = insertMemory({ content: 'memory C', category: 'test-tie', importance: 3 });

      // Make idB newer
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() + 1000).toISOString(),
        idB,
      );
      db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 1000).toISOString(),
        idA,
      );

      const rowA = db.prepare('SELECT * FROM memories WHERE id = ?').get(idA) as MemoryRow;
      const rowB = db.prepare('SELECT * FROM memories WHERE id = ?').get(idB) as MemoryRow;
      const rowC = db.prepare('SELECT * FROM memories WHERE id = ?').get(idC) as MemoryRow;

      const cluster: MergeCluster = { members: [rowA, rowB, rowC] };
      await _processClusterForTesting(cluster);

      // idB (newer of the tied-importance pair) should be the base
      const bAfter = getMemory(idB);
      assert.equal(bAfter!['expires_at'], null, 'newer of tied-importance memories should be the base');

      const aAfter = getMemory(idA);
      assert.ok(aAfter!['expires_at'] !== null, 'older of tied-importance memories should be archived');
    });
  });

  // ── Test 7: Merge threshold = 0.85 ──────────────────────────

  describe('Merge threshold', () => {
    it('uses 0.85 threshold: vectors at exactly 0.85 sim are merged, 0.84 are not', () => {
      const v1 = unitVec();
      const v2 = vecWithSim(0.85); // cosine sim with v1 = exactly 0.85 → should merge
      const v3 = vecWithSim(0.84); // cosine sim with v1 = exactly 0.84 → should NOT merge

      const now = new Date().toISOString();

      const rowA: MemoryRow = makeRow({
        id: 1,
        category: 'test-threshold',
        embedding: embeddingToBuffer(v1),
        created_at: now,
      });

      const rowB: MemoryRow = makeRow({
        id: 2,
        category: 'test-threshold',
        embedding: embeddingToBuffer(v2),
        created_at: now,
      });

      const rowC: MemoryRow = makeRow({
        id: 3,
        category: 'test-threshold',
        embedding: embeddingToBuffer(v3),
        created_at: now,
      });

      // At threshold 0.85: A and B should cluster, A and C should not
      const clusters085 = _buildClustersForTesting([rowA, rowB, rowC], 0.85);
      assert.equal(clusters085.length, 1, 'should find exactly 1 cluster at 0.85 threshold');
      const memberIds = clusters085[0]!.members.map(m => m.id);
      assert.ok(memberIds.includes(1), 'cluster should include memory A');
      assert.ok(memberIds.includes(2), 'cluster should include memory B (sim=0.85)');
      assert.ok(!memberIds.includes(3), 'cluster should NOT include memory C (sim=0.84)');
    });

    it('at threshold 0.86 (just above 0.85), the same vectors do not merge', () => {
      // Verify the boundary: sim=0.85 is included at threshold 0.85 but excluded at 0.86
      const v1 = unitVec();
      const v2 = vecWithSim(0.85); // sim = exactly 0.85 < 0.86 threshold

      const now = new Date().toISOString();
      const rowA: MemoryRow = makeRow({ id: 1, category: 'test-threshold2', embedding: embeddingToBuffer(v1), created_at: now });
      const rowB: MemoryRow = makeRow({ id: 2, category: 'test-threshold2', embedding: embeddingToBuffer(v2), created_at: now });

      const clusters086 = _buildClustersForTesting([rowA, rowB], 0.86);
      assert.equal(clusters086.length, 0, 'at threshold 0.86, vectors with 0.85 sim should NOT cluster');
    });
  });

  // ── Test 8: Zero self-improvement memories ──────────────────

  describe('Consolidation with zero self-improvement memories', () => {
    beforeEach(setupDb);
    afterEach(teardownDb);

    it('runs successfully with no memories in the database', async () => {
      // Empty DB — should not throw
      let threw = false;
      try {
        await _runForTesting();
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'run() should not throw on empty DB');
    });

    it('runs successfully with normal memories (no decay_policy/origin_agent fields)', async () => {
      const db = getDatabase();

      // Insert memories without the self-improvement fields (NULL decay_policy)
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO memories (content, category, tags, source) VALUES (?, ?, ?, ?)`,
        ).run(`normal memory ${i}`, 'operational', '[]', 'test');
      }

      let threw = false;
      try {
        await _runForTesting();
      } catch {
        threw = true;
      }
      assert.equal(threw, false, 'run() should not throw with normal (non-SI) memories');

      // No memories should have been archived (none are stale — no last_accessed)
      const count = db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE expires_at IS NULL',
      ).get() as { cnt: number };
      assert.equal(count.cnt, 3, 'normal memories should not be archived');
    });
  });

});
