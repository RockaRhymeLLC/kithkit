# Memory Management System — Design Document

## Overview

Replace the flat-file MEMORY.md approach with a proper memory lifecycle:
**Extract → Deduplicate → Store → Curate → Load → Track access**

All memories live in SQLite via the daemon API. Both comms and orchestrator sessions participate.

---

## 1. Haiku Extraction Hook (Stop Hook)

**What exists**: `memory-extraction.sh` already fires on Stop, spawns a Haiku session to extract memories from the transcript, and posts to `POST /api/memory/store`.

**What changes**:

### 1a. Vector dedup at extraction time
The extraction hook prompt already tells Haiku to check an inventory of existing memories. But this is keyword-based (subject matching). We add **vector dedup**: before storing each memory, the extraction agent does a vector similarity search. If any existing memory scores ≥ 0.85, skip the insert.

Implementation: Add a `POST /api/memory/store-if-unique` endpoint that:
1. Generates embedding for the incoming content
2. Runs vector search with limit=1
3. If top result similarity ≥ 0.85, returns `409 Conflict` with the duplicate
4. Otherwise, stores normally (same as `POST /api/memory/store`)

The extraction hook prompt is updated to use this endpoint instead of `/api/memory/store`.

### 1b. Both agents
The hook fires for **any** Claude session in this project directory. The existing gate in `memory-extraction.sh` checks `stop_hook_active` to prevent loops but doesn't filter by session type. This is correct — both comms and orchestrator generate useful context.

**No change needed** — the hook already works for both.

### 1c. Source tracking
Add `source` field to extracted memories:
- Comms session → `source: "comms-extraction"`
- Orchestrator session → `source: "orchestrator-extraction"`

The extraction hook detects session type via `$TMUX` env var / session name and passes it to the Haiku prompt.

---

## 2. Sonnet Curation Task (Nightly Scheduler)

**What exists**: `memory-consolidation` is in config (cron `0 5 * * *`) but has only a stub handler.

**What it should do**:

### 2a. Merge candidates (vector similarity > 0.85)
Query all memory pairs with high similarity. For each cluster:
- Merge into a single, well-written memory
- Delete the duplicates
- Preserve the earliest `created_at`

### 2b. Stale memory review
Find memories where `last_accessed` is NULL or older than 30 days AND `created_at` is older than 30 days.
- Episodic memories → auto-archive (mark type as `archived` or delete)
- Fact/procedural → flag for review, don't auto-delete

### 2c. Category-based review
Group by category, look for:
- Contradictions (two memories in same category saying opposite things)
- Outdated information (dates in content that have passed)

### 2d. Implementation
The `memory-consolidation` task handler:
1. Queries all memories with embeddings
2. Computes pairwise similarity for memories in same category (optimization: only compare within categories)
3. Clusters memories with similarity > 0.85
4. For each cluster with 2+ members, spawns a **sonnet** worker with a merge prompt
5. Worker returns the merged content; handler stores the merge and deletes originals
6. Logs results to `task_results`

**Cost control**: Limit to 20 merge operations per run. Skip if < 5 memories total.

---

## 3. Access Tracking

**Schema change**: Add `last_accessed` column to `memories` table.

```sql
-- Migration 005
ALTER TABLE memories ADD COLUMN last_accessed TEXT;
```

**When to update**:
- `GET /api/memory/:id` — update last_accessed
- `POST /api/memory/search` — update last_accessed for all returned results
- Vector search and hybrid search — same

This is a lightweight UPDATE on each read — acceptable for the expected query volume.

---

## 4. Smart Session Loading

**What exists**: `session-start.sh` injects identity, autonomy mode, saved state, and daemon status. No memory injection.

**What it should do**: Query daemon memory API for relevant memories and inject a summary.

### 4a. For comms agent
On SessionStart, after existing injections:
1. Read `assistant-state.md` to get current context keywords
2. `POST /api/memory/search` with mode `hybrid`, using key phrases from assistant-state
3. Take top 10 results
4. Format as a concise "Memory Context" section
5. Inject into session via echo output

### 4b. For orchestrator
The orchestrator prompt already includes a task description. The session-start hook doesn't fire for orchestrator (it exits early — non-comms gate). Instead:
- Update the orchestrator spawn prompt (in `orchestrator.ts`) to instruct: "Before starting work, search memories via `POST /api/memory/search` for context relevant to your task."
- This is a prompt instruction, not a hook change.

### 4c. Memory context format
```
### Relevant Memories
- [preference] Dave prefers concise responses (accessed 2d ago)
- [infrastructure] BMO runs on davids-mac-mini.lan:3847 (accessed 5d ago)
- [decision] Using SQLite for all state, not flat files (accessed 1d ago)
```

Limited to 10 memories, ~500 tokens max. Keeps context window lean.

---

## 5. Summary of Changes

| Component | File(s) | Change |
|-----------|---------|--------|
| Memory API | `daemon/src/api/memory.ts` | Add `store-if-unique` endpoint, update last_accessed on reads |
| DB Schema | `daemon/src/core/migrations/005-memory-access-tracking.sql` | Add `last_accessed` column |
| Extraction hook | `.claude/hooks/memory-extraction.sh` | Use `store-if-unique`, pass session source |
| Curation task | `daemon/src/extensions/automation/tasks/memory-consolidation.ts` | Full implementation (was stub) |
| BMO tasks index | `daemon/src/extensions/automation/tasks/index.ts` | Register memory-consolidation |
| Session start hook | `.claude/hooks/session-start.sh` | Add memory context injection |
| Orchestrator prompt | `daemon/src/api/orchestrator.ts` | Add memory search instruction |

---

## 6. What We're NOT Doing

- **Not replacing memory-sync.ts** — peer sync is a separate concern, still uses file-based memories for now. That's a future migration.
- **Not adding a curation UI** — curation runs autonomously; conflicts flagged to comms.
- **Not auto-archiving facts** — only episodic memories get auto-cleaned. Facts are too valuable to delete without review.
- **Not changing the embedding model** — all-MiniLM-L6-v2 is fast and good enough.
