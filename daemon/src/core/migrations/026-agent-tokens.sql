-- Agent token auth table.
-- Used by the /api/send role gate (fix: close worker channel bypass).
CREATE TABLE IF NOT EXISTS agent_tokens (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_role ON agent_tokens(role) WHERE revoked_at IS NULL;
