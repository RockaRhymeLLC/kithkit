/**
 * Wiki-index — scheduler task that indexes the file-memory wiki into the DB.
 *
 * Reads topic files from ~/.claude/projects/<encoded>/memory/, parses YAML
 * frontmatter, generates embeddings, and upserts rows into wiki_articles.
 * Resolves [[wikilinks]] into wiki_article_links. Archives rows for files
 * that no longer exist on disk.
 *
 * Idempotent: unchanged files (same content_hash) are skipped entirely —
 * 0 DB writes, 0 embeddings on a no-change run.
 *
 * Config (all optional):
 *   memory_dir: auto        — resolve from project path (default)
 *   memory_dir: /abs/path   — explicit override (useful for testing)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getDatabase } from '../../core/db.js';
import { embed as _embed, embedBatch as _embedBatch } from '../../memory/embed-client.js';
import { embeddingToBuffer } from '../../memory/embeddings.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';
import yaml from 'js-yaml';

const log = createLogger('wiki-index');

// ── Injectable embed functions (overridable for testing) ──────

type EmbedFn = (text: string) => Promise<Float32Array>;
type EmbedBatchFn = (texts: string[]) => Promise<Float32Array[]>;

let _embedFn: EmbedFn = _embed;
let _embedBatchFn: EmbedBatchFn = _embedBatch;

/** Override embed functions for testing. Pass null to restore defaults. */
export function _setEmbedFnsForTesting(
  embedFn: EmbedFn | null,
  embedBatchFn: EmbedBatchFn | null,
): void {
  _embedFn = embedFn ?? _embed;
  _embedBatchFn = embedBatchFn ?? _embedBatch;
}

// ── Types ────────────────────────────────────────────────────

interface WikiIndexConfig {
  memory_dir?: string;  // 'auto' or absolute path
}

interface RunSummary {
  scanned: number;
  unchanged: number;
  upserted: number;
  archived: number;
  links_resolved: number;
  wikilinks_unresolved: number;
  embed_failures: number;
}

interface ArticleRow {
  id: number;
  slug: string;
  content_hash: string;
  source_path: string;
  status: string;
}

// ── Memory dir resolution ─────────────────────────────────────

/**
 * Resolve the memory directory from the active project path.
 * Claude Code mangles the path by replacing both / and _ with -.
 * Config `memory_dir` can override with an absolute path.
 */
export function resolveMemoryDir(config: WikiIndexConfig): string {
  const override = config.memory_dir;
  if (override && override !== 'auto') {
    return override;
  }

  const projectDir = process.cwd();
  // Match Claude Code's mangling: replace / and _ with -
  const mangled = projectDir.replace(/[/_]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', mangled, 'memory');
}

// ── Frontmatter parser ────────────────────────────────────────

interface ParsedArticle {
  slug: string;
  title: string;
  summary: string;
  body: string;
  category: string | null;
  tags: string[];
  sourcePath: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 * Handles both top-level name/description AND nested metadata patterns.
 * Malformed frontmatter → log + index body-only, never crash.
 */
export function parseArticle(filename: string, raw: string): ParsedArticle {
  const slug = filename.replace(/\.md$/, '');

  // Derive category from filename prefix before first '_'
  const underscoreIdx = filename.indexOf('_');
  const category = underscoreIdx > 0 ? filename.slice(0, underscoreIdx) : null;

  // Extract frontmatter block
  let title = slug;
  let summary = '';
  let tags: string[] = [];
  let body = raw;

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const fmRaw = fmMatch[1]!;
    body = fmMatch[2]!;

    try {
      const fm = yaml.load(fmRaw) as Record<string, unknown> | null;
      if (fm && typeof fm === 'object') {
        // Pattern 1: top-level name/description
        if (typeof fm['name'] === 'string') title = fm['name'];
        if (typeof fm['description'] === 'string') summary = fm['description'];

        // Pattern 2: nested metadata.name / metadata.description
        const meta = fm['metadata'];
        if (meta && typeof meta === 'object') {
          const m = meta as Record<string, unknown>;
          if (typeof m['name'] === 'string') title = m['name'];
          if (typeof m['description'] === 'string') summary = m['description'];
        }

        // Tags
        if (Array.isArray(fm['tags'])) {
          tags = (fm['tags'] as unknown[]).filter(t => typeof t === 'string') as string[];
        }
      }
    } catch (err) {
      log.warn(`wiki-index: malformed frontmatter in ${filename} — indexing body-only`, {
        error: String(err),
      });
      // Fallback to filename-derived title, empty summary
      title = slug;
      summary = '';
    }
  }

  // Fallback: if summary still empty, use first ~200 chars of body
  if (!summary) {
    summary = body.trim().slice(0, 200).replace(/\s+/g, ' ');
  }

  return { slug, title, summary, body, category, tags, sourcePath: filename };
}

// ── SHA256 helper ─────────────────────────────────────────────

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ── Wikilink resolver ─────────────────────────────────────────

const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/g;

export function extractWikilinks(body: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  WIKILINK_REGEX.lastIndex = 0;
  while ((match = WIKILINK_REGEX.exec(body)) !== null) {
    links.push(match[1]!.trim());
  }
  return links;
}

// ── Main task function ────────────────────────────────────────

export async function runWikiIndex(rawConfig: Record<string, unknown>): Promise<RunSummary> {
  const config: WikiIndexConfig = {
    memory_dir: (rawConfig['memory_dir'] as string) ?? 'auto',
  };

  const summary: RunSummary = {
    scanned: 0,
    unchanged: 0,
    upserted: 0,
    archived: 0,
    links_resolved: 0,
    wikilinks_unresolved: 0,
    embed_failures: 0,
  };

  // 1. Resolve memory dir
  const memoryDir = resolveMemoryDir(config);
  log.info('wiki-index: starting', { memoryDir });

  if (!fs.existsSync(memoryDir)) {
    log.warn('wiki-index: memory dir not found — skipping', { memoryDir });
    return summary;
  }

  const db = getDatabase();

  // 2. Glob *.md, skip MEMORY.md (per Q2 resolution)
  const allFiles = fs.readdirSync(memoryDir).filter(
    f => f.endsWith('.md') && f !== 'MEMORY.md',
  );
  summary.scanned = allFiles.length;

  log.info('wiki-index: found topic files', { count: allFiles.length });

  // 3. Build a set of source_path values for archive detection
  const diskFilesSet = new Set(allFiles);

  // 4. Load existing article rows for hash comparison
  const existingRows = db.prepare(
    'SELECT id, slug, content_hash, source_path, status FROM wiki_articles',
  ).all() as ArticleRow[];
  const existingBySource = new Map<string, ArticleRow>(existingRows.map(r => [r.source_path, r]));

  // 5. Identify changed/new files
  interface PendingFile {
    filename: string;
    raw: Buffer;
    hash: string;
  }

  const pendingFiles: PendingFile[] = [];
  for (const filename of allFiles) {
    const raw = fs.readFileSync(path.join(memoryDir, filename));
    const hash = sha256(raw);
    const existing = existingBySource.get(filename);
    if (existing && existing.content_hash === hash && existing.status !== 'archived') {
      summary.unchanged++;
    } else {
      pendingFiles.push({ filename, raw, hash });
    }
  }

  // 6. Generate embeddings for changed files (bulk on first run, per-file after)
  if (pendingFiles.length > 0) {
    // Parse articles first so we know what to embed
    const parsed = pendingFiles.map(pf => ({
      ...pf,
      article: parseArticle(pf.filename, pf.raw.toString('utf8')),
    }));

    // Build embed texts
    const embedTexts = parsed.map(
      p => `${p.article.title}\n${p.article.summary}\n${p.article.body}`,
    );

    let embeddings: Float32Array[];
    try {
      embeddings = await _embedBatchFn(embedTexts);
    } catch (err) {
      log.warn('wiki-index: embedBatch failed — falling back to per-file embed', { error: String(err) });
      // Fallback: embed one-by-one, skip failures
      embeddings = await Promise.all(
        embedTexts.map(async (text, i) => {
          try {
            return await _embedFn(text);
          } catch (e) {
            log.warn(`wiki-index: embed failed for ${parsed[i]!.filename}`, { error: String(e) });
            summary.embed_failures++;
            return null as unknown as Float32Array;
          }
        }),
      );
    }

    // 7. Upsert each article
    const upsertStmt = db.prepare(`
      INSERT INTO wiki_articles
        (slug, title, body, summary, status, category, tags, embedding,
         source_path, content_hash, origin_agent, updated_at, published_at)
      VALUES
        (@slug, @title, @body, @summary, 'published', @category, @tags, @embedding,
         @source_path, @content_hash, @origin_agent, datetime('now'), datetime('now'))
      ON CONFLICT(slug) DO UPDATE SET
        title        = excluded.title,
        body         = excluded.body,
        summary      = excluded.summary,
        status       = 'published',
        category     = excluded.category,
        tags         = excluded.tags,
        embedding    = excluded.embedding,
        source_path  = excluded.source_path,
        content_hash = excluded.content_hash,
        updated_at   = datetime('now')
    `);

    const originAgent = process.env['KITHKIT_AGENT_NAME'] ?? null;

    for (let i = 0; i < parsed.length; i++) {
      const { filename, hash, article } = parsed[i]!;
      const embedding = embeddings[i];

      try {
        const embeddingBuf = embedding ? embeddingToBuffer(embedding) : null;

        db.transaction(() => {
          const result = upsertStmt.run({
            slug: article.slug,
            title: article.title,
            body: article.body,
            summary: article.summary,
            category: article.category,
            tags: JSON.stringify(article.tags),
            embedding: embeddingBuf,
            source_path: filename,
            content_hash: hash,
            origin_agent: originAgent,
          });

          // Index embedding into wiki_vec if embedding succeeded
          if (embedding && result.changes > 0) {
            try {
              const articleId = db.prepare('SELECT id FROM wiki_articles WHERE slug = ?').get(article.slug) as { id: number } | undefined;
              if (articleId) {
                indexWikiEmbedding(db, articleId.id, embedding);
              }
            } catch (vecErr) {
              // Vector index failure is non-fatal
              log.warn(`wiki-index: wiki_vec indexing failed for ${filename}`, { error: String(vecErr) });
            }
          }
        })();

        summary.upserted++;
      } catch (err) {
        log.warn(`wiki-index: upsert failed for ${filename}`, { error: String(err) });
      }
    }
  }

  // 8. Resolve [[wikilinks]] after all upserts
  const allArticles = db.prepare(
    'SELECT id, slug, body FROM wiki_articles WHERE status != \'archived\'',
  ).all() as { id: number; slug: string; body: string }[];

  const slugToId = new Map<string, number>(allArticles.map(a => [a.slug, a.id]));

  // Only process articles that were changed (or all if it's a first run)
  const processedSlugs = new Set(pendingFiles.map(pf => pf.filename.replace(/\.md$/, '')));

  const deleteLinksStmt = db.prepare('DELETE FROM wiki_article_links WHERE from_id = ?');
  const insertLinkStmt = db.prepare(`
    INSERT OR IGNORE INTO wiki_article_links (from_id, to_id) VALUES (?, ?)
  `);

  for (const article of allArticles) {
    // Only rebuild edges for changed articles (skip unchanged to avoid unnecessary writes)
    if (!processedSlugs.has(article.slug) && pendingFiles.length < allArticles.length) {
      continue;
    }

    const wikilinks = extractWikilinks(article.body);
    if (wikilinks.length === 0) continue;

    // Rebuild outgoing edges for this article
    deleteLinksStmt.run(article.id);

    for (const targetSlug of wikilinks) {
      const targetId = slugToId.get(targetSlug);
      if (targetId === undefined) {
        log.warn(`wiki-index: unresolved wikilink [[${targetSlug}]] in ${article.slug}`);
        summary.wikilinks_unresolved++;
        continue;
      }
      try {
        insertLinkStmt.run(article.id, targetId);
        summary.links_resolved++;
      } catch (err) {
        log.warn(`wiki-index: failed to insert link ${article.slug} -> ${targetSlug}`, { error: String(err) });
      }
    }
  }

  // 9. Archive deleted sources
  for (const row of existingRows) {
    if (!diskFilesSet.has(row.source_path) && row.status !== 'archived') {
      db.prepare(
        'UPDATE wiki_articles SET status = \'archived\', updated_at = datetime(\'now\') WHERE id = ?',
      ).run(row.id);
      summary.archived++;
      log.info(`wiki-index: archived missing source: ${row.source_path}`);
    }
  }

  log.info('wiki-index: completed', { ...summary });
  return summary;
}

// ── Wiki vector helpers (called from wiki.ts after sqlite-vec is loaded) ──────

/**
 * Index an article embedding into wiki_vec.
 * Mirrors indexEmbedding() from memory/vector-search.ts.
 * Called from within wiki-index upsert transaction.
 */
export function indexWikiEmbedding(db: import('better-sqlite3').Database, articleId: number, embedding: Float32Array): void {
  const buf = embeddingToBuffer(embedding);

  // Remove old entry if exists
  const existing = db.prepare(
    'SELECT vec_rowid FROM vec_wiki_map WHERE article_id = ?',
  ).get(articleId) as { vec_rowid: number } | undefined;

  if (existing) {
    db.prepare('DELETE FROM wiki_vec WHERE rowid = ?').run(existing.vec_rowid);
    db.prepare('DELETE FROM vec_wiki_map WHERE article_id = ?').run(articleId);
  }

  // Insert into wiki_vec (auto-assigned rowid)
  const result = db.prepare('INSERT INTO wiki_vec (embedding) VALUES (?)').run(buf);
  const vecRowid = Number(result.lastInsertRowid);

  // Record the mapping
  db.prepare('INSERT INTO vec_wiki_map (article_id, vec_rowid) VALUES (?, ?)').run(articleId, vecRowid);
}

// ── Register ──────────────────────────────────────────────────

/**
 * Register the wiki-index task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('wiki-index', async (ctx) => {
    const summary = await runWikiIndex(ctx.config);
    return JSON.stringify(summary);
  });
}
