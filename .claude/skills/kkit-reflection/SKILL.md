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
3. Execute actions (skill updates, memory cleanup, todo creation)
4. Generate and deliver a summary

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

Show the last reflection run summary and timestamp:

```bash
curl -s 'http://localhost:3847/api/tasks/kkit-reflection/status'
```

Or query the task_results table directly for recent runs.

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
- `pattern_detection` — recurring theme detection config

## Notes

- The scheduler path uses **heuristic categorization** (keyword/tag matching) — fast and cost-free
- The `/kkit-reflection run` skill path can use **LLM categorization** with the few-shot examples above
- Dry-run is the default for v1 — set `dry_run: false` to enable live actions
- Skill file writes go to `reference.md` only — never modifies `SKILL.md`
- Deleted memory content is preserved in the reflection summary for recovery
