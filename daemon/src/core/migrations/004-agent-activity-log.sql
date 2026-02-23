-- Agent activity log for daemon-side observability.
-- Tracks lifecycle events (session start/end, task received/completed, errors, shutdowns).
-- Phase 1: daemon-side only. Phase 2 adds agent self-reporting.

CREATE TABLE agent_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  event_type TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_agent_activity_agent_id ON agent_activity_log(agent_id);
CREATE INDEX idx_agent_activity_session_id ON agent_activity_log(session_id);
CREATE INDEX idx_agent_activity_event_type ON agent_activity_log(event_type);
