-- API metrics: request logging and hourly aggregation tables.

CREATE TABLE IF NOT EXISTS api_request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms REAL NOT NULL,
  agent_id TEXT,
  error_fields TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_request_logs_timestamp ON api_request_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_path ON api_request_logs(path);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_agent_id ON api_request_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_api_request_logs_status_code ON api_request_logs(status_code);

CREATE TABLE IF NOT EXISTS api_metrics_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hour TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  total_requests INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_4xx INTEGER NOT NULL DEFAULT 0,
  error_5xx INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms REAL NOT NULL DEFAULT 0,
  p95_latency_ms REAL NOT NULL DEFAULT 0,
  agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_metrics_hourly_hour ON api_metrics_hourly(hour);
CREATE INDEX IF NOT EXISTS idx_api_metrics_hourly_endpoint ON api_metrics_hourly(endpoint);
CREATE INDEX IF NOT EXISTS idx_api_metrics_hourly_agent_id ON api_metrics_hourly(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_metrics_hourly_unique
  ON api_metrics_hourly(hour, endpoint, method, COALESCE(agent_id, ''));
