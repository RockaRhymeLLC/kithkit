-- Track spawner notification timestamps for worker completion callbacks.
-- Note: spawned_by column already exists (added by earlier migration in dist/).
-- This migration only adds the notification tracking column.
ALTER TABLE worker_jobs ADD COLUMN spawner_notified_at TEXT;
