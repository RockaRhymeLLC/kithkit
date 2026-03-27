---
name: restart
description: Restart Claude Code session gracefully. Use when MCP servers change, settings update, or context is full.
---

# Restart Session

Restart your Claude Code session. Use this when:
- New MCP servers were added and need to load
- Settings were changed that require restart
- Context is full and you need a fresh start

## Workflow

1. **Save current state** - Run `/save-state` to capture what you're working on
2. **Create restart flag** - Write to `.claude/state/restart-requested`
3. **Notify user** - Let them know restart is happening
4. **Exit** - The restart-watcher service will detect the flag and restart the session

## Steps

```bash
# 1. Save state (call the save-state skill first)

# 2. Create restart flag
touch .claude/state/restart-requested

# 3. Tell user
echo "Restart requested. Session will restart in ~5 seconds."
echo "Attach after restart with: tmux attach -t assistant"
```

## Important

- Always save state before restarting so context is preserved
- The restart-watcher service must be running (launchd)
- After restart, the auto-prompt will trigger and you'll resume from saved state

## Manual Alternative

If the watcher isn't running, tell the user:
```
Please run: ./scripts/restart.sh
```
