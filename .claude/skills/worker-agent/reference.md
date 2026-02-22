# Worker Agent Reference

Templates and detailed reference for worker agent management.

## Permission Profile Templates

### Default Profile (Developer)

Full read access, edit/write within project, safe bash commands, git (no push), localhost network for comms. Best for implementation tasks.

**`.claude/settings.local.json`**:
```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(node *)",
      "Bash(python3 *)",
      "Bash(pip *)",
      "Bash(git status)",
      "Bash(git log *)",
      "Bash(git diff *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git checkout *)",
      "Bash(git branch *)",
      "Bash(git stash *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(cat *)",
      "Bash(head *)",
      "Bash(tail *)",
      "Bash(wc *)",
      "Bash(sort *)",
      "Bash(diff *)",
      "Bash(find *)",
      "Bash(which *)",
      "Bash(echo *)",
      "Bash(date)",
      "Bash(pwd)",
      "Bash(curl -s http://localhost:3847/*)",
      "Bash(curl -s -X POST http://localhost:3847/*)"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf /*)",
      "Bash(sudo *)",
      "Bash(git push *)",
      "Bash(git remote *)",
      "Bash(ssh *)",
      "Bash(scp *)",
      "Bash(curl * --upload-file *)",
      "Bash(open *)",
      "Bash(osascript *)",
      "Bash(launchctl *)",
      "Bash(security *)",
      "Read(//Users/*/.ssh/**)",
      "Read(//etc/shadow)",
      "Read(//etc/master.passwd)",
      "Edit(//.env)",
      "Edit(//**/credentials*)",
      "Edit(//**/secrets/**)"
    ]
  }
}
```

### Research Profile

Read-only filesystem, web access enabled, no edits/writes except to `.worker/` directory. Best for research and analysis tasks.

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Edit(//.worker/**)",
      "Write(//.worker/**)",
      "Bash(curl *)",
      "Bash(date)",
      "Bash(pwd)",
      "Bash(wc *)"
    ],
    "deny": [
      "Edit",
      "Write",
      "Bash(rm *)",
      "Bash(sudo *)",
      "Bash(git *)",
      "Bash(ssh *)",
      "Bash(npm *)",
      "Bash(node *)",
      "Read(//Users/*/.ssh/**)"
    ]
  }
}
```

### Isolated Profile

No network, no git, strict filesystem. Edit/write within project only. Best for sensitive or untrusted workloads.

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "Bash(npm run *)",
      "Bash(npm test *)",
      "Bash(node *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(pwd)",
      "Bash(echo *)"
    ],
    "deny": [
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(git *)",
      "Bash(ssh *)",
      "Bash(sudo *)",
      "Bash(rm -rf *)",
      "Bash(open *)",
      "Bash(osascript *)",
      "Bash(security *)",
      "Read(//Users/*/.ssh/**)",
      "Read(//etc/**)"
    ]
  }
}
```

## CLAUDE.local.md Template

Fill in `{NAME}`, `{MISSION}`, `{WORKER_DIR}`, `{PROFILE}`:

```markdown
# Worker Agent: {NAME}

You are a worker agent spawned by the primary assistant. Your job is to complete the mission below, then report your results.

## Mission

{MISSION}

## Communication Protocol

### Progress Updates
Write progress updates to `.worker/progress.md` as you work. Format:

\`\`\`markdown
## Progress

### Status: working | done | stuck | error

### Current Step
What you're doing right now.

### Completed
- [x] Step 1 description
- [x] Step 2 description

### Remaining
- [ ] Step 3 description

### Notes
Any blockers, decisions, or context.
\`\`\`

Update `.worker/progress.md` after completing each major step. This is how the primary assistant tracks your progress.

### Signaling the primary assistant
When you finish or get stuck, notify the primary assistant directly:

\`\`\`bash
# Signal completion
curl -s -X POST http://localhost:3847/worker/signal \
  -H 'Content-Type: application/json' \
  -d '{"worker":"{NAME}","status":"done","message":"Task complete. Results in output/"}'

# Signal that you're stuck
curl -s -X POST http://localhost:3847/worker/signal \
  -H 'Content-Type: application/json' \
  -d '{"worker":"{NAME}","status":"stuck","message":"Blocked on X — need guidance"}'
\`\`\`

If the curl endpoint isn't available, just write to `.worker/progress.md` with status `done` or `stuck`. the primary assistant checks periodically.

### Output
Put your deliverables in the `output/` directory. If your mission produces code changes, commit them locally (do NOT push).

## Rules

- Stay focused on your mission — don't wander into unrelated work
- Write clean, well-tested code (if coding)
- Commit frequently with clear messages
- Update progress.md after each major step
- When done, set status to `done` and signal the primary assistant
- If stuck for more than 2 attempts at a problem, set status to `stuck` and signal the primary assistant
- Do NOT push to any remote repository
- Do NOT access credentials or secrets
- Do NOT modify files outside your project directory (unless explicitly part of the mission)

## Context Management
You manage your own context like any Claude Code session. If context gets low, save state and restart. Your mission brief persists in this file.
```

## Worker Signal Fallback Polling

Until the daemon `/worker/signal` endpoint is implemented, poll active workers' progress files:

```bash
for worker_dir in $(python3 -c "
import json
with open('.claude/state/workers.json') as f:
    data = json.load(f)
for name, w in data.get('workers', {}).items():
    if w['status'] == 'running':
        print(w['project_dir'])
"); do
  status=$(grep "^### Status:" "$worker_dir/.worker/progress.md" 2>/dev/null | head -1 | sed 's/### Status: //')
  if [ "$status" = "done" ] || [ "$status" = "stuck" ] || [ "$status" = "error" ]; then
    echo "Worker in $worker_dir signaled: $status"
  fi
done
```

## Worker Registry Schema

Workers are tracked in `.claude/state/workers.json`:

```json
{
  "workers": {
    "<name>": {
      "status": "running",
      "spawned_at": "2026-02-10T13:00:00Z",
      "project_dir": "/Users/bmo/workers/<name>",
      "profile": "default",
      "mission": "<mission summary>",
      "tmux_window": "worker-<name>"
    }
  }
}
```

Use `python3` to update this JSON file (Write tool has JSON persistence issues — see memory).
