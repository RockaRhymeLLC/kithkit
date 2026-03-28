---
name: kkitclaudesync
description: Sync .kithkit/ authoritative files to .claude/
---

# /kkitclaudesync — Kithkit-to-Claude Sync

Syncs authoritative files from `.kithkit/` to `.claude/` so Claude Code can read them.

## What it does

Calls `POST /api/sync/claude` on the daemon to copy:
- `.kithkit/settings.json` → `.claude/settings.json`
- `.kithkit/CLAUDE.md` → `.claude/CLAUDE.md`
- `.kithkit/agents/` → `.claude/agents/` (rsync with delete)
- `.kithkit/skills/` → `.claude/skills/` (rsync with delete)

## Usage

Just type `/kkitclaudesync` — no arguments needed.

For a dry-run preview:
```
/kkitclaudesync --dry-run
```

## When to use

- After editing any file in `.kithkit/` (settings, hooks, agents, skills, CLAUDE.md)
- After adding or removing a skill or agent profile in `.kithkit/`
- If Claude Code seems to be using stale settings or missing a new skill

## Implementation

```bash
if [[ "$*" == *"--dry-run"* ]]; then
  echo "Dry-run: checking what would be synced..."
  diff_found=false
  for pair in "settings.json" "CLAUDE.md"; do
    if ! diff -q ".kithkit/$pair" ".claude/$pair" >/dev/null 2>&1; then
      echo "  WOULD SYNC: $pair (files differ)"
      diff_found=true
    else
      echo "  OK: $pair (in sync)"
    fi
  done
  for dir in "agents" "skills"; do
    if ! diff -rq ".kithkit/$dir/" ".claude/$dir/" >/dev/null 2>&1; then
      echo "  WOULD SYNC: $dir/ (directories differ)"
      diff_found=true
    else
      echo "  OK: $dir/ (in sync)"
    fi
  done
  if ! $diff_found; then
    echo "Everything is in sync. No changes needed."
  fi
else
  curl -s -X POST http://localhost:3847/api/sync/claude | python3 -m json.tool
fi
```
