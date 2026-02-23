/**
 * Memory API — store, search (structured), retrieve, and delete memories.
 * Structured search covers keyword (SQL LIKE), tags, category, and date ranges.
 * Embedding column is reserved for vector search (s-f05b).
 */

import type http from 'node:http';
import { insert, get, remove, query, getDatabase } from '../core/db.js';
import { generateEmbedding, embeddingToBuffer } from '../memory/embeddings.js';
import { initVectorSearch, indexEmbedding, vectorSearch, hybridSearch } from '../memory/vector-search.js';

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
}

interface SearchFilters {
  query?: string;
  tags?: string[];
  category?: string;
  type?: string;
  date_from?: string;
  date_to?: string;
}

const VALID_TYPES = ['fact', 'episodic', 'procedural'];

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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

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
  };
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

// ── Route handler ────────────────────────────────────────────

export async function handleMemoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
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

      const data: Record<string, unknown> = {
        content: body.content,
      };
      if (body.type) data.type = body.type;
      if (body.category) data.category = body.category;
      if (body.tags) data.tags = JSON.stringify(body.tags);
      if (body.source) data.source = body.source;

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
        json(res, 200, withTimestamp({ data: results, mode: 'vector' }));
        return true;
      }

      if (mode === 'hybrid') {
        const results = await hybridSearch(body.query as string, (body.limit as number) ?? 10);
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
    if (err instanceof Error && err.message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }
    throw err;
  }
}
