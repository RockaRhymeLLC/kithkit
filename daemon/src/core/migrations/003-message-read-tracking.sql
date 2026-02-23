-- Add read_at column to messages for notification ping workflow.
-- Messages are "unread" until comms pulls them via GET /api/messages?unread=true,
-- which sets read_at. The message-delivery task repeats notification pings
-- every 60s until read_at is set.

ALTER TABLE messages ADD COLUMN read_at TEXT;
CREATE INDEX idx_messages_read_at ON messages(read_at);
