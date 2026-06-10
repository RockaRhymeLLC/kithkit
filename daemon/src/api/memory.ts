/**
 * Memory API — store, search (structured), retrieve, and delete memories.
 * Structured search covers keyword (SQL LIKE), tags, category, and date ranges.
 * Embedding column is reserved for vector search (s-f05b).
 *
 * Features:
 * - Vector dedup on store (optional, via `dedup: true` in request body)
 * - Access tracking (last_accessed updated on retrieval/search)
 */

import type http from 'node:http';
import { insert, get, remove, query, getDatabase } from '../core/db.js';
import { generateEmbedding, embeddingToBuffer } from '../memory/embeddings.js';
import { initVectorSearch, indexEmbedding, vectorSearch, hybridSearch, backfillEmbeddings } from '../memory/vector-search.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('memory-api');

// ── Types ────────────────────────────────────────────────────

interface Memory {
  id: number;
  content: string;
  type: string;
  category: string | null;
  tags: string; // JSON array
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
  last_accessed: string | null;
  origin_agent: string | null;
  trigger: string | null;
  shareable: number; // 1=yes, 0=no; default 1
  decay_policy: string | null; // default 'default'
}

/** Similarity threshold for vector dedup (0-1, higher = stricter).
 * Empirically tested 2026-02-24: true dupes score 0.78–0.98, unrelated < 0.65.
 * Set at 0.75 to catch semantic duplicates while letting the LLM reviewer
 * make the final keep/skip decision on candidates. */
const DEDUP_SIMILARITY_THRESHOLD = 0.75;

interface SearchFilters {
  query?: string;
  tags?: string[];
  category?: string;
  type?: string;
  date_from?: string;
  date_to?: string;
}

const VALID_TYPES = ['fact', 'episodic', 'procedural'];

/**
 * Categories whose memories auto-share to peers by default (shareable=1).
 * These are the self-improvement/learning categories produced by the retro
 * loop and transcript-review hooks. All other categories — event, technical,
 * person, user, private, fact, and anything not in this set — default to
 * shareable=0 (local only) unless the caller explicitly sets shareable=1.
 *
 * Enumeration of call-sites confirms these are the only categories that
 * should flow to peers by default:
 *   api-format   — retro worker + transcript-review hook
 *   behavioral   — retro worker + transcript-review hook (correction-detector
 *                  explicitly passes shareable:false, so not affected)
 *   process      — retro worker + transcript-review hook
 *   tool-usage   — retro worker + transcript-review hook
 *   communication — retro worker + transcript-review hook
 *
 * Call-sites that stay shareable=0 by default:
 *   'event'      — state.ts (todo completion), task-queue.ts, unified-tasks.ts
 *   'technical'  — memory-extraction hook (local context)
 *   null/other   — any call without an explicit self-improvement category
 */
const SHAREABLE_CATEGORIES = new Set([
  'api-format',
  'behavioral',
  'process',
  'tool-usage',
  'communication',
]);

/**
 * Return the correct default shareable value for a given category.
 * Only self-improvement/learning categories auto-share to peers.
 */
function defaultShareable(category: string | null | undefined): number {
  return category && SHAREABLE_CATEGORIES.has(category) ? 1 : 0;
}

let _vectorEnabled = false;

/**
 * Enable vector search. Call after database is open and sqlite-vec is available.
 */
export function enableVectorSearch(): void {
  try {
    initVectorSearch();
    _vectorEnabled = true;
  } catch {
    _vectorEnabled = false;
  }
}

/** Check if vector search is enabled. */
export function isVectorSearchEnabled(): boolean {
  return _vectorEnabled;
}

/** Reset for testing. */
export function _resetVectorForTesting(): void {
  _vectorEnabled = false;
}

// ── Helpers ──────────────────────────────────────────────────

import { json, withTimestamp, parseBody } from './helpers.js';
import { syncToPeers } from '../self-improvement/memory-sync.js';

function extractId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length + 1);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** Format a memory row for API response (parse tags JSON). */
function formatMemory(m: Memory): Record<string, unknown> {
  return {
    id: m.id,
    content: m.content,
    type: m.type,
    category: m.category,
    tags: JSON.parse(m.tags || '[]'),
    source: m.source,
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_accessed: m.last_accessed,
    origin_agent: m.origin_agent ?? null,
    trigger: m.trigger ?? null,
    shareable: m.shareable ?? 1,
    decay_policy: m.decay_policy ?? 'default',
  };
}

/** Update last_accessed for a batch of memory IDs. */
function touchMemories(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE memories SET last_accessed = datetime('now') WHERE id IN (${placeholders})`,
  ).run(...ids);
}

// ── Structured search ────────────────────────────────────────

function searchMemories(filters: SearchFilters): Record<string, unknown>[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.query) {
    // Count keyword matches for relevance ranking
    // Split query into words and match each with LIKE
    const words = filters.query.trim().split(/\s+/);
    for (const word of words) {
      conditions.push('content LIKE ?');
      params.push(`%${word}%`);
    }
  }

  if (filters.tags && filters.tags.length > 0) {
    // Match any of the provided tags using JSON
    const tagConditions = filters.tags.map(() => {
      return "EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)";
    });
    conditions.push(`(${tagConditions.join(' OR ')})`);
    params.push(...filters.tags);
  }

  if (filters.category) {
    conditions.push('category = ?');
    params.push(filters.category);
  }

  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }

  if (filters.date_from) {
    conditions.push('created_at >= ?');
    params.push(filters.date_from);
  }

  if (filters.date_to) {
    conditions.push('created_at <= ?');
    params.push(filters.date_to);
  }

  // Build relevance scoring for keyword queries
  let orderBy: string;
  if (filters.query) {
    // Score by number of keyword occurrences in content
    const words = filters.query.trim().split(/\s+/);
    const scoreParts = words.map(() => {
      return "(LENGTH(content) - LENGTH(REPLACE(LOWER(content), LOWER(?), ''))) / MAX(LENGTH(?), 1)";
    });
    const scoreExpr = scoreParts.join(' + ');
    orderBy = `(${scoreExpr}) DESC, created_at DESC`;
    // Add score params (each word appears twice in the expression)
    for (const word of words) {
      params.push(word, word);
    }
  } else {
    orderBy = 'created_at DESC';
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM memories ${where} ORDER BY ${orderBy}`;

  const rows = query<Memory>(sql, ...params);
  return rows.map(formatMemory);
}

// ── Internal store function ───────────────────────────────────

/**
 * Store a memory directly (no HTTP round-trip). Safe to call from other API
 * handlers — failures are non-fatal by convention; callers should wrap in
 * try/catch if they don't want to propagate errors.
 *
 * The `dedup` option uses a simple time-based check (same source + first 50
 * chars of content stored within the last 5 minutes) rather than vector
 * similarity, so it works even when vector search is disabled.
 */
export async function storeMemoryInternal(opts: {
  content: string;
  category?: string;
  tags?: string[];
  source?: string;
  importance?: number;
  dedup?: boolean;
  origin_agent?: string;
  trigger?: string;
}): Promise<void> {
  const { content, category, tags, source, importance, dedup, origin_agent, trigger } = opts;

  // Simple time-based dedup: skip if an identical (or near-identical) memory
  // with the same source was stored in the last 5 minutes.
  if (dedup && source) {
    const prefix = content.slice(0, 50);
    const existing = query<{ id: number }>(
      `SELECT id FROM memories WHERE source = ? AND content LIKE ? AND created_at >= datetime('now', '-5 minutes') LIMIT 1`,
      source,
      `${prefix}%`,
    );
    if (existing.length > 0) return;
  }

  const data: Record<string, unknown> = { content };
  if (category) data.category = category;
  if (tags) data.tags = JSON.stringify(tags);
  if (source) data.source = source;
  if (importance != null) data.importance = importance;
  if (origin_agent) data.origin_agent = origin_agent;
  if (trigger) data.trigger = trigger;
  // Only self-improvement/learning categories auto-share to peers.
  // All other internally-stored memories (event, technical, etc.) stay local.
  data.shareable = defaultShareable(category);

  const memory = insert<Memory>('memories', data);

  // Auto-generate embedding if vector search is available (non-fatal on failure)
  try {
    if (_vectorEnabled) {
      const embedding = await generateEmbedding(content);
      const buf = embeddingToBuffer(embedding);
      const db = getDatabase();
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, memory.id);
      indexEmbedding(memory.id, embedding);
    }
  } catch {
    // Embedding failure is non-fatal
  }
}

// ── Route handler ────────────────────────────────────────────

export async function handleMemoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // GET /memory/since/:timestamp — return shareable memories created after a timestamp
    // Used by peers for offline catch-up
    if (pathname.startsWith('/api/memory/since/') && method === 'GET') {
      const rawTs = pathname.slice('/api/memory/since/'.length);
      const ts = decodeURIComponent(rawTs);
      if (!ts) {
        json(res, 400, withTimestamp({ error: 'timestamp is required' }));
        return true;
      }
      const memories = query<Memory>(
        `SELECT * FROM memories WHERE shareable = 1 AND created_at > ? ORDER BY created_at ASC`,
        ts,
      );
      json(res, 200, withTimestamp({ memories: memories.map(formatMemory) }));
      return true;
    }

    // GET /api/memory/stats — counts + boundary timestamps for the memory store.
    // Replaces the old per-category-cap heuristic that callers used to figure
    // out how full things were. Localhost-only same as the rest of the API.
    if (pathname === '/api/memory/stats' && method === 'GET') {
      const totalRow = query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memories WHERE expires_at IS NULL`,
      );
      const total = totalRow[0]?.n ?? 0;

      const byCategory = query<{ category: string | null; n: number }>(
        `SELECT COALESCE(category, '(uncategorized)') AS category, COUNT(*) AS n
           FROM memories
          WHERE expires_at IS NULL
          GROUP BY category
          ORDER BY n DESC`,
      );

      const idRow = query<{ max_id: number | null; min_id: number | null }>(
        `SELECT MAX(id) AS max_id, MIN(id) AS min_id FROM memories WHERE expires_at IS NULL`,
      );

      const tsRow = query<{ newest: string | null; oldest: string | null }>(
        `SELECT MAX(created_at) AS newest, MIN(created_at) AS oldest
           FROM memories WHERE expires_at IS NULL`,
      );

      // Cheap byte total — SUM(LENGTH(content)). Doesn't include tags, embeddings,
      // or other columns. Good enough as a "are we approaching disk pressure" signal.
      const bytesRow = query<{ content_bytes: number | null }>(
        `SELECT SUM(LENGTH(content)) AS content_bytes
           FROM memories WHERE expires_at IS NULL`,
      );

      const archivedRow = query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memories WHERE expires_at IS NOT NULL`,
      );

      json(res, 200, withTimestamp({
        total,
        archived: archivedRow[0]?.n ?? 0,
        max_id: idRow[0]?.max_id ?? null,
        min_id: idRow[0]?.min_id ?? null,
        newest_at: tsRow[0]?.newest ?? null,
        oldest_at: tsRow[0]?.oldest ?? null,
        content_bytes: bytesRow[0]?.content_bytes ?? 0,
        by_category: byCategory.map(r => ({ category: r.category, count: r.n })),
      }));
      return true;
    }

    // POST /memory/backfill — generate embeddings for memories missing them
    if (pathname === '/api/memory/backfill' && method === 'POST') {
      if (!_vectorEnabled) {
        json(res, 503, withTimestamp({ error: 'Vector search not initialized' }));
        return true;
      }
      const count = await backfillEmbeddings();
      json(res, 200, withTimestamp({ backfilled: count }));
      return true;
    }

    // POST /memory/store — create a new memory
    if (pathname === '/api/memory/store' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.content || typeof body.content !== 'string') {
        json(res, 400, withTimestamp({ error: 'content is required' }));
        return true;
      }

      if (body.type && !VALID_TYPES.includes(body.type as string)) {
        json(res, 400, withTimestamp({ error: `type must be ${VALID_TYPES.join(', ')}` }));
        return true;
      }

      // Vector dedup: if dedup=true and vector search is available, find candidates
      // Returns candidates to the caller — the agent decides whether to store or skip.
      // Reason: vector similarity gives false positives (e.g. "Partner likes pie" vs
      // "David likes pie" score high but are different memories). The LLM decides.
      const wantDedup = body.dedup === true;
      if (wantDedup && _vectorEnabled) {
        try {
          const candidates = await vectorSearch(body.content as string, 3);
          const similar = candidates.filter(c => c.score >= DEDUP_SIMILARITY_THRESHOLD);
          if (similar.length > 0) {
            json(res, 200, withTimestamp({
              action: 'review_duplicates',
              message: 'Potential duplicates found — caller decides whether to store',
              duplicates: similar.map(c => ({
                id: c.id,
                content: c.content,
                similarity: c.score,
                category: c.category,
              })),
              proposed: {
                content: body.content,
                type: body.type ?? 'fact',
                category: body.category ?? null,
                tags: body.tags ?? [],
              },
            }));
            return true;
          }
        } catch {
          // Dedup check failed — fall through and store anyway
        }
      }

      // Memory category caps removed (todo #341, Dave directive 2026-05-09).
      // Per-category caps were silently dropping new entries (e.g. technical
      // category at 200 silently rejected SN class-mismatch lesson on 5/5).
      // Memory store is now bounded by storage, not arbitrary per-category
      // limits. Lifecycle pruning belongs in the consolidation task with a
      // time/size policy, not a hard cap at write time.

      const data: Record<string, unknown> = {
        content: body.content,
      };
      // Note: `type` field is accepted for API compatibility but not stored
      // (the `type` column was removed in migration 010)
      if (body.category) data.category = body.category;
      if (body.tags) data.tags = JSON.stringify(body.tags);
      if (body.source) data.source = body.source;
      if (body.importance != null) data.importance = body.importance;
      if (body.origin_agent != null) data.origin_agent = body.origin_agent;
      if (body.trigger != null) data.trigger = body.trigger;
      // shareable: caller-supplied value wins; absent → category-scoped default.
      // Only self-improvement/learning categories (api-format, behavioral, process,
      // tool-usage, communication) auto-share to peers. All others default to 0.
      data.shareable = body.shareable != null
        ? (body.shareable ? 1 : 0)
        : defaultShareable(body.category as string | null);
      if (body.decay_policy != null) data.decay_policy = body.decay_policy;

      const memory = insert<Memory>('memories', data);

      // Auto-generate embedding if vector search is available
      try {
        if (_vectorEnabled) {
          const embedding = await generateEmbedding(body.content as string);
          const buf = embeddingToBuffer(embedding);
          const db = getDatabase();
          db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, memory.id);
          indexEmbedding(memory.id, embedding);
        }
      } catch {
        // Embedding generation failure is non-fatal — memory is still stored
      }

      // Async outbound sync to peers (non-blocking, fire-and-forget)
      if (memory.shareable !== 0) {
        syncToPeers(memory as unknown as Record<string, unknown>).catch((err) =>
          log.warn('Memory sync to peers failed', { error: String(err) }),
        );
      }

      json(res, 201, withTimestamp(formatMemory(memory)));
      return true;
    }

    // POST /memory/search — structured, vector, or hybrid search
    if (pathname === '/api/memory/search' && method === 'POST') {
      const body = await parseBody(req);
      const mode = (body.mode as string) ?? 'keyword';

      // Vector and hybrid modes require a query string
      if ((mode === 'vector' || mode === 'hybrid') && (!body.query || typeof body.query !== 'string')) {
        json(res, 400, withTimestamp({ error: 'query is required for vector/hybrid search' }));
        return true;
      }

      if ((mode === 'vector' || mode === 'hybrid') && !_vectorEnabled) {
        json(res, 503, withTimestamp({ error: 'Vector search not initialized' }));
        return true;
      }

      if (mode === 'vector') {
        const results = await vectorSearch(body.query as string, (body.limit as number) ?? 10);
        touchMemories(results.map(r => r.id));
        json(res, 200, withTimestamp({ data: results, mode: 'vector' }));
        return true;
      }

      if (mode === 'hybrid') {
        const results = await hybridSearch(body.query as string, (body.limit as number) ?? 10);
        touchMemories(results.map(r => r.id));
        json(res, 200, withTimestamp({ data: results, mode: 'hybrid' }));
        return true;
      }

      // Default: keyword (structured) search
      const hasQuery = body.query && typeof body.query === 'string';
      const hasTags = Array.isArray(body.tags) && (body.tags as unknown[]).length > 0;
      const hasCategory = body.category && typeof body.category === 'string';
      const hasType = body.type && typeof body.type === 'string';
      const hasDateFrom = body.date_from && typeof body.date_from === 'string';
      const hasDateTo = body.date_to && typeof body.date_to === 'string';

      if (!hasQuery && !hasTags && !hasCategory && !hasType && !hasDateFrom && !hasDateTo) {
        json(res, 400, withTimestamp({ error: 'query or at least one filter required' }));
        return true;
      }

      const filters: SearchFilters = {};
      if (hasQuery) filters.query = body.query as string;
      if (hasTags) filters.tags = body.tags as string[];
      if (hasCategory) filters.category = body.category as string;
      if (hasType) filters.type = body.type as string;
      if (hasDateFrom) filters.date_from = body.date_from as string;
      if (hasDateTo) filters.date_to = body.date_to as string;

      const results = searchMemories(filters);
      touchMemories(results.map(r => r.id as number));
      json(res, 200, withTimestamp({ data: results, mode: 'keyword' }));
      return true;
    }

    // GET /memory/:id — retrieve a memory
    const memoryId = extractId(pathname, '/api/memory');
    if (memoryId !== null) {
      if (method === 'GET') {
        const memory = get<Memory>('memories', Number(memoryId));
        if (!memory) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        touchMemories([memory.id]);
        json(res, 200, withTimestamp(formatMemory(memory)));
        return true;
      }

      // DELETE /memory/:id — delete a memory
      if (method === 'DELETE') {
        const deleted = remove('memories', Number(memoryId));
        if (!deleted) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    return false;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Request body too large') {
        json(res, 413, withTimestamp({ error: 'Request body too large' }));
        return true;
      }
      if (err.message === 'Invalid JSON') {
        json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
        return true;
      }
    }
    throw err;
  }
}
