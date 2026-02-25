-- Task queue for orchestrator work management.
-- State machine: pending → assigned → in_progress → completed/failed
-- Activity log per task for progress tracking.

CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  assignee TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  timeout_seconds INTEGER,
  created_at TEXT NOT NULL,
  assigned_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orch_tasks_status ON orchestrator_tasks(status);
CREATE INDEX IF NOT EXISTS idx_orch_tasks_assignee ON orchestrator_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_orch_tasks_priority ON orchestrator_tasks(priority);
CREATE INDEX IF NOT EXISTS idx_orch_tasks_created_at ON orchestrator_tasks(created_at);

CREATE TABLE IF NOT EXISTS orchestrator_task_workers (
  task_id TEXT NOT NULL REFERENCES orchestrator_tasks(id),
  worker_id TEXT NOT NULL,
  role TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_id, worker_id)
);

CREATE TABLE IF NOT EXISTS orchestrator_task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES orchestrator_tasks(id),
  agent TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'note',
  stage TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orch_task_activity_task_id ON orchestrator_task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_orch_task_activity_type ON orchestrator_task_activity(type);
