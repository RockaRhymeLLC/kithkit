-- Track spawner notification timestamps for worker completion callbacks.
-- Uses a safe column-add pattern: check PRAGMA table_info first to avoid
-- errors on fresh installs vs upgrades where the column may already exist.
--
-- IMPORTANT: This migration is executed by the JS migration runner which
-- wraps it in a transaction. The runner checks for column existence before
-- issuing ALTER TABLE statements prefixed with "--safe-alter:".

--safe-alter: worker_jobs ADD COLUMN spawned_by TEXT;
--safe-alter: worker_jobs ADD COLUMN spawner_notified_at TEXT;
