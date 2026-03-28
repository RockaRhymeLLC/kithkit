# Migration Guide: .claude/ → .kithkit/

## Overview

Kithkit migrates its managed files from `.claude/` to `.kithkit/`, making `.kithkit/` the authoritative source. The `.claude/` directory becomes a synced read-only copy that Claude Code continues to read from.

## What moves

| Source | Destination | Method |
|--------|------------|--------|
| `.claude/hooks/` | `.kithkit/hooks/` | Move |
| `.claude/state/` | `.kithkit/state/` | Move (individual files) |
| `.claude/agents/` | `.kithkit/agents/` | Move + sync back |
| `.claude/skills/` | `.kithkit/skills/` | Move + sync back |
| `.claude/settings.json` | `.kithkit/settings.json` | Copy (both kept) |
| `.claude/CLAUDE.md` | `.kithkit/CLAUDE.md` | Copy (both kept) |

## What stays in .claude/

- Synced copies: `settings.json`, `CLAUDE.md`, `agents/`, `skills/`
- Claude Code internals: `projects/`, `worktrees/`, `state/todos.json`, `state/ide/`

## Running the migration

### Preview
```bash
./migrate.sh --dry-run
```

### Execute
```bash
./migrate.sh --yes
```

### Rollback
```bash
./rollback.sh --yes
```

## Post-migration

1. Restart the daemon to pick up new paths
2. Restart the restart-watcher service (migrate.sh kills it automatically)
3. Verify sync works: `curl -X POST localhost:3847/api/sync/claude`
4. Use `/kkitclaudesync` skill to manually trigger sync after editing `.kithkit/` files

## How sync works

The daemon's `POST /api/sync/claude` endpoint maintains the `.claude/` copies:
- `settings.json`: JSON merge (preserves destination-only keys like `permissions` and instance-specific hooks)
- `CLAUDE.md`: Full overwrite
- `agents/` and `skills/`: rsync with --delete (exact mirror)

Edit files in `.kithkit/`, then sync to `.claude/`. Never edit `.claude/` directly — changes will be overwritten on next sync.
