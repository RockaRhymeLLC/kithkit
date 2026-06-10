-- No-op placeholder kept to maintain version ordering.
-- NOTE: the original DDL for spawned_by/spawner_notified_at lived in a migration
-- that was removed from the sequence (NOT 005, which is memory-access-tracking).
-- Fresh installs therefore lacked these worker_jobs columns until migration
-- 037-worker-jobs-spawned-by-repair.sql, which adds them idempotently.
SELECT 1;
