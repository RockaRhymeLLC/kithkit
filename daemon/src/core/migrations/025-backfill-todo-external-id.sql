-- Migration 025: Backfill tasks.external_id for kind='todo' rows
--
-- PR #287 (migration 024) inserted todos into the unified `tasks` table but
-- intentionally left tasks.external_id NULL for kind='todo' rows (only
-- orchestrator tasks received their UUID as external_id).
--
-- This gap has two effects:
--   1. Data regression: BMO and R2 will have 0/N todo external_ids after
--      their next DB sync, just as Skippy did (manually backfilled locally).
--   2. Shim regression: /api/todos shim v2 resolves legacy :id via
--      external_id lookup; NULL external_id breaks all by-id lookups.
--
-- Fix: backfill external_id = CAST(todos.id AS TEXT) by joining on
-- (title, created_at) — a composite key unique enough across the legacy
-- 122-row todos dataset.
--
-- Idempotent guarantee:
--   WHERE external_id IS NULL ensures already-backfilled rows are skipped.
--   Re-applying this migration on Skippy's manually-backfilled DB is a no-op.
--   Fresh installs (empty todos table) → UPDATE affects 0 rows → no-op.
--
-- The original `todos` table was intentionally left in place by migration 024
-- as a rollback safety net.  We rely on it here for the backfill join.

UPDATE tasks
SET external_id = (
  SELECT CAST(t.id AS TEXT)
  FROM todos t
  WHERE t.title      = tasks.title
    AND t.created_at = tasks.created_at
  LIMIT 1
)
WHERE kind = 'todo'
  AND external_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM todos t
    WHERE t.title      = tasks.title
      AND t.created_at = tasks.created_at
  );
