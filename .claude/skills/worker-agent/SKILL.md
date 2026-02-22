---
name: worker-agent
description: Spin up sandboxed Claude Code worker agents on this machine. Manage their lifecycle, permissions, and communication.
argument-hint: [spawn <name> "<mission>" [dir] | list | status <name> | logs <name> | stop <name> | collect <name>]
---

# Worker Agent Management

Spin up sandboxed Claude Code sessions as worker agents. Each worker runs in its own tmux window with scoped permissions and a direct communication channel back to you.

## Commands

Parse the arguments to determine action:

### Spawn
- `spawn <name> "<mission>"` - Create a fresh workspace under `~/workers/<name>/` and launch
- `spawn <name> "<mission>" <dir>` - Launch worker in an existing project directory
- `spawn <name> "<mission>" <dir> --profile=<profile>` - Use a specific permission profile

### List
- `list` or `ls` - Show all running worker agents with status

### Status
- `status <name>` - Read worker's progress file and current state

### Logs
- `logs <name>` - Capture the worker's current tmux pane output (last 100 lines)

### Stop
- `stop <name>` - Gracefully stop a worker (sends /stop to its session)

### Collect
- `collect <name>` - Read worker's output/results and clean up

### Examples
- `/worker-agent spawn docs-writer "Write API docs for the auth module" ./projects/auth-api`
- `/worker-agent spawn bug-fixer "Fix issue #42: login timeout" ./projects/webapp`
- `/worker-agent spawn researcher "Research best practices for WebSocket auth" --profile=research`
- `/worker-agent list`
- `/worker-agent status docs-writer`
- `/worker-agent stop docs-writer`
- `/worker-agent collect docs-writer`

## Permission Profiles

| Profile | Access | Best For |
|---------|--------|----------|
| `default` | Full read, edit/write in project, safe bash, git (no push), localhost | Implementation tasks |
| `research` | Read-only filesystem, web access, writes only to `.worker/` | Research and analysis |
| `isolated` | No network, no git, strict filesystem, edit/write in project only | Sensitive/untrusted work |

See [reference.md](reference.md) for full permission profile JSON templates.

## Spawn Workflow

When spawning a worker agent, follow these steps in order:

### 1. Prepare the workspace

**Fresh workspace** (no dir specified):
```bash
WORKER_DIR="$HOME/workers/<name>"
mkdir -p "$WORKER_DIR/.claude" "$WORKER_DIR/.worker" "$WORKER_DIR/output"
```

**Existing project** (dir specified):
```bash
WORKER_DIR="<dir>"
mkdir -p "$WORKER_DIR/.worker" "$WORKER_DIR/output"
```

### 2. Generate settings.local.json

Create `.claude/settings.local.json` in the worker's project directory. This is gitignored and controls permissions. Use the profile templates from [reference.md](reference.md), adjusting for the chosen profile.

### 3. Generate the worker's CLAUDE.md

Create `CLAUDE.local.md` in the worker's project directory (or `CLAUDE.md` for fresh workspaces). This is the worker's mission brief and operating instructions. Use the CLAUDE.local.md template from [reference.md](reference.md), filling in `{NAME}`, `{MISSION}`, `{WORKER_DIR}`, `{PROFILE}`.

### 4. Initialize communication files

```bash
# Create initial progress file
cat > "$WORKER_DIR/.worker/progress.md" << 'EOF'
## Progress

### Status: starting

### Current Step
Initializing...

### Completed
(none yet)

### Remaining
(reading mission brief)

### Notes
Worker just spawned.
EOF

# Create worker metadata
cat > "$WORKER_DIR/.worker/config.json" << EOF
{
  "name": "<name>",
  "spawned_by": "agent",
  "spawned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project_dir": "$WORKER_DIR",
  "profile": "<profile>",
  "mission": "<mission summary>",
  "tmux_window": "worker-<name>"
}
EOF
```

### 5. Add .worker/ to .gitignore

If the project has a `.gitignore`, ensure `.worker/` and `.claude/settings.local.json` are in it:

```bash
if [ -f "$WORKER_DIR/.gitignore" ]; then
  grep -q "^\.worker/" "$WORKER_DIR/.gitignore" || echo ".worker/" >> "$WORKER_DIR/.gitignore"
  grep -q "^\.claude/settings\.local\.json" "$WORKER_DIR/.gitignore" || echo ".claude/settings.local.json" >> "$WORKER_DIR/.gitignore"
  grep -q "^CLAUDE\.local\.md" "$WORKER_DIR/.gitignore" || echo "CLAUDE.local.md" >> "$WORKER_DIR/.gitignore"
fi
```

### 6. Launch the worker

Launch in a new tmux window within the agent's tmux session (configured in `cc4me.config.yaml` under `tmux.session`):

```bash
# Create a new tmux window for the worker (replace $TMUX_SESSION with config.tmux.session)
tmux new-window -t $TMUX_SESSION -n "worker-<name>" -c "$WORKER_DIR"

# Launch with -p (print mode) for clean startup — mission starts immediately.
# --dangerously-skip-permissions because settings.local.json deny rules are the guardrails.
# --max-turns caps session length as a safety net.
KICK_OFF="Read CLAUDE.local.md for your mission brief and complete the task. Update .worker/progress.md as you go. Signal the parent agent when done."
tmux send-keys -t "$TMUX_SESSION:worker-<name>" "claude -p --dangerously-skip-permissions --max-turns 50 \"$KICK_OFF\"" Enter
```

**Why `-p` mode?** The worker gets its mission brief from CLAUDE.local.md (loaded automatically) and the kick-off prompt from `-p`. No TUI timing issues, no interactive overhead. Worker starts immediately, does the job, exits.

**Why `--dangerously-skip-permissions`?** The `settings.local.json` deny rules provide the actual guardrails. Without this flag, the worker would be prompted for every operation, defeating the purpose. Deny rules block dangerous operations at the tool level — the worker literally cannot execute denied commands.

**Alternative — interactive mode** (for exploratory/long tasks):
```bash
tmux send-keys -t "$TMUX_SESSION:worker-<name>" "claude --dangerously-skip-permissions" Enter
sleep 12
tmux send-keys -t "$TMUX_SESSION:worker-<name>" "Read CLAUDE.local.md and complete your mission." Enter
sleep 2
tmux send-keys -t "$TMUX_SESSION:worker-<name>" Enter
```
Use interactive mode when the worker might need course corrections or when the mission is open-ended.

### 7. Register the worker

Track running workers in `.claude/state/workers.json`. See [reference.md](reference.md) for the registry schema.

## List Command

Show all registered workers and their current status:

```bash
# Read workers.json
cat .claude/state/workers.json

# Check which tmux windows are actually alive
tmux list-windows -t $TMUX_SESSION -F '#{window_name} #{window_active}' | grep worker-
```

Cross-reference the registry with live tmux windows. If a window is gone but the worker is still "running" in the registry, update its status to "exited".

**Output format:**
```
## Workers (2 running, 1 completed)

[docs-writer] RUNNING - "Write API docs for auth module"
  Dir: ~/workers/docs-writer | Profile: default | Spawned: 2h ago
  Progress: Step 3/5 — Writing endpoint reference

[bug-fixer] DONE - "Fix issue #42: login timeout"
  Dir: ./projects/webapp | Profile: default | Spawned: 45m ago
  Output ready for collection

[researcher] EXITED - "Research WebSocket auth"
  Dir: ~/workers/researcher | Profile: research | Spawned: 1h ago
  Window closed unexpectedly — check logs
```

## Status Command

Read a worker's progress and tmux state:

1. Read `{project_dir}/.worker/progress.md`
2. Capture tmux pane: `tmux capture-pane -t "$TMUX_SESSION:worker-<name>" -p | tail -20`
3. Report both

## Logs Command

Capture the worker's terminal output:

```bash
tmux capture-pane -t "$TMUX_SESSION:worker-<name>" -p -S -100
```

## Stop Command

Gracefully stop a worker:

```bash
# Send /stop to the worker's Claude session
tmux send-keys -t "$TMUX_SESSION:worker-<name>" "/stop" Enter

# Wait a moment, then check if window closed
sleep 3
tmux list-windows -t $TMUX_SESSION -F '#{window_name}' | grep -q "worker-<name>" && \
  echo "Worker still running — may need force kill" || \
  echo "Worker stopped cleanly"
```

Update `workers.json` status to "stopped".

If the worker doesn't stop cleanly:
```bash
tmux kill-window -t "$TMUX_SESSION:worker-<name>"
```

## Collect Command

Gather a worker's output and clean up:

1. Read `{project_dir}/.worker/progress.md` for final status
2. Read/list files in `{project_dir}/output/`
3. If the project was a fresh workspace (`~/workers/<name>`), summarize what was produced
4. If the project was existing, check `git log` for commits the worker made
5. Update `workers.json` status to "collected"
6. Report results to the user

**Don't auto-delete worker directories** — they may contain useful output. Let the user decide when to clean up.

## Monitoring Best Practices

- **Check workers every 15-30 minutes** when they're running
- **Read progress.md first** — it's the worker's self-reported status
- **Capture tmux pane** if progress seems stale — worker may be stuck on a prompt
- **If a worker is stuck on a permission prompt**, decide whether to approve (switch to its tmux window and type y/n) or adjust its settings.local.json
- **Workers manage their own context** — if they fill up, they should save state and restart like any Claude session

## Security Notes

- **settings.local.json deny rules are the primary guardrail** — they prevent the worker from executing dangerous operations at the tool level
- **Workers cannot access Keychain** — `security` command is denied
- **Workers cannot push code** — `git push` and `git remote` are denied
- **Workers cannot escalate privileges** — `sudo` is denied
- **Workers cannot access SSH keys** — `~/.ssh/` is read-denied
- **Fresh workspaces are fully isolated** — no existing code to damage
- **Existing projects should be on a branch** — spawn workers on feature branches, not main
- **Review worker commits before merging** — treat worker output like any PR

## Integration

- Workers tracked in `.claude/state/workers.json`
- Worker progress in `{project}/.worker/progress.md`
- Worker output in `{project}/output/`
- Communication via files + daemon endpoint (when implemented)
- Monitoring via periodic tmux capture + progress file reads

## Future Enhancements

- Daemon `/worker/signal` endpoint for real-time notifications
- Automatic worker health monitoring as a scheduled task
- Worker templates for common task types (code review, testing, documentation)
- Worker pools for parallel execution of similar tasks
- Cost tracking per worker session

## References

- [reference.md](reference.md) — Permission profile templates, CLAUDE.local.md template, worker registry schema, fallback polling
