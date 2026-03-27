---
name: kkit-reflection
description: Run the nightly self-improvement reflection. Reviews retro memories, updates skills, cleans stale data, creates todos for gaps.
argument-hint: [run | dry-run | status]
---

# Kkit Reflection

Nightly self-improvement loop that reviews retro memories, categorizes learnings, and applies durable improvements.

## Usage

`/kkit-reflection [run | dry-run | status]`

## Commands

### run

Trigger a full reflection cycle immediately:

1. Gather retro memories from the last 24h (or since last successful run)
2. Categorize each memory into an action type
3. Detect recurring patterns across a 7-day window
4. Execute actions (skill updates, memory cleanup, todo creation)
5. Generate and deliver a summary

```bash
curl -s -X POST 'http://localhost:3847/api/tasks/kkit-reflection/run'
```

### dry-run

Same as `run` but with `dry_run: true` — logs what would happen without making changes.

```bash
curl -s -X POST 'http://localhost:3847/api/tasks/kkit-reflection/run' \
  -H 'Content-Type: application/json' \
  -d '{"config": {"dry_run": true}}'
```

### status

Show the last reflection run result and timestamp:

```bash
curl -s 'http://localhost:3847/api/tasks' | python3 -m json.tool
```

Or query the task_results table directly for recent runs:

```bash
sqlite3 kithkit.db "SELECT task_name, status, output, started_at FROM task_results WHERE task_name='kkit-reflection' ORDER BY started_at DESC LIMIT 5;"
```

## Pattern Detection

After categorizing per-memory actions, the reflection scans a wider 7-day window for recurring themes. Any tag or category that appears in 3 or more retro memories within the window is flagged as a pattern.

For each detected pattern, a high-priority todo is created:

```
Recurring issue: <theme> (N occurrences in 7 days)
Pattern detected across N retro memories. Source memory IDs: ...
```

Configuration (under `kithkit.config.yaml` → `scheduler.tasks` → `kkit-reflection`):

```yaml
pattern_detection:
  enabled: true       # set false to disable
  window_days: 7      # how far back to scan
  threshold: 3        # minimum occurrences to flag
```

Patterns appear in the run summary under "Patterns detected".

## Categorization Guide

When categorizing memories manually (LLM path), use these action types:

| Action | When to use |
|--------|-------------|
| `skill-update` | Procedural knowledge — specific technique or API format that should be in a skill reference file |
| `memory-keep` | Valuable context — useful for debugging or decisions but not a reusable procedure |
| `memory-consolidate` | Near-duplicate — keep the most detailed version, delete older duplicates |
| `memory-expire` | Transient event — no lasting value, situation already resolved |
| `todo-create` | Framework gap — recurring issue that needs a code fix, new skill, or documentation |
| `no-action` | Already addressed or not actionable — log only |

### Few-Shot Examples

| Memory content | Correct action | Reason |
|---|---|---|
| "Always use python3 for JSON in curl to avoid shell quoting issues" | `skill-update` → `daemon-api` | Procedural — specific technique |
| "The relay registration failed because the key was in the wrong format" | `memory-keep` | Episodic context — useful for debugging |
| "Use `payload.text` not `payload.body` for A2A messages" | `skill-update` → `agent-comms` | API format correction |
| "Tried SSH to peer machine but got connection refused" | `memory-expire` | Transient event — already resolved |
| "Third time this week the send API failed on missing `channels` field" | `todo-create` (high) | Recurring pattern — needs framework fix |
| "Worker took 5 minutes because the prompt was too large" | `no-action` | One-time observation |
| "Use payload.text for A2A" + "A2A requires payload.text not body" | `memory-consolidate` | Near-duplicate |

## Output Format

Each categorized memory produces a JSON action:

```json
{
  "memory_id": 123,
  "action": "skill-update",
  "target_skill": "daemon-api",
  "content": "Always quote URLs in curl commands.",
  "reason": "Procedural knowledge, recurs frequently"
}
```

## Configuration

Controlled via `kithkit.config.yaml` under `scheduler.tasks` → `kkit-reflection`:

- `dry_run` (default: true) — log-only mode, no writes/deletes
- `lookback_hours` (default: 24) — fallback window if no previous run
- `max_memories_per_run` (default: 100)
- `max_deletes_per_run` (default: 10)
- `enabled_actions` — list of action types to execute
- `skill_mapping` — map memory categories to skill directories
- `pattern_detection` — recurring theme detection (see above)

## Recovering Deleted Memories

When memories are expired or consolidated, their content is preserved in the reflection summary memory. To recover:

1. Find the relevant reflection summary:
   ```bash
   sqlite3 kithkit.db "SELECT id, content FROM memories WHERE category='reflection-summary' ORDER BY created_at DESC LIMIT 5;"
   ```

2. The summary includes a "Deleted memories (for recovery)" section listing each deleted memory's ID and content:
   ```
   Deleted memories (for recovery):
     [42] Use payload.text not body for A2A messages
     [43] Tried SSH to peer, connection refused
   ```

3. Re-insert any memory you want to restore via `POST /api/memory/store`.

## Troubleshooting

**Task not running on schedule**
- Check it is enabled: `curl -s 'http://localhost:3847/api/tasks'` — confirm `kkit-reflection` shows `enabled: true`
- Check cron expression in `kithkit.config.yaml` — default is `0 3 * * *` (3 AM daily)
- Trigger manually: `curl -s -X POST 'http://localhost:3847/api/tasks/kkit-reflection/run'`

**No memories processed (returns "No retro memories found")**
- Memories must have `trigger='retro'` OR include `'self-improvement'` in their tags
- Check with: `sqlite3 kithkit.db "SELECT id, trigger, tags FROM memories ORDER BY created_at DESC LIMIT 20;"`
- The lookback window is since last successful run, or 24h if no previous run

**Pattern todos not appearing**
- Confirm `pattern_detection.enabled` is true in config
- Threshold default is 3 — need 3+ memories sharing a tag/category within 7 days
- Pattern detection runs against the full 7-day window, independent of the 24h lookback

**Skill reference writes failing**
- Skill names must be lowercase alphanumeric + hyphens only (e.g. `daemon-api`, `agent-comms`)
- Target directory must not be a symlink
- Check daemon logs: `tail -f logs/daemon.log | grep kkit-reflection`

**dry_run is true but I want live actions**
- Default is `dry_run: true` for safety
- To enable: set `dry_run: false` in `kithkit.config.yaml` under the task config, then `POST /api/config/reload`

## Notes

- The scheduler path uses **heuristic categorization** (keyword/tag matching) — fast and cost-free
- The `/kkit-reflection run` skill path can use **LLM categorization** with the few-shot examples above
- Dry-run is the default for v1 — set `dry_run: false` to enable live actions
- Skill file writes go to `reference.md` only — never modifies `SKILL.md`
- Deleted memory content is preserved in the reflection summary for recovery
