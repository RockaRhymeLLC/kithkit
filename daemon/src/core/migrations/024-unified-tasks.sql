-- Migration 024: Unified tasks table
--
-- Merges `todos` and `orchestrator_tasks` into a single `tasks` table with a
-- `kind` discriminator column ('todo' | 'orchestrator').  Supporting tables
-- (task_actions, task_workers, task_activity) are created as unified
-- replacements for todo_actions, orchestrator_task_workers, and
-- orchestrator_task_activity respectively.  Two new spec-v1.5 tables are also
-- created: task_deps and task_calibration.
--
-- Old tables (todos, orchestrator_tasks, todo_actions, orchestrator_task_workers,
-- orchestrator_task_activity) are LEFT IN PLACE for rollback safety.
--
-- calendar.todo_ref foreign references are patched to the new task IDs.

-- ============================================================
-- 1. CREATE TABLE tasks
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  -- identity
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id               TEXT UNIQUE,          -- NULL for todos; UUID from orchestrator_tasks
  kind                      TEXT NOT NULL CHECK(kind IN ('todo','orchestrator')),

  -- core fields
  title                     TEXT NOT NULL,
  description               TEXT,
  category                  TEXT,
  source                    TEXT,
  tags                      JSON NOT NULL DEFAULT '[]',

  -- hierarchy
  parent_id                 INTEGER REFERENCES tasks(id) ON DELETE SET NULL,

  -- assignment
  assigned_to               TEXT,

  -- priority & status
  priority                  TEXT NOT NULL DEFAULT 'medium'
                              CHECK(priority IN ('low','medium','high','urgent')),
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK(status IN (
                                'proposed','pending','assigned','planning',
                                'awaiting_approval','in_progress','blocked',
                                'completed','failed','abandoned','cancelled'
                              )),

  -- scheduling
  due_date                  TEXT,
  snooze_until              TEXT,

  -- planning workflow
  plan                      TEXT,
  plan_status               TEXT,
  plan_submitted_at         TEXT,
  plan_approved_at          TEXT,
  plan_rejected_reason      TEXT,

  -- execution results
  result                    TEXT,
  error                     TEXT,
  work_notes                TEXT,
  retry_count               INTEGER NOT NULL DEFAULT 0,
  timeout_seconds           INTEGER,

  -- outcome
  outcome                   TEXT,
  outcome_reason            TEXT,

  -- calibration / estimation
  estimated_minutes         INTEGER,
  actual_minutes            INTEGER,
  calibration_mult          REAL,               -- computed: actual / estimated; stored for query convenience

  -- recurrence
  schedule_cron             TEXT,
  schedule_interval_seconds INTEGER,
  next_fire_at              TIMESTAMP,
  is_recurring_parent       BOOLEAN NOT NULL DEFAULT 0,
  parent_recurring_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,

  -- risk / complexity (1-5 scale replacing S/M/L/XL)
  complexity                INTEGER CHECK(complexity IS NULL OR complexity BETWEEN 1 AND 5),
  risk                      INTEGER CHECK(risk IS NULL OR risk BETWEEN 1 AND 5),

  -- retry reason for last failure
  last_retry_reason         TEXT CHECK(
                              last_retry_reason IS NULL OR last_retry_reason IN (
                                'timeout','worker_error','cancelled','transient_failure',
                                'plan_rejected','peer_unreachable'
                              )
                            ),

  -- notification / subscription
  notify_policy             JSON,
  subscribed_agents         JSON NOT NULL DEFAULT '[]',

  -- linked context
  memory_ids                JSON NOT NULL DEFAULT '[]',
  linked_artifacts          JSON NOT NULL DEFAULT '[]',

  -- calibration & completion metadata (from orchestrator_tasks local-only columns)
  task_type                 TEXT,
  completion_status         TEXT,
  estimation_method         TEXT,
  workers_used              INTEGER,

  -- retro & cross-machine sync
  generate_retro            INTEGER DEFAULT NULL,
  canonical_task_external_id TEXT,

  -- comms lifecycle closure
  acknowledged_at           TEXT,
  comms_outcome             TEXT CHECK(comms_outcome IN ('corrected','redirected','accepted','cancelled')),
  comms_corrections         TEXT,
  requesting_peer           TEXT,

  -- timestamps
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at               TEXT,
  started_at                TEXT,
  completed_at              TEXT
);

-- ============================================================
-- 2. CREATE indexes on tasks
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_priority    ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id   ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at  ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_external_id ON tasks(external_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source      ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_kind        ON tasks(kind);

-- ============================================================
-- 3. INSERT todos → tasks (kind='todo')
--    'done' status mapped to 'completed' for unified status enum.
-- ============================================================

INSERT INTO tasks (
  kind, title, description,
  source, category, tags,
  assigned_to, priority, status,
  due_date, snooze_until,
  created_at, updated_at
)
SELECT
  'todo',
  title,
  description,
  NULL,                           -- source was a ghost column in todos, never persisted
  NULL,                           -- category: no equivalent in todos
  COALESCE(tags, '[]'),
  NULL,                           -- assigned_to: no equivalent in todos
  priority,
  CASE status WHEN 'done' THEN 'completed' ELSE status END,
  due_date,
  snooze_until,
  created_at,
  updated_at
FROM todos;

-- ============================================================
-- 4. TEMP mapping table: old todo.id → new tasks.id
--    Used to migrate todo_actions and patch calendar.todo_ref.
--    Matched on (title, created_at, kind) which is unique in practice.
-- ============================================================

CREATE TEMP TABLE _todo_id_map AS
SELECT t.id  AS old_id,
       tk.id AS new_id
FROM todos t
JOIN tasks tk
  ON  tk.title      = t.title
  AND tk.created_at = t.created_at
  AND tk.kind       = 'todo';

-- ============================================================
-- 5. CREATE TABLE task_actions
--    Unified replacement for todo_actions.
--    Adds optional `actor` column for agent attribution.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  note       TEXT,
  actor      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_actions_task_id ON task_actions(task_id);

-- ============================================================
-- 6. INSERT todo_actions → task_actions
-- ============================================================

INSERT INTO task_actions (task_id, action, old_value, new_value, note, created_at)
SELECT
  m.new_id,
  ta.action,
  ta.old_value,
  ta.new_value,
  ta.note,
  ta.created_at
FROM todo_actions ta
JOIN _todo_id_map m ON m.old_id = ta.todo_id;

-- ============================================================
-- 7. INSERT orchestrator_tasks → tasks (kind='orchestrator')
--
--    IMPORTANT: estimated_minutes, actual_minutes, task_type,
--    completion_status, estimation_method, workers_used are
--    LOCAL-ONLY columns that do NOT exist on upstream.  They are
--    populated with NULL literals here so the INSERT works
--    identically on both local and upstream environments.
--
--    priority (INTEGER 0-4) → priority (TEXT low/medium/high/urgent)
--    complexity (TEXT S/M/L/XL) → complexity (INTEGER 1-4)
--    outcome_notes → outcome_reason (column renamed in unified schema)
-- ============================================================

INSERT INTO tasks (
  external_id, kind,
  title, description,
  source, category, tags,
  assigned_to,
  priority,
  status,
  result, error, work_notes,
  retry_count, timeout_seconds,
  outcome, outcome_reason,
  plan, plan_status, plan_submitted_at, plan_approved_at, plan_rejected_reason,
  complexity,
  generate_retro,
  canonical_task_external_id,
  acknowledged_at, comms_outcome, comms_corrections,
  -- LOCAL-ONLY columns — must be NULL literals (columns absent on upstream)
  requesting_peer,
  estimated_minutes, actual_minutes,
  task_type, completion_status, estimation_method, workers_used,
  created_at, updated_at,
  assigned_at, started_at, completed_at
)
SELECT
  id,              -- UUID → external_id
  'orchestrator',
  title, description,
  COALESCE(source, 'orchestrator'),
  NULL,            -- category: no equivalent in orchestrator_tasks
  '[]',            -- tags: no equivalent in orchestrator_tasks
  assignee,        -- → assigned_to
  CASE
    WHEN priority = 1                THEN 'low'
    WHEN priority = 0 OR priority = 2 THEN 'medium'
    WHEN priority = 3                THEN 'high'
    WHEN priority >= 4               THEN 'urgent'
    ELSE                                  'medium'
  END,
  status,
  result, error, work_notes,
  COALESCE(retry_count, 0),
  timeout_seconds,
  outcome,
  outcome_notes,   -- renamed to outcome_reason in unified schema
  plan, plan_status, plan_submitted_at, plan_approved_at, plan_rejected_reason,
  CASE complexity
    WHEN 'S'  THEN 1
    WHEN 'M'  THEN 2
    WHEN 'L'  THEN 3
    WHEN 'XL' THEN 4
    ELSE NULL
  END,
  generate_retro,
  canonical_task_external_id,
  acknowledged_at, comms_outcome, comms_corrections,
  -- LOCAL-ONLY columns — must be NULL literals (columns absent on upstream)
  NULL,            -- requesting_peer
  NULL, NULL,      -- estimated_minutes, actual_minutes
  NULL, NULL, NULL, NULL,  -- task_type, completion_status, estimation_method, workers_used
  created_at, updated_at,
  assigned_at, started_at, completed_at
FROM orchestrator_tasks;

-- ============================================================
-- 8. CREATE TABLE task_workers
--    Unified replacement for orchestrator_task_workers.
--    task_id is INTEGER (tasks.id) instead of TEXT (UUID).
-- ============================================================

CREATE TABLE IF NOT EXISTS task_workers (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id   TEXT NOT NULL,
  role        TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, worker_id)
);

INSERT INTO task_workers (task_id, worker_id, role, assigned_at)
SELECT
  t.id,
  ow.worker_id,
  ow.role,
  ow.assigned_at
FROM orchestrator_task_workers ow
JOIN tasks t ON t.external_id = ow.task_id;

-- ============================================================
-- 9. CREATE TABLE task_activity
--    Unified replacement for orchestrator_task_activity.
--    task_id is INTEGER (tasks.id) instead of TEXT (UUID).
-- ============================================================

CREATE TABLE IF NOT EXISTS task_activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent      TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'note',
  stage      TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_activity_task_id ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_task_activity_type    ON task_activity(type);

INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
SELECT
  t.id,
  oa.agent,
  oa.type,
  oa.stage,
  oa.message,
  oa.created_at
FROM orchestrator_task_activity oa
JOIN tasks t ON t.external_id = oa.task_id;

-- ============================================================
-- 10. CREATE TABLE task_deps  (new — spec v1.5)
--     DAG dependency edges between tasks.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_deps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  edge_type    TEXT NOT NULL CHECK(edge_type IN ('blocks','relates_to')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_task_id, to_task_id, edge_type)
);

-- ============================================================
-- 11. CREATE TABLE task_calibration  (new — spec v1.5)
--     Rolling estimate-accuracy calibration per agent / category.
-- ============================================================

CREATE TABLE IF NOT EXISTS task_calibration (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name        TEXT NOT NULL,
  category          TEXT,
  window_started_at TEXT NOT NULL,
  sample_count      INTEGER NOT NULL,
  mean_ratio        REAL NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_name, category)
);

-- ============================================================
-- 12. PATCH calendar.todo_ref to point to new task IDs
-- ============================================================

UPDATE calendar
SET todo_ref = (
  SELECT new_id
  FROM _todo_id_map
  WHERE old_id = calendar.todo_ref
)
WHERE todo_ref IS NOT NULL;

-- ============================================================
-- 13. DROP temp mapping table
-- ============================================================

DROP TABLE _todo_id_map;

-- Old tables (todos, orchestrator_tasks, todo_actions,
-- orchestrator_task_activity, orchestrator_task_workers)
-- are intentionally NOT dropped here.  They remain as a
-- rollback safety net.  A future migration (025-drop-legacy-tables.sql)
-- will remove them once the new schema has been validated in production.
