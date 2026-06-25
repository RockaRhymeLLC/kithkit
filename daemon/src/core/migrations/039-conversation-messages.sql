-- Migration 039: conversation_messages
-- Persists inbound and outbound channel messages at the channel seam so
-- structured conversation history is available for search and archival.
-- LOCAL-ONLY: rows in this table are NEVER synced to peers.

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  direction   TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  channel     TEXT NOT NULL,
  sender      TEXT,
  recipient   TEXT,
  text        TEXT NOT NULL,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  chat_id     TEXT,
  message_id  TEXT,
  metadata    JSON,
  sys_created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cm_ts ON conversation_messages(ts);
CREATE INDEX IF NOT EXISTS idx_cm_direction_ts ON conversation_messages(direction, ts);
CREATE INDEX IF NOT EXISTS idx_cm_channel ON conversation_messages(channel, direction);
CREATE INDEX IF NOT EXISTS idx_cm_chat_id ON conversation_messages(chat_id);

CREATE TABLE IF NOT EXISTS conversation_messages_archive (
  id          INTEGER PRIMARY KEY,
  direction   TEXT NOT NULL,
  channel     TEXT NOT NULL,
  sender      TEXT,
  recipient   TEXT,
  text        TEXT NOT NULL,
  ts          TEXT NOT NULL,
  chat_id     TEXT,
  message_id  TEXT,
  metadata    JSON,
  sys_created TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
