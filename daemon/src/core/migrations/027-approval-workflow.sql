-- Approval workflow: outbound-send gate audit log and first-time-recipient tracking.
-- Implements approval-workflow.md Phase 2.

CREATE TABLE IF NOT EXISTS approval_decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id        TEXT NOT NULL,    -- UUID from the card
  decision           TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','timeout')),
  decider            TEXT NOT NULL,    -- 'human' | 'system'
  time_to_decide     REAL,             -- seconds from card creation to decision (null if timeout)
  content_hash       TEXT NOT NULL,    -- SHA-256 of original content (not the preview)
  recipient_set_hash TEXT NOT NULL,    -- SHA-256 of JSON-sorted canonical recipient list
  sender_agent       TEXT NOT NULL,    -- agent name
  channel            TEXT NOT NULL,    -- capability: 'mail', 'teams_chat', 'calendar', etc.
  policy             TEXT NOT NULL,    -- policy rule that triggered: 'all', 'first_time_recipient', etc.
  created_at         TEXT NOT NULL,    -- ISO8601 UTC: when the card was created
  decided_at         TEXT              -- ISO8601 UTC: when the decision was recorded (null until resolved)
);

CREATE INDEX IF NOT EXISTS idx_approval_decisions_approval_id ON approval_decisions(approval_id);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_channel     ON approval_decisions(channel);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_sender      ON approval_decisions(sender_agent);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_pending     ON approval_decisions(decided_at) WHERE decided_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_sent_recipients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT NOT NULL,      -- agent name ('bridget', 'bmo')
  recipient     TEXT NOT NULL,      -- canonical email address (lowercase, alias-resolved)
  first_sent_at TEXT NOT NULL,      -- ISO8601 UTC timestamp of first successful send
  UNIQUE(agent, recipient)          -- dedup-on-add: duplicate inserts are silently ignored
);

CREATE INDEX IF NOT EXISTS idx_agent_sent_recipients_agent ON agent_sent_recipients(agent);
