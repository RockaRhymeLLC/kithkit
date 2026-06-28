/**
 * Agent-Wiki Bridge Phase 2 tests — memory ↔ article linking.
 *
 * Covers:
 *   P2-1  DEFAULT-OFF: no autolink config → zero wiki_memory_links rows
 *   P2-2  ENABLED + match: enabled=true, above-threshold, shared tag → one link, type='related'
 *   P2-3  THRESHOLD: article below similarity_threshold → NOT linked
 *   P2-4  SHARED-TAG gate: require_shared_tag=true, no shared tag/category → NOT linked
 *   P2-5  MAX_LINKS: multiple candidates, max_links=1 → exactly one linked (top score)
 *   P2-6  NON-FATAL: wiki vector unavailable → POST /api/memory/store still returns 201
 *   P2-7  EXPLICIT link route: POST /api/wiki/memory-links creates/upgrades links; 400 on bad type
 *   P2-8  REVERSE read: GET /api/wiki/articles?linked_memory_id=N returns linked articles + link_type
 *
 * Mutation-killing assertions: all tests assert EXACT counts, link_type values, and
 * presence/absence — not just "does not throw".
 *
 * Testing strategy for P2-1..P2-5 (auto-link unit tests):
 *   - DB is initialized with full migrations (wiki tables exist)
 *   - Wiki articles are seeded directly into wiki_articles table
 *   - Vector search results are injected via _setWikiVecSearchFnForTesting (no sqlite-vec needed)
 *   - Autolink config is injected via _setWikiAutolinkConfigForTesting
 *   - autoLinkMemoryToWiki() is called directly (not via HTTP)
 *   - wiki_memory_links table state is checked directly
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, _resetDbForTesting, getDatabase } from '../../core/db.js';
import {
  handleWikiRoute,
  _resetWikiVectorForTesting,
  _setWikiAutolinkConfigForTesting,
  _setWikiVecSearchFnForTesting,
  _resetWikiPhase2ForTesting,
  autoLinkMemoryToWiki,
  type WikiVecCandidate,
} from '../wiki.js';
import { handleMemoryRoute, _resetVectorForTesting } from '../memory.js';
import { _resetConfigForTesting } from '../../core/config.js';

// ── Constants ─────────────────────────────────────────────────

const FAKE_DIM = 384;
const TEST_PORT_P2 = 19913;  // Different from wiki.test.ts (19912) to avoid conflicts

// ── HTTP test helper ──────────────────────────────────────────

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT_P2,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ── Server setup (wiki + memory routes) ──────────────────────

let server: http.Server;
let tmpDir: string;

function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-wiki-p2-test-'));

  _resetDbForTesting();
  _resetWikiVectorForTesting();
  _resetVectorForTesting();
  _resetConfigForTesting();
  _resetWikiPhase2ForTesting();

  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  server = http.createServer((inReq, res) => {
    const url = new URL(inReq.url ?? '/', `http://localhost:${TEST_PORT_P2}`);
    res.setHeader('X-Timestamp', new Date().toISOString());

    // Route to wiki handler first, then memory handler
    handleWikiRoute(inReq, res, url.pathname)
      .then((handled) => {
        if (handled) return;
        return handleMemoryRoute(inReq, res, url.pathname);
      })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
  });

  return new Promise<void>((resolve) => {
    server.listen(TEST_PORT_P2, '127.0.0.1', resolve);
  });
}

function teardown(): Promise<void> {
  _resetWikiPhase2ForTesting();
  _resetWikiVectorForTesting();
  _resetVectorForTesting();
  _resetConfigForTesting();
  return new Promise<void>((resolve) => {
    _resetDbForTesting();
    if (server?.listening) {
      server.close(() => {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    } else {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    }
  });
}

// ── DB helpers ────────────────────────────────────────────────

/** Seed a wiki article directly in the DB and return its id. */
function seedArticle(opts: {
  slug: string;
  title: string;
  tags?: string[];
  category?: string | null;
  status?: string;
}): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO wiki_articles (slug, title, body, summary, status, category, tags,
                               source_path, content_hash, origin_agent)
    VALUES (?, ?, 'body text', 'summary text', ?, ?, ?, ?, ?, NULL)
  `).run(
    opts.slug,
    opts.title,
    opts.status ?? 'published',
    opts.category ?? null,
    JSON.stringify(opts.tags ?? []),
    `${opts.slug}.md`,
    `hash-${opts.slug}`,
  );
  return Number(result.lastInsertRowid);
}

/** Seed a memory directly in the DB and return its id. */
function seedMemory(opts: { content: string; tags?: string[]; category?: string | null }): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO memories (content, tags, category)
    VALUES (?, ?, ?)
  `).run(
    opts.content,
    JSON.stringify(opts.tags ?? []),
    opts.category ?? null,
  );
  return Number(result.lastInsertRowid);
}

/** Count rows in wiki_memory_links. */
function countLinks(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as n FROM wiki_memory_links').get() as { n: number };
  return row.n;
}

/** Get a specific link row. */
function getLink(articleId: number, memoryId: number): { link_type: string } | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT link_type FROM wiki_memory_links WHERE article_id = ? AND memory_id = ?',
  ).get(articleId, memoryId) as { link_type: string } | undefined;
}

/** Make a fake embedding (unit vector). */
function fakeEmbedding(): Float32Array {
  const e = new Float32Array(FAKE_DIM).fill(1 / Math.sqrt(FAKE_DIM));
  return e;
}

// ── P2-1: DEFAULT-OFF ─────────────────────────────────────────

describe('P2-1: auto-link DEFAULT-OFF (no config)', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('stores memory similar to a wiki article but creates ZERO wiki_memory_links (default off)', async () => {
    const articleId = seedArticle({ slug: 'feedback_ssh', title: 'SSH Access', tags: ['ssh'] });
    const memoryId = seedMemory({ content: 'SSH access setup', tags: ['ssh'], category: 'feedback' });

    // NO autolink config override → feature is disabled by default
    // Set a mock search that WOULD return the article if the feature were enabled
    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.95, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 0, 'Default-off: ZERO links should be created without explicit config');
  });

  it('POST /api/memory/store returns 201 with no autolink config (default off, non-fatal)', async () => {
    const res = await request('POST', '/api/memory/store', {
      content: 'Test memory for default-off check',
      category: 'technical',
      tags: ['ssh'],
    });
    assert.equal(res.status, 201, 'Memory store must succeed (201) even with wiki not configured');
    const body = JSON.parse(res.body);
    assert.ok(body.id, 'Response must include the new memory id');

    // No links should be created
    assert.equal(countLinks(), 0, 'No auto-links created in default-off mode');
  });
});

// ── P2-2: ENABLED + match ─────────────────────────────────────

describe('P2-2: auto-link ENABLED + match → exactly one link', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates EXACTLY ONE wiki_memory_link with link_type="related" when enabled, above threshold, shared tag', async () => {
    const articleId = seedArticle({
      slug: 'feedback_ssh',
      title: 'SSH Access',
      tags: ['ssh', 'access'],
      category: 'feedback',
    });
    const memoryId = seedMemory({ content: 'SSH access setup', tags: ['ssh'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: true,
    });

    // Mock returns the article above threshold
    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.90, tags: '["ssh","access"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 1, 'Exactly ONE link should be created');
    const link = getLink(articleId, memoryId);
    assert.ok(link, 'Link must exist');
    assert.equal(link!.link_type, 'related', 'Auto-link type must be "related"');
  });
});

// ── P2-3: THRESHOLD ───────────────────────────────────────────

describe('P2-3: threshold gate', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('does NOT link an article below similarity_threshold', async () => {
    const articleId = seedArticle({
      slug: 'feedback_unrelated',
      title: 'Unrelated Topic',
      tags: ['ssh'],
      category: 'feedback',
    });
    const memoryId = seedMemory({ content: 'SSH access', tags: ['ssh'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false, // disable shared-tag gate to isolate threshold test
    });

    // Score is BELOW threshold (0.70 < 0.75)
    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.70, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 0, 'Below-threshold article must NOT be linked');
  });

  it('links an article AT or ABOVE the threshold', async () => {
    const articleId = seedArticle({
      slug: 'feedback_exact_threshold',
      title: 'Exact Threshold',
      tags: ['ssh'],
      category: 'feedback',
    });
    const memoryId = seedMemory({ content: 'SSH access', tags: ['ssh'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false,
    });

    // Score is EXACTLY at threshold
    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.75, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 1, 'Article at exact threshold SHOULD be linked');
  });
});

// ── P2-4: SHARED-TAG gate ─────────────────────────────────────

describe('P2-4: require_shared_tag gate', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('does NOT link when require_shared_tag=true and no shared tag/category', async () => {
    const articleId = seedArticle({
      slug: 'feedback_ssh',
      title: 'SSH Access',
      tags: ['ssh', 'networking'],
      category: 'feedback',
    });
    // Memory has completely different tags and different category
    const memoryId = seedMemory({ content: 'Unrelated topic', tags: ['docker'], category: 'technical' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 5,
      require_shared_tag: true,
    });

    // Score is above threshold but tags/category don't match
    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.90, tags: '["ssh","networking"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['docker'], 'technical');

    assert.equal(countLinks(), 0, 'No shared tag/category → must NOT link (require_shared_tag=true)');
  });

  it('links when require_shared_tag=true and CATEGORY matches (even without shared tags)', async () => {
    const articleId = seedArticle({
      slug: 'feedback_catmatch',
      title: 'Category Match Article',
      tags: ['advanced-topic'],
      category: 'feedback',
    });
    // Memory: different tags but same category
    const memoryId = seedMemory({ content: 'Some feedback topic', tags: ['beginner'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: true,
    });

    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.85, tags: '["advanced-topic"]', category: 'feedback' },
    ]);

    // tags don't match but category='feedback' matches on both sides
    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['beginner'], 'feedback');

    assert.equal(countLinks(), 1, 'Category match should satisfy require_shared_tag gate');
  });

  it('links when require_shared_tag=false regardless of tag overlap', async () => {
    const articleId = seedArticle({
      slug: 'feedback_notag',
      title: 'No Tag Match',
      tags: ['ssh'],
      category: 'feedback',
    });
    const memoryId = seedMemory({ content: 'Unrelated', tags: ['docker'], category: 'technical' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false,  // gate disabled
    });

    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.90, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['docker'], 'technical');

    assert.equal(countLinks(), 1, 'require_shared_tag=false should link regardless of tag mismatch');
  });
});

// ── P2-5: MAX_LINKS ───────────────────────────────────────────

describe('P2-5: max_links cap', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('links exactly max_links=1 article (top-scoring) when multiple candidates qualify', async () => {
    const id1 = seedArticle({ slug: 'feedback_top', title: 'Top Article', tags: ['ssh'], category: 'feedback' });
    const id2 = seedArticle({ slug: 'feedback_second', title: 'Second Article', tags: ['ssh'], category: 'feedback' });
    const id3 = seedArticle({ slug: 'feedback_third', title: 'Third Article', tags: ['ssh'], category: 'feedback' });

    const memoryId = seedMemory({ content: 'SSH topic', tags: ['ssh'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false,
    });

    // Return 3 candidates, all above threshold; first has highest score
    _setWikiVecSearchFnForTesting(async (): Promise<WikiVecCandidate[]> => [
      { article_id: id1, score: 0.95, tags: '["ssh"]', category: 'feedback' },
      { article_id: id2, score: 0.88, tags: '["ssh"]', category: 'feedback' },
      { article_id: id3, score: 0.80, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 1, 'max_links=1 → exactly ONE link created');
    // The top-scoring article (id1) should be the one linked
    const topLink = getLink(id1, memoryId);
    assert.ok(topLink, 'Top-scoring article (id1) must be the one linked');
    // The lower-scoring ones must NOT be linked
    assert.equal(getLink(id2, memoryId), undefined, 'Second article must NOT be linked');
    assert.equal(getLink(id3, memoryId), undefined, 'Third article must NOT be linked');
  });

  it('links up to max_links=2 when 2+ candidates qualify', async () => {
    const id1 = seedArticle({ slug: 'feedback_a2', title: 'A2', tags: ['ssh'], category: 'feedback' });
    const id2 = seedArticle({ slug: 'feedback_b2', title: 'B2', tags: ['ssh'], category: 'feedback' });
    const id3 = seedArticle({ slug: 'feedback_c2', title: 'C2', tags: ['ssh'], category: 'feedback' });

    const memoryId = seedMemory({ content: 'SSH topic', tags: ['ssh'], category: 'feedback' });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 2,
      require_shared_tag: false,
    });

    _setWikiVecSearchFnForTesting(async (): Promise<WikiVecCandidate[]> => [
      { article_id: id1, score: 0.95, tags: '["ssh"]', category: 'feedback' },
      { article_id: id2, score: 0.88, tags: '["ssh"]', category: 'feedback' },
      { article_id: id3, score: 0.80, tags: '["ssh"]', category: 'feedback' },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], 'feedback');

    assert.equal(countLinks(), 2, 'max_links=2 → exactly TWO links created');
    assert.ok(getLink(id1, memoryId), 'id1 must be linked');
    assert.ok(getLink(id2, memoryId), 'id2 must be linked');
    assert.equal(getLink(id3, memoryId), undefined, 'id3 must NOT be linked');
  });

  it('INSERT OR IGNORE prevents duplicates on second call (idempotent)', async () => {
    const articleId = seedArticle({ slug: 'feedback_idem', title: 'Idempotent', tags: ['ssh'] });
    const memoryId = seedMemory({ content: 'SSH content', tags: ['ssh'] });

    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false,
    });

    _setWikiVecSearchFnForTesting(async () => [
      { article_id: articleId, score: 0.90, tags: '["ssh"]', category: null },
    ]);

    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], null);
    await autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], null);

    assert.equal(countLinks(), 1, 'Duplicate call must not create a second link row (INSERT OR IGNORE)');
  });
});

// ── P2-6: NON-FATAL ───────────────────────────────────────────

describe('P2-6: non-fatal — wiki vec unavailable', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('POST /api/memory/store returns 201 when wiki vector search is unavailable', async () => {
    // Ensure wiki vec is NOT enabled (default: _wikiVecLoaded=false after _resetWikiVectorForTesting)
    // No autolink config override — feature is disabled by default
    // No mock vector search — any attempt would do nothing

    const res = await request('POST', '/api/memory/store', {
      content: 'Memory stored when wiki unavailable',
      category: 'technical',
      tags: ['ssh'],
    });

    assert.equal(res.status, 201, 'Memory store must succeed (201) when wiki vector is unavailable');
    const body = JSON.parse(res.body);
    assert.ok(body.id, 'Response must include the memory id');
    assert.ok(body.content, 'Response must include the content');

    // No links created (feature disabled)
    assert.equal(countLinks(), 0, 'No auto-links when wiki vector unavailable');
  });

  it('autoLinkMemoryToWiki is non-fatal when wiki vector unavailable (enabled config, no vec)', async () => {
    const articleId = seedArticle({ slug: 'feedback_novec', title: 'No Vec', tags: ['ssh'] });
    const memoryId = seedMemory({ content: 'SSH stuff', tags: ['ssh'] });

    // Enable config, but NO mock (and wiki vec not loaded → _wikiVecLoaded=false)
    _setWikiAutolinkConfigForTesting({
      enabled: true,
      similarity_threshold: 0.75,
      max_links: 1,
      require_shared_tag: false,
    });
    // _wikiVecSearchOverride is null and _wikiVecLoaded is false → returns early

    // Must NOT throw
    await assert.doesNotReject(
      () => autoLinkMemoryToWiki(memoryId, fakeEmbedding(), ['ssh'], null),
      'autoLinkMemoryToWiki must not throw when wiki vec unavailable',
    );

    assert.equal(countLinks(), 0, 'No links when wiki vec unavailable (early return)');
    // Verify the article was not affected
    const db = getDatabase();
    const article = db.prepare('SELECT id FROM wiki_articles WHERE id = ?').get(articleId);
    assert.ok(article, 'Article must still exist');
  });
});

// ── P2-7: EXPLICIT link route ─────────────────────────────────

describe('P2-7: POST /api/wiki/memory-links — explicit consolidation links', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('creates a link with the specified link_type', async () => {
    const articleId = seedArticle({ slug: 'feedback_explicit', title: 'Explicit Link Test', tags: ['ssh'] });
    const memoryId = seedMemory({ content: 'SSH setup', tags: ['ssh'] });

    const res = await request('POST', '/api/wiki/memory-links', {
      article_id: articleId,
      memory_id: memoryId,
      link_type: 'derived_from',
    });

    assert.equal(res.status, 201, 'Explicit link creation must return 201');
    const body = JSON.parse(res.body);
    assert.ok(body.data, 'Response must include data');
    assert.equal(body.data.article_id, articleId, 'article_id must match');
    assert.equal(body.data.memory_id, memoryId, 'memory_id must match');
    assert.equal(body.data.link_type, 'derived_from', 'link_type must be derived_from');

    // Verify in DB
    assert.equal(countLinks(), 1, 'Exactly one link in DB');
    const link = getLink(articleId, memoryId);
    assert.equal(link?.link_type, 'derived_from');
  });

  it('returns 400 for an invalid link_type', async () => {
    const articleId = seedArticle({ slug: 'feedback_badtype', title: 'Bad Type', tags: [] });
    const memoryId = seedMemory({ content: 'Content', tags: [] });

    const res = await request('POST', '/api/wiki/memory-links', {
      article_id: articleId,
      memory_id: memoryId,
      link_type: 'invalid_type',
    });

    assert.equal(res.status, 400, 'Invalid link_type must return 400');
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'Error message must be present');
    assert.ok(body.error.includes('link_type'), 'Error must mention link_type');

    // No links should be in DB
    assert.equal(countLinks(), 0, 'Invalid type must NOT create any link');
  });

  it('re-POSTing with a new type UPGRADES the existing row (no duplicate)', async () => {
    const articleId = seedArticle({ slug: 'feedback_upgrade', title: 'Upgrade Test', tags: [] });
    const memoryId = seedMemory({ content: 'Content', tags: [] });

    // First create with 'related'
    await request('POST', '/api/wiki/memory-links', {
      article_id: articleId, memory_id: memoryId, link_type: 'related',
    });

    assert.equal(countLinks(), 1, 'First insert: one link');
    assert.equal(getLink(articleId, memoryId)?.link_type, 'related');

    // Upgrade to 'derived_from'
    const res2 = await request('POST', '/api/wiki/memory-links', {
      article_id: articleId, memory_id: memoryId, link_type: 'derived_from',
    });

    assert.equal(res2.status, 201, 'Upgrade must also return 201');
    assert.equal(countLinks(), 1, 'Still exactly one link (no duplicate)');
    assert.equal(getLink(articleId, memoryId)?.link_type, 'derived_from', 'Type must be upgraded');
  });

  it('returns 400 for missing article_id', async () => {
    const res = await request('POST', '/api/wiki/memory-links', {
      memory_id: 1, link_type: 'related',
    });
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('article_id'));
  });

  it('returns 400 for missing memory_id', async () => {
    const res = await request('POST', '/api/wiki/memory-links', {
      article_id: 1, link_type: 'related',
    });
    assert.equal(res.status, 400);
    assert.ok(JSON.parse(res.body).error.includes('memory_id'));
  });

  it('accepts all valid link_type values', async () => {
    const validTypes = ['related', 'derived_from', 'contradicts', 'supersedes'];
    for (const linkType of validTypes) {
      const articleId = seedArticle({ slug: `feedback_lt_${linkType}`, title: `LT ${linkType}`, tags: [] });
      const memId = seedMemory({ content: `Content for ${linkType}`, tags: [] });

      const res = await request('POST', '/api/wiki/memory-links', {
        article_id: articleId, memory_id: memId, link_type: linkType,
      });

      assert.equal(res.status, 201, `link_type="${linkType}" must be accepted (201)`);
      assert.equal(
        getLink(articleId, memId)?.link_type,
        linkType,
        `DB must store link_type="${linkType}"`,
      );
    }
  });
});

// ── P2-8: REVERSE read ────────────────────────────────────────

describe('P2-8: GET /api/wiki/articles?linked_memory_id=N — reverse read', { concurrency: 1 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns the articles linked to a given memory including link_type', async () => {
    const articleId = seedArticle({ slug: 'feedback_reverse', title: 'Reverse Read Test', tags: ['ssh'] });
    const memoryId = seedMemory({ content: 'SSH setup', tags: ['ssh'] });

    // Create link directly in DB
    const db = getDatabase();
    db.prepare(
      'INSERT INTO wiki_memory_links (article_id, memory_id, link_type) VALUES (?, ?, ?)',
    ).run(articleId, memoryId, 'derived_from');

    const res = await request('GET', `/api/wiki/articles?linked_memory_id=${memoryId}`);

    assert.equal(res.status, 200, 'Must return 200');
    const body = JSON.parse(res.body);
    assert.ok(body.data, 'Response must have data array');
    assert.equal(body.data.length, 1, 'Must return exactly one linked article');
    assert.equal(body.data[0].slug, 'feedback_reverse', 'Correct article slug');
    assert.equal(body.data[0].link_type, 'derived_from', 'link_type must be included in response');
    assert.ok(body.timestamp, 'Response must include timestamp');
  });

  it('returns multiple articles linked to the same memory', async () => {
    const id1 = seedArticle({ slug: 'feedback_rev1', title: 'Rev 1', tags: [] });
    const id2 = seedArticle({ slug: 'feedback_rev2', title: 'Rev 2', tags: [] });
    const memoryId = seedMemory({ content: 'Multi-link memory', tags: [] });

    const db = getDatabase();
    db.prepare('INSERT INTO wiki_memory_links (article_id, memory_id, link_type) VALUES (?, ?, ?)').run(id1, memoryId, 'related');
    db.prepare('INSERT INTO wiki_memory_links (article_id, memory_id, link_type) VALUES (?, ?, ?)').run(id2, memoryId, 'contradicts');

    const res = await request('GET', `/api/wiki/articles?linked_memory_id=${memoryId}`);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.data.length, 2, 'Must return both linked articles');
    const slugs = body.data.map((a: { slug: string }) => a.slug).sort();
    assert.deepEqual(slugs, ['feedback_rev1', 'feedback_rev2']);
  });

  it('returns empty array for a memory with no links', async () => {
    const memoryId = seedMemory({ content: 'Unlinked memory', tags: [] });

    const res = await request('GET', `/api/wiki/articles?linked_memory_id=${memoryId}`);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.data, [], 'No links → empty array');
  });

  it('returns 400 for an invalid linked_memory_id', async () => {
    const res = await request('GET', '/api/wiki/articles?linked_memory_id=not-a-number');
    assert.equal(res.status, 400, 'Non-integer linked_memory_id must return 400');
  });

  it('linked_memory_id does not interfere with slug lookup (orthogonal params)', async () => {
    const articleId = seedArticle({ slug: 'feedback_ortho', title: 'Ortho Test', tags: [] });
    const memoryId = seedMemory({ content: 'Ortho memory', tags: [] });

    const db = getDatabase();
    db.prepare('INSERT INTO wiki_memory_links (article_id, memory_id, link_type) VALUES (?, ?, ?)').run(articleId, memoryId, 'related');

    // slug lookup still works independently
    const slugRes = await request('GET', '/api/wiki/articles?slug=feedback_ortho');
    assert.equal(slugRes.status, 200, 'Slug lookup must still work');
    const slugBody = JSON.parse(slugRes.body);
    assert.equal(slugBody.data.slug, 'feedback_ortho');

    // reverse lookup also works
    const reverseRes = await request('GET', `/api/wiki/articles?linked_memory_id=${memoryId}`);
    assert.equal(reverseRes.status, 200, 'Reverse lookup must work');
    const reverseBody = JSON.parse(reverseRes.body);
    assert.equal(reverseBody.data.length, 1);
  });
});
