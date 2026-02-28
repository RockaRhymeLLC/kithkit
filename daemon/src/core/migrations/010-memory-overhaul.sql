-- Memory system overhaul (spec: /tmp/memory-overhaul-spec.md)
-- Phase 1: Add new columns + indexes (non-breaking, all nullable)

-- Importance scoring (1-5, default 3)
ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 3;

-- TTL support
ALTER TABLE memories ADD COLUMN expires_at TEXT;

-- Supersedes linking (audit trail for replaced memories)
ALTER TABLE memories ADD COLUMN supersedes INTEGER REFERENCES memories(id);

-- Indexes for new columns
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);

-- Phase 1 data migration: remap categories to new taxonomy
-- architecture → operational (most are infra facts, not decisions)
UPDATE memories SET category = 'operational' WHERE category = 'architecture';

-- infrastructure → operational
UPDATE memories SET category = 'operational' WHERE category = 'infrastructure';

-- bugfix → operational (reframed as current-state facts)
UPDATE memories SET category = 'operational' WHERE category = 'bugfix';

-- workflow → procedural
UPDATE memories SET category = 'procedural' WHERE category = 'workflow';

-- tool → operational
UPDATE memories SET category = 'operational' WHERE category = 'tool';

-- account → operational
UPDATE memories SET category = 'operational' WHERE category = 'account';

-- fact (as category) → core for identity/hard-rules, operational for everything else
-- Conservative: map to operational; truly core facts are few and can be hand-promoted
UPDATE memories SET category = 'operational' WHERE category = 'fact';

-- debugging → operational
UPDATE memories SET category = 'operational' WHERE category = 'debugging';

-- Set default importance based on category
UPDATE memories SET importance = 5 WHERE category = 'core';
UPDATE memories SET importance = 4 WHERE category = 'preference';
UPDATE memories SET importance = 4 WHERE category = 'person';
UPDATE memories SET importance = 3 WHERE category = 'operational';
UPDATE memories SET importance = 3 WHERE category = 'decision';
UPDATE memories SET importance = 3 WHERE category = 'procedural';
UPDATE memories SET importance = 1 WHERE category = 'episodic';

-- Set expires_at for episodic memories (created_at + 30 days)
UPDATE memories SET expires_at = datetime(created_at, '+30 days')
  WHERE category = 'episodic' AND expires_at IS NULL;

-- Phase 4 prep: Drop type column
-- SQLite doesn't support DROP COLUMN before 3.35.0, but macOS ships 3.39+
-- so this should work. The column is semantically empty (always 'fact').
ALTER TABLE memories DROP COLUMN type;
