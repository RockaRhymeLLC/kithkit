-- Add acknowledged_at column to agents table.
-- Used by the comms-heartbeat task to track which completed/failed workers
-- have already been surfaced to the comms agent.
ALTER TABLE agents ADD COLUMN acknowledged_at TEXT;
