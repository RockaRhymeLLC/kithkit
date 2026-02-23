-- Add indexes for commonly queried columns.
-- Addresses full-table scans on messages, worker_jobs, todos, agents,
-- task_results, memories, todo_actions, and calendar.

-- Messages: routed by to_agent, filtered by processed_at
CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_messages_processed_at ON messages(processed_at);

-- Worker jobs: looked up by agent_id and filtered by status
CREATE INDEX IF NOT EXISTS idx_worker_jobs_agent_id ON worker_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_status ON worker_jobs(status);

-- Todos: filtered by status in context loader and API
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);

-- Agents: filtered by status and type in recovery and lifecycle
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);

-- Task results: looked up by task_name, ordered by created_at
CREATE INDEX IF NOT EXISTS idx_task_results_task_name ON task_results(task_name);
CREATE INDEX IF NOT EXISTS idx_task_results_started_at ON task_results(started_at);

-- Memories: filtered by category and ordered by created_at
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

-- Todo actions: looked up by todo_id for audit trail
CREATE INDEX IF NOT EXISTS idx_todo_actions_todo_id ON todo_actions(todo_id);

-- Calendar: filtered and ordered by start_time
CREATE INDEX IF NOT EXISTS idx_calendar_start_time ON calendar(start_time);
