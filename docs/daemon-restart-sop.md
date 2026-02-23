# Daemon Restart SOP

Standard procedure for restarting kithkit services. Three independent services, three procedures.

## Services

| Service | Plist Label | KeepAlive | What It Does |
|---------|------------|-----------|--------------|
| Daemon | `com.assistant.daemon` | Yes | Node.js on port 3847 — API, scheduler, integrations |
| Comms Agent | `com.assistant.bmo` | No | Tmux session running Claude Code (the "brain") |
| Restart Watcher | `com.bmo.restart-watcher` | Yes | Polls for restart flag, triggers comms agent restart |

## 1. Daemon Only

Restart the Node.js daemon without touching the comms agent session. Use when: config changed, code rebuilt, daemon crash, extension update.

```bash
# Graceful: unload + reload
launchctl unload ~/Library/LaunchAgents/com.bmo.daemon.plist
launchctl load ~/Library/LaunchAgents/com.bmo.daemon.plist

# Or force-restart (KeepAlive respawns automatically)
launchctl kickstart -k gui/$(id -u)/com.assistant.daemon
```

**Pre-restart:**
- Build if code changed: `cd daemon && npm run build`
- No state to save — daemon is stateless (SQLite persists)

**Post-restart:**
- Verify: `curl -s http://localhost:3847/health | python3 -m json.tool`
- Check for errors: `tail -20 logs/daemon-stderr.log`
- Confirm extension loaded: health response shows `"extension": "bmo"`

**Impact:** Comms agent keeps running. Scheduler tasks restart. Active orchestrator/worker sessions survive (orphan cleanup marks stale DB records as crashed on next startup). Integrations (Telegram, email) reconnect automatically.

## 2. Comms Agent Only

Restart the Claude Code tmux session. Use when: context full, `/restart` command, need fresh session.

**Preferred method** (from inside Claude Code):
```
/restart
```
This saves state to `assistant-state.md`, writes the restart flag, and the restart-watcher handles the rest.

**Manual method** (from another terminal):
```bash
# Save state first if the session is responsive
# Then:
scripts/restart.sh
```

**Emergency method** (session unresponsive):
```bash
tmux kill-session -t bmo
scripts/start-tmux.sh --detach --skip-permissions
```

**Pre-restart:**
- Save state (`/save-state` or `/restart` which does both)
- If session is unresponsive, state may be lost — check `assistant-state.md` timestamp after restart

**Post-restart:**
- SessionStart hook auto-loads saved state
- Verify: `tmux has-session -t bmo && echo "alive"`

**Impact:** Daemon keeps running. New session picks up saved state via hook.

## 3. Full Stack

Restart everything. Use when: machine reboot, major upgrade, things are weird.

```bash
# Order matters: daemon first, then comms
launchctl unload ~/Library/LaunchAgents/com.bmo.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.bmo.restart-watcher.plist
tmux kill-session -t bmo 2>/dev/null

# Bring back up
launchctl load ~/Library/LaunchAgents/com.bmo.daemon.plist
sleep 2
curl -s http://localhost:3847/health  # wait for healthy
launchctl load ~/Library/LaunchAgents/com.bmo.restart-watcher.plist
launchctl load ~/Library/LaunchAgents/com.assistant.bmo.plist
```

**Post-restart:** Run the daemon health check, then attach to tmux to confirm comms agent resumed.

## Rules for Orchestrators and Workers

Agents spawned by the daemon (orchestrator, workers) may need to trigger a daemon restart. Follow these rules:

1. **Never restart the comms agent.** Only the comms agent restarts itself (via `/restart`). Orchestrators and workers must not kill the `bmo` tmux session or write the restart flag file.

2. **Never use `launchctl` for `com.assistant.bmo`.** That's the comms agent's plist. Touching it kills the human's active session.

3. **Daemon restart is OK** — but coordinate:
   - Send a result message to comms first: `curl -s -X POST http://localhost:3847/api/messages -H "Content-Type: application/json" -d '{"from":"orchestrator","to":"comms","type":"result","body":"<results>"}'`
   - Wait 2 seconds for the message to be delivered
   - Then restart: `launchctl kickstart -k gui/$(id -u)/com.assistant.daemon`
   - The orchestrator's own tmux session will survive the daemon restart

4. **After daemon restart, report completion** — the orchestrator should verify daemon health, then exit cleanly.

## Quick Reference

| I want to... | Command |
|--------------|---------|
| Restart daemon | `launchctl kickstart -k gui/$(id -u)/com.assistant.daemon` |
| Restart comms | `/restart` (from inside session) |
| Restart comms (external) | `scripts/restart.sh` |
| Check daemon health | `curl -s http://localhost:3847/health` |
| Check comms alive | `tmux has-session -t bmo` |
| Check watcher alive | `launchctl list \| grep restart-watcher` |
| View daemon logs | `tail -f logs/daemon.log` |
| View daemon errors | `tail logs/daemon-stderr.log` |
