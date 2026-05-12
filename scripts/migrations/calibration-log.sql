-- Calibration log table — captures estimated vs actual time per orch task so
-- BMO can build a data-driven sense of how badly it overestimates. todo #488.
--
-- This is a standalone migration run via sqlite3 against the active daemon DB
-- (typically ~/Library/Application Support/kithkit/kithkit.db). It is NOT
-- registered in the daemon's Node migration runner — that would require a
-- daemon code change + restart. Apply with:
--   sqlite3 "$DB_PATH" < scripts/migrations/calibration-log.sql

CREATE TABLE IF NOT EXISTS orch_task_calibrations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  orch_task_id        TEXT,                       -- nullable (back-fill of pre-system data)
  escalated_at        TEXT,                       -- ISO-8601
  estimated_minutes   INTEGER,                    -- parsed from description, NULL if unparseable
  actual_minutes      INTEGER,                    -- computed from started_at -> finished_at
  task_type           TEXT NOT NULL DEFAULT 'other',  -- research / coding / data / report / docs / framework / other
  complexity          TEXT NOT NULL DEFAULT 'M',  -- S / M / L / XL
  workers_used        INTEGER NOT NULL DEFAULT 0,
  completion_status   TEXT,                       -- completed / failed / partial / cancelled
  estimation_method   TEXT NOT NULL DEFAULT 'gut',-- gut / scoping / comparable / none
  estimate_multiplier REAL,                       -- actual_minutes / estimated_minutes if both present
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calib_task_id     ON orch_task_calibrations(orch_task_id);
CREATE INDEX IF NOT EXISTS idx_calib_task_type   ON orch_task_calibrations(task_type);
CREATE INDEX IF NOT EXISTS idx_calib_complexity  ON orch_task_calibrations(complexity);
CREATE INDEX IF NOT EXISTS idx_calib_escalated   ON orch_task_calibrations(escalated_at);
