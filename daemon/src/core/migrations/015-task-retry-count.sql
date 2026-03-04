-- Add retry_count to orchestrator_tasks for tracking retry attempts.
ALTER TABLE orchestrator_tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
