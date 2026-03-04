-- Add retry_count and support for cancelled status
ALTER TABLE orchestrator_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
