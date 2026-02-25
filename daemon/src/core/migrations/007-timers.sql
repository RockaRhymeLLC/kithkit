-- Persist timers so they survive daemon restarts.
CREATE TABLE IF NOT EXISTS timers (
  id           TEXT PRIMARY KEY,
  session      TEXT NOT NULL,
  message      TEXT NOT NULL,
  fires_at     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  fired_at     TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_timers_status ON timers (status);
