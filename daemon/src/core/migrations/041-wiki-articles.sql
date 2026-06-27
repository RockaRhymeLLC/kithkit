-- Agent wiki bridge (Phase 1): index the file-memory wiki into the DB.
-- File-memory is canonical; these tables are a derived, searchable index.
-- See docs/specs/20260626-agent-wiki-bridge.spec.md
--
-- Note: The wiki_vec sqlite-vec virtual table and vec_wiki_map mapping table
-- are created at runtime by initWikiVectorSearch() in api/wiki.ts, after the
-- sqlite-vec extension is loaded. This mirrors how vec_memories/vec_memory_map
-- are created at runtime in memory/vector-search.ts::initVectorSearch().

CREATE TABLE IF NOT EXISTS wiki_articles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,          -- derived from filename (strip .md)
  title         TEXT NOT NULL,                 -- frontmatter `name`
  body          TEXT NOT NULL,                 -- markdown after frontmatter
  summary       TEXT,                          -- frontmatter `description`
  status        TEXT DEFAULT 'published',      -- draft | published | archived
  category      TEXT,                          -- derived from filename prefix: feedback|project|peer
  tags          JSON DEFAULT '[]',
  embedding     BLOB,                          -- 384-dim float32, same as memories.embedding
  source_path   TEXT NOT NULL,                 -- relative path, e.g. feedback_ssh_access.md
  content_hash  TEXT NOT NULL,                 -- sha256 of raw file bytes; idempotency key
  origin_agent  TEXT,                          -- this box's fleet id (e.g. skippy)
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  published_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_wiki_articles_status   ON wiki_articles(status);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_category ON wiki_articles(category);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_hash     ON wiki_articles(content_hash);

-- Article <-> article edges, resolved from [[wikilinks]] in body.
CREATE TABLE IF NOT EXISTS wiki_article_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     INTEGER NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  to_id       INTEGER NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (from_id, to_id)
);

-- Article <-> DB-memory join (Phase 2 populates link_type beyond 'related').
CREATE TABLE IF NOT EXISTS wiki_memory_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES wiki_articles(id) ON DELETE CASCADE,
  memory_id   INTEGER NOT NULL REFERENCES memories(id)      ON DELETE CASCADE,
  link_type   TEXT DEFAULT 'related',  -- related | derived_from | contradicts | supersedes
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (article_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_wiki_mem_article ON wiki_memory_links(article_id);
CREATE INDEX IF NOT EXISTS idx_wiki_mem_memory  ON wiki_memory_links(memory_id);
