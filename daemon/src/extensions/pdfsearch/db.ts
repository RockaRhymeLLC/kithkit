/**
 * PDF Search — SQLite schema and helpers.
 *
 * Tables:
 *   pdfsearch_folders — registered folder paths + indexing state
 *   pdfsearch_chunks  — extracted text chunks with page+position metadata
 *   pdfsearch_vec     — sqlite-vec vec0 table for 768-dim nomic embeddings
 *   pdfsearch_vec_map — maps chunk_id → vec_rowid (sqlite-vec auto-assigns rowids)
 */

import { getDatabase } from '../../core/db.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface Folder {
  id: number;
  path: string;
  added_at: string;
  last_indexed_at: string | null;
  file_count: number;
  status: 'idle' | 'indexing' | 'done' | 'error';
  error_message: string | null;
}

export interface Chunk {
  id: number;
  folder_id: number;
  file_path: string;
  page_number: number;
  chunk_text: string;
  char_start: number;
  char_end: number;
  indexed_at: string;
}

export const PDF_EMBEDDING_DIMENSIONS = 768;

// ── Schema setup ──────────────────────────────────────────────

let _schemaReady = false;

/**
 * Create pdfsearch tables if they don't exist.
 * Idempotent — safe to call multiple times.
 * Must be called AFTER sqlite-vec has been loaded (initVectorSearch already does this).
 */
export function initPdfSearchDb(): void {
  if (_schemaReady) return;

  const db = getDatabase();

  // Load sqlite-vec (idempotent if already loaded by memory extension)
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
  } catch {
    // Already loaded — no-op
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pdfsearch_folders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      path            TEXT UNIQUE NOT NULL,
      added_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_indexed_at TEXT,
      file_count      INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'idle',
      error_message   TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pdfsearch_chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id   INTEGER NOT NULL REFERENCES pdfsearch_folders(id) ON DELETE CASCADE,
      file_path   TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      chunk_text  TEXT NOT NULL,
      char_start  INTEGER NOT NULL DEFAULT 0,
      char_end    INTEGER NOT NULL DEFAULT 0,
      indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pdfsearch_chunks_folder
    ON pdfsearch_chunks(folder_id)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pdfsearch_chunks_file
    ON pdfsearch_chunks(file_path)
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pdfsearch_vec
    USING vec0(embedding float[${PDF_EMBEDDING_DIMENSIONS}])
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS pdfsearch_vec_map (
      chunk_id  INTEGER PRIMARY KEY,
      vec_rowid INTEGER NOT NULL
    )
  `);

  _schemaReady = true;
}

// ── Folder helpers ─────────────────────────────────────────────

export function addFolder(folderPath: string): Folder {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO pdfsearch_folders (path, status)
    VALUES (?, 'idle')
    ON CONFLICT(path) DO UPDATE SET status = excluded.status
    RETURNING *
  `);
  return stmt.get(folderPath) as Folder;
}

export function getFolder(id: number): Folder | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM pdfsearch_folders WHERE id = ?').get(id) as Folder | null;
}

export function listFolders(): Folder[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM pdfsearch_folders ORDER BY added_at DESC').all() as Folder[];
}

export function updateFolderStatus(
  id: number,
  status: Folder['status'],
  extras?: { file_count?: number; error_message?: string; last_indexed_at?: string },
): void {
  const db = getDatabase();
  const fields: string[] = ['status = ?'];
  const params: unknown[] = [status];

  if (extras?.file_count !== undefined) {
    fields.push('file_count = ?');
    params.push(extras.file_count);
  }
  if (extras?.error_message !== undefined) {
    fields.push('error_message = ?');
    params.push(extras.error_message);
  }
  if (extras?.last_indexed_at !== undefined) {
    fields.push('last_indexed_at = ?');
    params.push(extras.last_indexed_at);
  }

  params.push(id);
  db.prepare(`UPDATE pdfsearch_folders SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteFolderChunks(folderId: number): void {
  const db = getDatabase();

  // Delete vec entries first (via map)
  const chunkIds = db.prepare(
    'SELECT id FROM pdfsearch_chunks WHERE folder_id = ?',
  ).all(folderId) as { id: number }[];

  for (const { id } of chunkIds) {
    const mapping = db.prepare(
      'SELECT vec_rowid FROM pdfsearch_vec_map WHERE chunk_id = ?',
    ).get(id) as { vec_rowid: number } | undefined;
    if (mapping) {
      db.prepare('DELETE FROM pdfsearch_vec WHERE rowid = ?').run(mapping.vec_rowid);
      db.prepare('DELETE FROM pdfsearch_vec_map WHERE chunk_id = ?').run(id);
    }
  }

  db.prepare('DELETE FROM pdfsearch_chunks WHERE folder_id = ?').run(folderId);
}

// ── Chunk + vector helpers ─────────────────────────────────────

export function insertChunkWithVector(
  folderId: number,
  filePath: string,
  pageNumber: number,
  chunkText: string,
  charStart: number,
  charEnd: number,
  embedding: Float32Array,
): number {
  const db = getDatabase();

  // Insert chunk row
  const chunkResult = db.prepare(`
    INSERT INTO pdfsearch_chunks (folder_id, file_path, page_number, chunk_text, char_start, char_end)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(folderId, filePath, pageNumber, chunkText, charStart, charEnd);

  const chunkId = Number(chunkResult.lastInsertRowid);

  // Insert into vec0 (auto-rowid)
  const buf = Buffer.from(embedding.buffer);
  const vecResult = db.prepare(
    'INSERT INTO pdfsearch_vec (embedding) VALUES (?)',
  ).run(buf);
  const vecRowid = Number(vecResult.lastInsertRowid);

  // Store mapping
  db.prepare(
    'INSERT INTO pdfsearch_vec_map (chunk_id, vec_rowid) VALUES (?, ?)',
  ).run(chunkId, vecRowid);

  return chunkId;
}

export function vectorSearchChunks(
  queryEmbedding: Float32Array,
  topK: number,
  folderId?: number | number[],
): Array<Chunk & { distance: number }> {
  const db = getDatabase();

  const buf = Buffer.from(queryEmbedding.buffer);

  // Normalize folderId to an array (or undefined for "all folders")
  const folderIds: number[] | undefined =
    folderId === undefined ? undefined :
    Array.isArray(folderId) ? folderId : [folderId];

  // KNN search in vec0
  interface VecRow { rowid: number; distance: number }
  // sqlite-vec's vec0 virtual table cannot apply a folder_id constraint inside the KNN
  // scan — filtering happens post-scan on the returned candidate set.  If another folder's
  // semantically similar chunks dominate the global top-(topK*3) candidates, the
  // post-filter for the requested folder returns zero results.  Use a much larger pool
  // when a folderId is supplied so that target-folder chunks survive the cut.
  const candidateLimit = folderIds !== undefined ? Math.max(topK * 3, 500) : topK * 3;

  const vecRows = db.prepare(`
    SELECT rowid, distance
    FROM pdfsearch_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(buf, candidateLimit) as VecRow[];

  if (vecRows.length === 0) return [];

  // Map vec rowids → chunk IDs
  const rowids = vecRows.map(r => r.rowid);
  const placeholders = rowids.map(() => '?').join(',');

  interface MapRow { chunk_id: number; vec_rowid: number }
  const mapRows = db.prepare(
    `SELECT chunk_id, vec_rowid FROM pdfsearch_vec_map WHERE vec_rowid IN (${placeholders})`,
  ).all(...rowids) as MapRow[];

  const rowToChunk = new Map(mapRows.map(m => [Number(m.vec_rowid), m.chunk_id]));

  // Fetch chunk details
  const chunkIds = vecRows
    .map(vr => rowToChunk.get(Number(vr.rowid)))
    .filter((id): id is number => id !== undefined);

  if (chunkIds.length === 0) return [];

  const chunkPlaceholders = chunkIds.map(() => '?').join(',');
  let sql = `SELECT * FROM pdfsearch_chunks WHERE id IN (${chunkPlaceholders})`;
  const queryParams: unknown[] = [...chunkIds];

  if (folderIds !== undefined) {
    const folderPlaceholders = folderIds.map(() => '?').join(',');
    sql += ` AND folder_id IN (${folderPlaceholders})`;
    queryParams.push(...folderIds);
  }

  const chunks = db.prepare(sql).all(...queryParams) as Chunk[];
  const chunkMap = new Map(chunks.map(c => [c.id, c]));

  // Return in score order (closest first), limited to topK
  const results: Array<Chunk & { distance: number }> = [];
  for (const vr of vecRows) {
    const chunkId = rowToChunk.get(Number(vr.rowid));
    if (!chunkId) continue;
    const chunk = chunkMap.get(chunkId);
    if (!chunk) continue;
    results.push({ ...chunk, distance: vr.distance });
    if (results.length >= topK) break;
  }

  return results;
}

export function getChunkCount(folderId: number): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM pdfsearch_chunks WHERE folder_id = ?').get(folderId) as { cnt: number };
  return row.cnt;
}

export function getFolderByPath(folderPath: string): Folder | null {
  const db = getDatabase();
  return db.prepare('SELECT * FROM pdfsearch_folders WHERE path = ?').get(folderPath) as Folder | null;
}

// Testing helper
export function _resetPdfSearchDbForTesting(): void {
  _schemaReady = false;
}
