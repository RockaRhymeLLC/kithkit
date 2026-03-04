-- Add notified_at to messages table for deliver-once notification tracking.
-- When a notification ping is injected into tmux, notified_at is set.
-- No re-pinging — each message is notified exactly once.

ALTER TABLE messages ADD COLUMN notified_at TEXT;
CREATE INDEX idx_messages_notified_at ON messages(notified_at);
