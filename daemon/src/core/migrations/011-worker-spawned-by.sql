-- Track which persistent agent spawned each worker job so the daemon
-- can notify the spawner when the worker completes or fails.
ALTER TABLE worker_jobs ADD COLUMN spawned_by TEXT;

-- Track spawner notification timestamps for worker completion callbacks.
ALTER TABLE worker_jobs ADD COLUMN spawner_notified_at TEXT;
