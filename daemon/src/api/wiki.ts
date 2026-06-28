/**
 * Wiki API — search and retrieve indexed wiki articles.
 *
 * Routes:
 *   POST /api/wiki/search   — keyword, vector, or hybrid search over wiki_articles
 *   GET  /api/wiki/articles — list articles or fetch one by slug (incl. body + links)
 *
 * The wiki_vec sqlite-vec virtual table and vec_wiki_map mapping table are
 * initialized here (initWikiVectorSearch) after the main sqlite-vec extension
 * has been loaded by initVectorSearch(). This mirrors how vector-search.ts
 * handles vec_memories.
 *
 * File-memory is canonical; this API is read-only (no create/update/delete).
 */

import type http from 'node:http';
import { createRequire } from 'node:module';
import { getDatabase, query } from '../core/db.js';
import { generateEmbedding, embeddingToBuffer, EMBEDDING_DIMENSIONS } from '../memory/embeddings.js';
import { parseTags } from '../memory/vector-search.js';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp, parseBody } from './helpers.js';
import { loadConfig } from '../core/config.js';
import type { WikiAutolinkConfig } from '../core/config.js';

const log = createLogger('wiki-api');
const require = createRequire(import.meta.url);

// ── Wiki vector search init ───────────────────────────────────

let _wikiVecLoaded = false;

/**
 * Initialize wiki vector search — create wiki_vec virtual table and
 * vec_wiki_map mapping table. Must be called AFTER sqlite-vec extension is
 * loaded (i.e., after initVectorSearch() / enableVectorSearch() runs).
 * Safe to call multiple times — idempotent.
 */
export function initWikiVectorSearch(): void {
  if (_wikiVecLoaded) return;

  const db = getDatabase();

  try {
    // Load sqlite-vec extension (idempotent — already loaded by initVectorSearch,
    // but safe to call again; sqlite-vec's load() is a no-op if already loaded)
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);

    // Create wiki vector table (mirrors vec_memories in vector-search.ts)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_vec USING vec0(
        embedding float[${EMBEDDING_DIMENSIONS}]
      )
    `);

    // Mapping table: article_id ↔ vec_rowid (same pattern as vec_memory_map)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vec_wiki_map (
        article_id INTEGER PRIMARY KEY,
        vec_rowid  INTEGER NOT NULL
      )
    `);

    _wikiVecLoaded = true;
    log.info('wiki-api: vector search initialized');
  } catch (err) {
    log.warn('wiki-api: vector search unavailable', { error: String(err) });
  }
}

export function isWikiVectorEnabled(): boolean {
  return _wikiVecLoaded;
}

/** Reset for testing. */
export function _resetWikiVectorForTesting(): void {
  _wikiVecLoaded = false;
}

// ── Phase 2: testing hooks ────────────────────────────────────

/**
 * Override the autolink config for testing (bypasses loadConfig dependency).
 * Pass null to restore default (reads from loadConfig()).
 */
let _autoLinkConfigOverride: WikiAutolinkConfig | null = null;
export function _setWikiAutolinkConfigForTesting(cfg: WikiAutolinkConfig | null): void {
  _autoLinkConfigOverride = cfg;
}

/**
 * Override wikiVectorSearchByEmbedding for testing (bypasses sqlite-vec dependency).
 * Pass null to restore real implementation.
 */
type WikiVecSearchFn = (embedding: Float32Array, limit: number) => Promise<WikiVecCandidate[]>;
let _wikiVecSearchOverride: WikiVecSearchFn | null = null;
export function _setWikiVecSearchFnForTesting(fn: WikiVecSearchFn | null): void {
  _wikiVecSearchOverride = fn;
}

/** Reset all Phase 2 test hooks. */
export function _resetWikiPhase2ForTesting(): void {
  _autoLinkConfigOverride = null;
  _wikiVecSearchOverride = null;
}

// ── Types ────────────────────────────────────────────────────

/** Candidate returned by wikiVectorSearchByEmbedding. */
export interface WikiVecCandidate {
  article_id: number;
  score: number;
  /** Raw JSON tags string as stored in wiki_articles.tags. */
  tags: string;
  category: string | null;
}

interface WikiArticleRow {
  id: number;
  slug: string;
  title: string;
  body: string;
  summary: string | null;
  status: string;
  category: string | null;
  tags: string;
  embedding: Buffer | null;
  source_path: string;
  content_hash: string;
  origin_agent: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

// ── Formatters ────────────────────────────────────────────────

function formatArticleSummary(a: WikiArticleRow): Record<string, unknown> {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    category: a.category,
    tags: parseTags(a.tags),
    status: a.status,
  };
}

function formatArticleFull(
  a: WikiArticleRow,
  outLinks: string[],
  memLinks: { memory_id: number; link_type: string }[],
): Record<string, unknown> {
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    body: a.body,
    summary: a.summary,
    category: a.category,
    tags: parseTags(a.tags),
    status: a.status,
    source_path: a.source_path,
    origin_agent: a.origin_agent,
    created_at: a.created_at,
    updated_at: a.updated_at,
    published_at: a.published_at,
    wiki_article_links: outLinks,
    wiki_memory_links: memLinks,
  };
}

// ── Keyword search ────────────────────────────────────────────

interface KeywordHit {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  category: string | null;
  tags: string;
  status: string;
  kw_score: number;
}

function wikiKeywordSearch(
  queryText: string,
  limit: number,
  category?: string,
  statusFilter = 'published',
): Array<KeywordHit & { score: number }> {
  const words = queryText.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];

  const wordPatterns = words.map(w => `%${w}%`);

  // Build score expression — SELECT clause comes before WHERE in SQL,
  // so score params must be bound first.
  const scoreParts = words.map(() =>
    'CASE WHEN LOWER(title) LIKE LOWER(?) THEN 2 WHEN LOWER(summary) LIKE LOWER(?) THEN 1 WHEN LOWER(body) LIKE LOWER(?) THEN 1 ELSE 0 END'
  );
  const scoreExpr = scoreParts.join(' + ');

  // Score params (for SELECT clause — bound first in SQLite left-to-right)
  const scoreParams: unknown[] = [];
  for (const p of wordPatterns) {
    scoreParams.push(p, p, p);
  }

  // WHERE clause conditions
  const conditions: string[] = ['status = ?'];
  const condParams: unknown[] = [statusFilter];

  const orClauses = words.map(() =>
    '(LOWER(title) LIKE LOWER(?) OR LOWER(summary) LIKE LOWER(?) OR LOWER(body) LIKE LOWER(?))'
  );
  conditions.push(`(${orClauses.join(' OR ')})`);
  for (const p of wordPatterns) {
    condParams.push(p, p, p);
  }

  if (category) {
    conditions.push('category = ?');
    condParams.push(category);
  }

  // Bind order: score params, then WHERE params, then LIMIT
  const params = [...scoreParams, ...condParams, limit];

  const sql = `
    SELECT id, slug, title, summary, category, tags, status,
           (${scoreExpr}) AS kw_score
    FROM wiki_articles
    WHERE ${conditions.join(' AND ')}
    ORDER BY kw_score DESC, updated_at DESC
    LIMIT ?
  `;

  const rows = query<KeywordHit>(sql, ...params);
  return rows.map(r => ({ ...r, score: r.kw_score }));
}

// ── Vector search ─────────────────────────────────────────────

interface VecHit {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  category: string | null;
  tags: string;
  status: string;
  score: number;
}

async function wikiVectorSearch(
  queryText: string,
  limit: number,
  category?: string,
  statusFilter = 'published',
): Promise<VecHit[]> {
  if (!_wikiVecLoaded) return [];

  const db = getDatabase();
  const queryEmbedding = await generateEmbedding(queryText);
  const queryBuf = embeddingToBuffer(queryEmbedding);

  interface VecRow { rowid: number; distance: number }

  const vecRows = db.prepare(`
    SELECT rowid, distance
    FROM wiki_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(queryBuf, limit * 2) as VecRow[];

  if (vecRows.length === 0) return [];

  const vecRowids = vecRows.map(r => r.rowid);
  const placeholders = vecRowids.map(() => '?').join(',');

  interface MapRow { article_id: number; vec_rowid: number }
  const mapRows = db.prepare(
    `SELECT article_id, vec_rowid FROM vec_wiki_map WHERE vec_rowid IN (${placeholders})`,
  ).all(...vecRowids) as MapRow[];

  const vecToArticle = new Map(mapRows.map(m => [Number(m.vec_rowid), m.article_id]));

  const articleIds = vecRows
    .map(vr => vecToArticle.get(Number(vr.rowid)))
    .filter((id): id is number => id !== undefined);

  if (articleIds.length === 0) return [];

  const artPlaceholders = articleIds.map(() => '?').join(',');
  const extraConditions = category ? ' AND category = ?' : '';
  const extraParams = category ? [category] : [];

  interface ArticleHitRow {
    id: number; slug: string; title: string;
    summary: string | null; category: string | null; tags: string; status: string;
  }

  const articles = db.prepare(
    `SELECT id, slug, title, summary, category, tags, status
     FROM wiki_articles
     WHERE id IN (${artPlaceholders}) AND status = ?${extraConditions}`,
  ).all(...articleIds, statusFilter, ...extraParams) as ArticleHitRow[];

  const artMap = new Map(articles.map(a => [a.id, a]));

  const results = vecRows
    .map(vr => {
      const artId = vecToArticle.get(Number(vr.rowid));
      if (!artId) return null;
      const art = artMap.get(artId);
      if (!art) return null;
      // L2-distance → cosine similarity (normalized vectors): 1 - d²/2
      const score = Math.max(0, 1 - (vr.distance * vr.distance) / 2);
      return { ...art, score };
    })
    .filter((r): r is VecHit => r !== null)
    .slice(0, limit);

  return results;
}

// ── Hybrid search ─────────────────────────────────────────────

async function wikiHybridSearch(
  queryText: string,
  limit: number,
  category?: string,
  statusFilter = 'published',
): Promise<VecHit[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    wikiVectorSearch(queryText, limit * 2, category, statusFilter),
    Promise.resolve(wikiKeywordSearch(queryText, limit * 2, category, statusFilter)),
  ]);

  const merged = new Map<number, VecHit & { keyword_score: number; vector_score: number; combined_score: number }>();

  const maxVecScore = vectorResults.length > 0
    ? Math.max(...vectorResults.map(r => r.score))
    : 1;

  for (const vr of vectorResults) {
    const normalizedVec = maxVecScore > 0 ? vr.score / maxVecScore : 0;
    merged.set(vr.id, {
      ...vr,
      keyword_score: 0,
      vector_score: normalizedVec,
      combined_score: 0.6 * normalizedVec,
    });
  }

  const maxKwScore = keywordResults.length > 0
    ? Math.max(...keywordResults.map(r => r.score))
    : 1;

  for (const kr of keywordResults) {
    const normalizedKw = maxKwScore > 0 ? kr.score / maxKwScore : 0;
    const existing = merged.get(kr.id);
    if (existing) {
      existing.keyword_score = normalizedKw;
      existing.combined_score = 0.4 * normalizedKw + 0.6 * existing.vector_score;
    } else {
      merged.set(kr.id, {
        ...kr,
        keyword_score: normalizedKw,
        vector_score: 0,
        combined_score: 0.4 * normalizedKw,
      });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.combined_score - a.combined_score)
    .slice(0, limit)
    .map(r => ({ ...r, score: r.combined_score }));
}

// ── Phase 2: vector search by precomputed embedding ──────────

/**
 * Search wiki_vec using an already-computed Float32Array embedding (no re-embed).
 * Returns candidates sorted highest-score-first.
 *
 * Accepts a testing override via _setWikiVecSearchFnForTesting so that sqlite-vec
 * is not required in unit tests.
 */
export async function wikiVectorSearchByEmbedding(
  embedding: Float32Array,
  limit: number,
): Promise<WikiVecCandidate[]> {
  // Test override bypasses sqlite-vec entirely
  if (_wikiVecSearchOverride) {
    return _wikiVecSearchOverride(embedding, limit);
  }

  if (!_wikiVecLoaded) return [];

  const db = getDatabase();
  const queryBuf = embeddingToBuffer(embedding);

  interface VecRow { rowid: number; distance: number }

  const vecRows = db.prepare(`
    SELECT rowid, distance
    FROM wiki_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(queryBuf, limit * 2) as VecRow[];

  if (vecRows.length === 0) return [];

  const vecRowids = vecRows.map(r => r.rowid);
  const placeholders = vecRowids.map(() => '?').join(',');

  interface MapRow { article_id: number; vec_rowid: number }
  const mapRows = db.prepare(
    `SELECT article_id, vec_rowid FROM vec_wiki_map WHERE vec_rowid IN (${placeholders})`,
  ).all(...vecRowids) as MapRow[];

  const vecToArticle = new Map(mapRows.map(m => [Number(m.vec_rowid), m.article_id]));

  const articleIds = vecRows
    .map(vr => vecToArticle.get(Number(vr.rowid)))
    .filter((id): id is number => id !== undefined);

  if (articleIds.length === 0) return [];

  const artPlaceholders = articleIds.map(() => '?').join(',');

  interface ArticleHitRow { id: number; tags: string; category: string | null; status: string }
  const articles = db.prepare(
    `SELECT id, tags, category, status
     FROM wiki_articles
     WHERE id IN (${artPlaceholders}) AND status = 'published'`,
  ).all(...articleIds) as ArticleHitRow[];

  const artMap = new Map(articles.map(a => [a.id, a]));

  return vecRows
    .map(vr => {
      const artId = vecToArticle.get(Number(vr.rowid));
      if (!artId) return null;
      const art = artMap.get(artId);
      if (!art) return null;
      // L2 distance → cosine similarity (normalized vectors): 1 - d²/2
      const score = Math.max(0, 1 - (vr.distance * vr.distance) / 2);
      return { article_id: artId, score, tags: art.tags, category: art.category };
    })
    .filter((r): r is WikiVecCandidate => r !== null)
    .slice(0, limit);
}

// ── Phase 2: auto-link helper ─────────────────────────────────

/**
 * Auto-link a newly stored memory to relevant wiki articles.
 *
 * Called from both POST /api/memory/store and storeMemoryInternal() after the
 * memory's embedding has already been computed (no re-embed).
 *
 * Feature is config-gated and DEFAULT OFF — see wiki.autolink.enabled in
 * kithkit.defaults.yaml. Wrap all callers in try/catch; this must be non-fatal.
 *
 * @param memoryId   - The newly inserted memory's id
 * @param embedding  - Already-computed embedding (reuse from store — no re-embed)
 * @param tags       - Memory tags (used for shared-tag gate)
 * @param category   - Memory category (used as shared-category fallback)
 */
export async function autoLinkMemoryToWiki(
  memoryId: number,
  embedding: Float32Array,
  tags: string[],
  category: string | null,
): Promise<void> {
  // Resolve autolink config — test override or real config
  const autolink: WikiAutolinkConfig | undefined =
    _autoLinkConfigOverride ?? loadConfig().wiki?.autolink;

  // DEFAULT OFF: return immediately if feature is not explicitly enabled
  if (!autolink?.enabled) return;

  // Skip if wiki vector search is unavailable (and no test override in place)
  if (!_wikiVecSearchOverride && !_wikiVecLoaded) return;

  const threshold = autolink.similarity_threshold ?? 0.75;
  const maxLinks = autolink.max_links ?? 1;
  const requireSharedTag = autolink.require_shared_tag ?? true;

  // Fetch candidates using precomputed embedding — fetch a generous batch to
  // allow threshold + tag filtering before capping at max_links
  const candidates = await wikiVectorSearchByEmbedding(embedding, maxLinks * 10);

  const db = getDatabase();
  // INSERT OR IGNORE respects the UNIQUE(article_id, memory_id) constraint
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO wiki_memory_links (article_id, memory_id, link_type)
    VALUES (?, ?, 'related')
  `);

  let linked = 0;
  for (const candidate of candidates) {
    if (linked >= maxLinks) break;

    // Threshold gate
    if (candidate.score < threshold) continue;

    // Shared-tag gate (tag OR category match)
    if (requireSharedTag) {
      const artTags = parseTags(candidate.tags);
      const sharedTag = tags.some(t => artTags.includes(t));
      const sharedCategory = category !== null && candidate.category === category;
      if (!sharedTag && !sharedCategory) continue;
    }

    insertStmt.run(candidate.article_id, memoryId);
    linked++;
  }
}

// ── Route handler ─────────────────────────────────────────────

export async function handleWikiRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // POST /api/wiki/search
    if (pathname === '/api/wiki/search' && method === 'POST') {
      const body = await parseBody(req);

      const queryText = body['query'];
      if (!queryText || typeof queryText !== 'string') {
        json(res, 400, withTimestamp({ error: 'query is required' }));
        return true;
      }

      const mode = (body['mode'] as string) ?? 'hybrid';
      if (!['keyword', 'vector', 'hybrid'].includes(mode)) {
        json(res, 400, withTimestamp({ error: 'mode must be keyword, vector, or hybrid' }));
        return true;
      }

      const limit = Math.min(Number(body['limit'] ?? 10), 50);
      const category = body['category'] as string | undefined;
      const statusFilter = (body['status'] as string) ?? 'published';

      if ((mode === 'vector' || mode === 'hybrid') && !_wikiVecLoaded) {
        // Fall back to keyword if vector unavailable
        const results = wikiKeywordSearch(queryText, limit, category, statusFilter);
        const data = results.map(r => ({ ...formatArticleSummary(r as unknown as WikiArticleRow), score: r.score }));
        json(res, 200, withTimestamp({ data, mode: 'keyword', fallback: true }));
        return true;
      }

      let data: Array<Record<string, unknown>>;
      let resolvedMode = mode;

      if (mode === 'keyword') {
        const results = wikiKeywordSearch(queryText, limit, category, statusFilter);
        data = results.map(r => ({ ...formatArticleSummary(r as unknown as WikiArticleRow), score: r.score }));
      } else if (mode === 'vector') {
        const results = await wikiVectorSearch(queryText, limit, category, statusFilter);
        data = results.map(r => ({ ...formatArticleSummary(r as unknown as WikiArticleRow), score: r.score }));
      } else {
        // hybrid (default)
        const results = await wikiHybridSearch(queryText, limit, category, statusFilter);
        data = results.map(r => ({ ...formatArticleSummary(r as unknown as WikiArticleRow), score: r.score }));
        resolvedMode = 'hybrid';
      }

      json(res, 200, withTimestamp({ data, mode: resolvedMode }));
      return true;
    }

    // POST /api/wiki/memory-links — explicit consolidation links (Phase 2, ITEM 2)
    // Creates or upgrades a wiki_memory_links row.  link_type must be one of
    // {related, derived_from, contradicts, supersedes}.  Re-POSTing with a new
    // type upgrades the existing row (ON CONFLICT DO UPDATE).
    // NOTE: this is a LINK (DB join), not an article — no article CRUD here.
    if (pathname === '/api/wiki/memory-links' && method === 'POST') {
      const body = await parseBody(req);

      const VALID_LINK_TYPES = ['related', 'derived_from', 'contradicts', 'supersedes'];

      const articleId = body['article_id'];
      const memoryId = body['memory_id'];
      const linkType = (body['link_type'] as string) ?? 'related';

      if (typeof articleId !== 'number' || !Number.isInteger(articleId) || articleId <= 0) {
        json(res, 400, withTimestamp({ error: 'article_id must be a positive integer' }));
        return true;
      }

      if (typeof memoryId !== 'number' || !Number.isInteger(memoryId) || memoryId <= 0) {
        json(res, 400, withTimestamp({ error: 'memory_id must be a positive integer' }));
        return true;
      }

      if (!VALID_LINK_TYPES.includes(linkType)) {
        json(res, 400, withTimestamp({
          error: `link_type must be one of: ${VALID_LINK_TYPES.join(', ')}`,
          received: linkType,
        }));
        return true;
      }

      const db = getDatabase();

      // INSERT OR UPDATE — explicit type upgrades an auto 'related'
      db.prepare(`
        INSERT INTO wiki_memory_links (article_id, memory_id, link_type)
        VALUES (?, ?, ?)
        ON CONFLICT(article_id, memory_id) DO UPDATE SET link_type = excluded.link_type
      `).run(articleId, memoryId, linkType);

      interface MemLinkRow {
        id: number; article_id: number; memory_id: number;
        link_type: string; created_at: string;
      }
      const link = db.prepare(
        'SELECT * FROM wiki_memory_links WHERE article_id = ? AND memory_id = ?',
      ).get(articleId, memoryId) as MemLinkRow;

      json(res, 201, withTimestamp({ data: link }));
      return true;
    }

    // GET /api/wiki/articles
    if (pathname === '/api/wiki/articles' && method === 'GET') {
      // Parse query params from the request URL
      const urlObj = new URL(req.url ?? '/api/wiki/articles', 'http://localhost');
      const slug = urlObj.searchParams.get('slug');
      const category = urlObj.searchParams.get('category');
      const statusFilter = urlObj.searchParams.get('status') ?? 'published';
      const limit = Math.min(Number(urlObj.searchParams.get('limit') ?? '50'), 200);
      const offset = Number(urlObj.searchParams.get('offset') ?? '0');
      const linkedMemoryIdParam = urlObj.searchParams.get('linked_memory_id');

      // Phase 2, ITEM 3: memory → articles reverse read
      // GET /api/wiki/articles?linked_memory_id=N — articles linked to this memory
      if (linkedMemoryIdParam !== null) {
        const memId = Number(linkedMemoryIdParam);
        if (!Number.isInteger(memId) || memId <= 0) {
          json(res, 400, withTimestamp({ error: 'linked_memory_id must be a positive integer' }));
          return true;
        }

        interface MemLinkedArticle {
          id: number; slug: string; title: string; summary: string | null;
          category: string | null; tags: string; status: string; link_type: string;
        }

        // Uses idx_wiki_mem_memory index for efficiency
        const db = getDatabase();
        const articles = db.prepare(`
          SELECT a.id, a.slug, a.title, a.summary, a.category, a.tags, a.status,
                 wml.link_type
          FROM wiki_memory_links wml
          JOIN wiki_articles a ON a.id = wml.article_id
          WHERE wml.memory_id = ?
          ORDER BY wml.created_at DESC
        `).all(memId) as MemLinkedArticle[];

        json(res, 200, withTimestamp({
          data: articles.map(a => ({
            ...formatArticleSummary(a as unknown as WikiArticleRow),
            link_type: a.link_type,
          })),
        }));
        return true;
      }

      if (slug) {
        // Single article by slug — return full body + links
        const article = query<WikiArticleRow>(
          'SELECT * FROM wiki_articles WHERE slug = ?',
          slug,
        )[0];

        if (!article) {
          json(res, 404, withTimestamp({ error: 'Article not found', slug }));
          return true;
        }

        // Fetch outgoing wikilinks (slugs of linked articles)
        interface LinkRow { slug: string }
        const outLinks = query<LinkRow>(
          `SELECT a.slug FROM wiki_article_links wl
           JOIN wiki_articles a ON a.id = wl.to_id
           WHERE wl.from_id = ?`,
          article.id,
        ).map(r => r.slug);

        // Fetch memory links
        interface MemLinkRow { memory_id: number; link_type: string }
        const memLinks = query<MemLinkRow>(
          'SELECT memory_id, link_type FROM wiki_memory_links WHERE article_id = ?',
          article.id,
        );

        json(res, 200, withTimestamp({
          data: formatArticleFull(article, outLinks, memLinks),
        }));
        return true;
      }

      // List mode — no body returned (keep payloads small)
      const conditions: string[] = ['status = ?'];
      const params: unknown[] = [statusFilter];

      if (category) {
        conditions.push('category = ?');
        params.push(category);
      }

      params.push(limit, offset);

      const articles = query<WikiArticleRow>(
        `SELECT * FROM wiki_articles
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
        ...params,
      );

      json(res, 200, withTimestamp({
        data: articles.map(a => formatArticleSummary(a)),
        limit,
        offset,
      }));
      return true;
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
