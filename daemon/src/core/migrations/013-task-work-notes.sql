-- Add work_notes field to orchestrator_tasks for freeform notes during task execution.
ALTER TABLE orchestrator_tasks ADD COLUMN work_notes TEXT;
