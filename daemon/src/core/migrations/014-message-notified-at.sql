-- Add notified_at to track when a message was first successfully delivered/injected.
-- Set on first successful injection. Prevents re-delivery.
ALTER TABLE messages ADD COLUMN notified_at TEXT;
CREATE INDEX idx_messages_notified_at ON messages(notified_at);
