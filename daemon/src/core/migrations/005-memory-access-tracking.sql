-- Add last_accessed column for memory access tracking
-- Used by smart session loading and curation task (stale memory detection)
ALTER TABLE memories ADD COLUMN last_accessed TEXT;

-- Index for finding stale memories (curation task queries this)
CREATE INDEX idx_memories_last_accessed ON memories(last_accessed);
