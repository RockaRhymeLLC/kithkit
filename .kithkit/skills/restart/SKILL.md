---
name: restart
description: Restart kithkit session gracefully. Use when MCP servers change, settings update, or context is full.
---

# Restart Session

Restart your kithkit session. Use this when:
- New MCP servers were added and need to load
- Settings were changed that require restart
- Context is full and you need a fresh start

## Workflow

1. **Save current state** - Run `/save-state` to capture what you're working on
2. **Notify user** - Let them know restart is happening via the active channel
3. **Create restart flag** - Write to the absolute `$STATE_DIR` path (CWD-independent)
4. **Exit** - The restart-watcher service will detect the flag and restart the session

## Steps

```bash
# 1. Save state (call the save-state skill first)

# 2. Notify user via active channel (if not silent)
CHANNEL=$(cat .kithkit/state/channel.txt 2>/dev/null | tr -d '[:space:]')
if [ -n "$CHANNEL" ] && [ "$CHANNEL" != "silent" ]; then
  # Send restart notification via the active channel
  echo "Restarting now — be right back!"
fi

# 3. Create restart flag (CWD-independent: source config.sh for absolute STATE_DIR)
# Walk upward from CWD to find the project root (where scripts/lib/config.sh lives),
# then source it so STATE_DIR is an absolute path regardless of CWD.
_d="$PWD"; while [[ "$_d" != "/" && ! -f "$_d/scripts/lib/config.sh" ]]; do _d="${_d%/*}"; done
source "$_d/scripts/lib/config.sh"
touch "$STATE_DIR/restart-requested"

# 4. Tell user (terminal)
echo "Restart requested. Session will restart in ~5 seconds."
echo "Attach after restart with: tmux attach -t <your-session-name>"
```

## Important

- Always save state before restarting so context is preserved
- The restart-watcher service must be running (managed by the daemon or launchd)
- After restart, the auto-prompt will trigger and you'll resume from saved state
- The session-start hook sends a "back online" notification via the configured channel

## Manual Alternative

If the watcher isn't running, tell the user:
```
Please run: ./scripts/restart.sh
```
