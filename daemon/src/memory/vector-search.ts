/**
 * Vector search — sqlite-vec integration for semantic similarity search.
 *
 * Loads the sqlite-vec extension into better-sqlite3, creates a virtual
 * table for vector KNN search, and provides hybrid search that merges
 * keyword and vector results.
 *
 * Note: sqlite-vec alpha has a bug where parameterized INTEGER PRIMARY KEY
 * inserts fail ("Only integers are allows for primary key values"). We work
 * around this by letting vec0 auto-assign rowids and maintaining a mapping
 * table (vec_memory_map) to link memory_id ↔ vec_rowid.
 */

import { createRequire } from 'node:module';
import { getDatabase, query } from '../core/db.js';
import { generateEmbedding, embeddingToBuffer, EMBEDDING_DIMENSIONS } from './embeddings.js';

const require = createRequire(import.meta.url);

// ── Types ────────────────────────────────────────────────────

export interface VectorSearchResult {
  id: number;
  content: string;
  type: string;
  category: string | null;
  tags: string[];
  source: string | null;
  distance: number;
  score: number;
  created_at: string;
}

export interface HybridSearchResult extends VectorSearchResult {
  keyword_score: number;
  vector_score: number;
  combined_score: number;
}

// ── sqlite-vec setup ─────────────────────────────────────────

let _vecLoaded = false;

/**
 * Load sqlite-vec extension and create the vector index virtual table.
 * Safe to call multiple times — idempotent.
 */
export function initVectorSearch(): void {
  if (_vecLoaded) return;

  const db = getDatabase();

  // Load the extension (CJS package, use createRequire)
  const sqliteVec = require('sqlite-vec');
  sqliteVec.load(db);

  // Create virtual table for vector search (auto-assigned rowid)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      embedding float[${EMBEDDING_DIMENSIONS}]
    )
  `);

  // Mapping table: memory_id ↔ vec_rowid
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_memory_map (
      memory_id INTEGER PRIMARY KEY,
      vec_rowid INTEGER NOT NULL
    )
  `);

  _vecLoaded = true;
}

// ── Index management ─────────────────────────────────────────

/**
 * Insert or update an embedding in the vector index.
 */
export function indexEmbedding(memoryId: number, embedding: Float32Array): void {
  const db = getDatabase();
  const buf = embeddingToBuffer(embedding);

  // Remove old entry if exists
  const existing = db.prepare('SELECT vec_rowid FROM vec_memory_map WHERE memory_id = ?').get(memoryId) as { vec_rowid: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(existing.vec_rowid);
    db.prepare('DELETE FROM vec_memory_map WHERE memory_id = ?').run(memoryId);
  }

  // Insert into vec_memories (auto-assigned rowid)
  const result = db.prepare('INSERT INTO vec_memories (embedding) VALUES (?)').run(buf);
  const vecRowid = Number(result.lastInsertRowid);

  // Record the mapping
  db.prepare('INSERT INTO vec_memory_map (memory_id, vec_rowid) VALUES (?, ?)').run(memoryId, vecRowid);
}

/**
 * Remove an embedding from the vector index.
 */
export function removeEmbedding(memoryId: number): void {
  const db = getDatabase();
  const existing = db.prepare('SELECT vec_rowid FROM vec_memory_map WHERE memory_id = ?').get(memoryId) as { vec_rowid: number } | undefined;
  if (existing) {
    db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(existing.vec_rowid);
    db.prepare('DELETE FROM vec_memory_map WHERE memory_id = ?').run(memoryId);
  }
}

/**
 * Backfill embeddings for all memories that have NULL embedding column.
 * Returns the count of memories updated.
 */
export async function backfillEmbeddings(): Promise<number> {
  interface MemoryRow { id: number; content: string }

  const rows = query<MemoryRow>(
    'SELECT id, content FROM memories WHERE embedding IS NULL',
  );

  let count = 0;
  for (const row of rows) {
    const embedding = await generateEmbedding(row.content);
    const buf = embeddingToBuffer(embedding);

    const db = getDatabase();
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, row.id);
    indexEmbedding(row.id, embedding);
    count++;
  }

  return count;
}

// ── Search ──────────────────────────────────────────────────

/**
 * Vector similarity search — find semantically similar memories.
 * Uses sqlite-vec KNN search.
 */
export async function vectorSearch(
  queryText: string,
  limit = 10,
): Promise<VectorSearchResult[]> {
  const queryEmbedding = await generateEmbedding(queryText);
  const queryBuf = embeddingToBuffer(queryEmbedding);

  const db = getDatabase();

  interface VecRow { rowid: number; distance: number }

  // KNN search using sqlite-vec
  const vecRows = db.prepare(`
    SELECT rowid, distance
    FROM vec_memories
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(queryBuf, limit) as VecRow[];

  if (vecRows.length === 0) return [];

  // Map vec rowids back to memory IDs
  const vecRowids = vecRows.map(r => r.rowid);
  const placeholders = vecRowids.map(() => '?').join(',');

  interface MapRow { memory_id: number; vec_rowid: number }
  const mapRows = db.prepare(
    `SELECT memory_id, vec_rowid FROM vec_memory_map WHERE vec_rowid IN (${placeholders})`,
  ).all(...vecRowids) as MapRow[];

  const vecToMemory = new Map(mapRows.map(m => [Number(m.vec_rowid), m.memory_id]));

  // Get memory IDs for the results
  const memoryIds = vecRows.map(vr => vecToMemory.get(Number(vr.rowid))).filter((id): id is number => id !== undefined);
  if (memoryIds.length === 0) return [];

  const memPlaceholders = memoryIds.map(() => '?').join(',');

  interface MemRow {
    id: number;
    content: string;
    type: string;
    category: string | null;
    tags: string;
    source: string | null;
    created_at: string;
  }

  const memories = db.prepare(
    `SELECT id, content, type, category, tags, source, created_at FROM memories WHERE id IN (${memPlaceholders})`,
  ).all(...memoryIds) as MemRow[];

  const memMap = new Map(memories.map(m => [m.id, m]));

  return vecRows
    .map(vr => {
      const memId = vecToMemory.get(Number(vr.rowid));
      if (!memId) return null;
      const mem = memMap.get(memId);
      if (!mem) return null;

      // For L2-normalized vectors, convert L2 distance to cosine similarity:
      // d² = 2(1 - cos_sim), so cos_sim = 1 - d²/2
      const score = Math.max(0, 1 - (vr.distance * vr.distance) / 2);

      return {
        id: mem.id,
        content: mem.content,
        type: mem.type,
        category: mem.category,
        tags: JSON.parse(mem.tags || '[]'),
        source: mem.source,
        distance: vr.distance,
        score,
        created_at: mem.created_at,
      };
    })
    .filter((r): r is VectorSearchResult => r !== null);
}

/**
 * Hybrid search — merges keyword and vector results.
 * Combined score = 0.4 * keyword_score + 0.6 * vector_score.
 * Duplicates merged, keeping highest combined score.
 */
export async function hybridSearch(
  queryText: string,
  limit = 10,
): Promise<HybridSearchResult[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(queryText, limit * 2),
    keywordSearch(queryText, limit * 2),
  ]);

  const merged = new Map<number, HybridSearchResult>();

  const maxVecScore = vectorResults.length > 0
    ? Math.max(...vectorResults.map(r => r.score))
    : 1;

  for (const vr of vectorResults) {
    const normalizedVecScore = maxVecScore > 0 ? vr.score / maxVecScore : 0;
    merged.set(vr.id, {
      ...vr,
      keyword_score: 0,
      vector_score: normalizedVecScore,
      combined_score: 0.6 * normalizedVecScore,
    });
  }

  const maxKwScore = keywordResults.length > 0
    ? Math.max(...keywordResults.map(r => r.score))
    : 1;

  for (const kr of keywordResults) {
    const normalizedKwScore = maxKwScore > 0 ? kr.score / maxKwScore : 0;
    const existing = merged.get(kr.id);

    if (existing) {
      existing.keyword_score = normalizedKwScore;
      existing.combined_score = 0.4 * normalizedKwScore + 0.6 * existing.vector_score;
    } else {
      merged.set(kr.id, {
        ...kr,
        keyword_score: normalizedKwScore,
        vector_score: 0,
        combined_score: 0.4 * normalizedKwScore,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, limit);
}

// ── Internal keyword search ──────────────────────────────────

interface KeywordResult {
  id: number;
  content: string;
  type: string;
  category: string | null;
  tags: string[];
  source: string | null;
  score: number;
  distance: number;
  created_at: string;
}

function keywordSearch(queryText: string, limit: number): Promise<KeywordResult[]> {
  const words = queryText.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return Promise.resolve([]);

  const conditions = words.map(() => 'LOWER(content) LIKE LOWER(?)');
  const params: unknown[] = words.map(w => `%${w}%`);

  const scoreParts = words.map(() =>
    "CASE WHEN LOWER(content) LIKE LOWER(?) THEN 1 ELSE 0 END"
  );
  const scoreExpr = scoreParts.join(' + ');
  const scoreParams = words.map(w => `%${w}%`);

  interface MemRow {
    id: number; content: string; type: string;
    category: string | null; tags: string; source: string | null;
    created_at: string; kw_score: number;
  }

  const sql = `
    SELECT id, content, type, category, tags, source, created_at,
           (${scoreExpr}) as kw_score
    FROM memories
    WHERE ${conditions.join(' OR ')}
    ORDER BY kw_score DESC, created_at DESC
    LIMIT ?
  `;

  const rows = query<MemRow>(sql, ...params, ...scoreParams, limit);

  return Promise.resolve(rows.map(r => ({
    id: r.id, content: r.content, type: r.type, category: r.category,
    tags: JSON.parse(r.tags || '[]'), source: r.source,
    score: r.kw_score, distance: 0, created_at: r.created_at,
  })));
}

/** Reset for testing. */
export function _resetVectorSearchForTesting(): void {
  _vecLoaded = false;
}
