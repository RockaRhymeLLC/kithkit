-- Kithkit v2 initial schema
-- All tables use IF NOT EXISTS for idempotent re-runs (handles stale DB edge case).

-- Agent registry (persistent agents + worker records)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  profile TEXT,
  status TEXT NOT NULL,
  tmux_session TEXT,
  pid INTEGER,
  started_at TEXT,
  last_activity TEXT,
  state JSON,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Worker job tracking
CREATE TABLE IF NOT EXISTS worker_jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  profile TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Memory entries with vector embeddings
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'fact',
  category TEXT,
  tags JSON DEFAULT '[]',
  source TEXT,
  embedding BLOB,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Todos
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
  due_date TEXT,
  tags JSON DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Todo action history (audit trail)
CREATE TABLE IF NOT EXISTS todo_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Calendar events
CREATE TABLE IF NOT EXISTS calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  all_day INTEGER DEFAULT 0,
  source TEXT,
  todo_ref INTEGER REFERENCES todos(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Inter-agent messages (audit log + pull queue)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  body TEXT NOT NULL,
  metadata JSON,
  processed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Runtime config overrides
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value JSON NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Per-feature flexible state
CREATE TABLE IF NOT EXISTS feature_state (
  feature TEXT PRIMARY KEY,
  state JSON NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Scheduled task execution history
CREATE TABLE IF NOT EXISTS task_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- Note: migrations table is bootstrapped by the migration runner (CREATE TABLE IF NOT EXISTS)
-- so it's not included here to avoid "table already exists" errors.
