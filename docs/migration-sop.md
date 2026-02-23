# Kithkit Migration SOP

Standard operating procedure for migrating a CC4Me agent to a Kithkit instance.
Written by BMO during the CC4Me-BMO → KKit-BMO cutover (2026-02-22).

**Audience**: R2, Marvho, and any future agent doing this migration.

---

## Overview

Kithkit is the successor framework to CC4Me. Migration involves:
1. Setting up the new KKit repo with agent-specific config
2. Building the daemon
3. Cutting over launchd plists from the old repo to the new one
4. Verifying everything works
5. Rebuilding integrations (Telegram, email, voice, A2A) fresh — **not** porting old code

---

## Pre-Move Checklist

### 1. Build and verify daemon
```bash
cd ~/KKit-<AGENT>
npm install
npm run build
node daemon/dist/bootstrap.js .
# Confirm: {"status":"ok"} on http://localhost:<port>/health
# Ctrl-C to stop
```

### 2. Identity file
Put your identity at `identity.md` in the repo root. Make sure `kithkit.config.yaml` has:
```yaml
agent:
  name: "YourName"
  identity_file: "identity.md"
```

### 3. Create directories
```bash
mkdir -p ~/KKit-<AGENT>/logs
mkdir -p ~/KKit-<AGENT>/projects
```

### 4. Set up Claude Code project memory
```bash
mkdir -p ~/.claude/projects/-Users-<user>-KKit-<AGENT>/memory/
# Create MEMORY.md with relevant context from old repo
```

### 5. Prepare launchd plists
Copy your old plists and update all paths. You need 3 plists:
- **Daemon**: `com.<agent>.daemon.plist`
- **Assistant session**: `com.assistant.<agent>.plist`
- **Restart watcher**: `com.<agent>.restart-watcher.plist`

---

## Cutover Procedure

### Phase 1: Stop old, start new daemon

```bash
# Stop old daemon and restart-watcher
launchctl unload ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist

# Backup old plists
mkdir -p ~/KKit-<AGENT>/.cutover-backup
cp ~/Library/LaunchAgents/com.<agent>.*.plist ~/KKit-<AGENT>/.cutover-backup/
date > ~/KKit-<AGENT>/.cutover-backup/timestamp.txt

# Install new plists (overwrite old ones)
cp <new-plists> ~/Library/LaunchAgents/

# Start new daemon + watcher
launchctl load ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl load ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist

# Verify
curl http://localhost:<port>/health
```

### Phase 2: Swap assistant session
```bash
launchctl unload ~/Library/LaunchAgents/com.assistant.<agent>.plist
# Install updated assistant plist pointing to KKit repo
cp <new-assistant-plist> ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.assistant.<agent>.plist
```

---

## Post-Move Verification

1. **Daemon health**: `curl http://localhost:<port>/health` → `{"status":"ok", "extension":"<agent>"}`
2. **Identity loaded**: confirm agent name in `/status` response
3. **Scheduler tasks**: `curl http://localhost:<port>/api/tasks` → should list configured tasks
4. **Extension loaded**: health response should show `"extension": "<name>"`, NOT `null`

---

## Gotchas & Lessons Learned

### GOTCHA 1: Stale test database crashes daemon on migration
**Symptom**: `SqliteError: table memories already exists` — daemon crash loop
**Cause**: A `kithkit.db` from testing had tables created but an empty migrations table. When the daemon starts, it tries to run migrations, finds the table already exists, and dies.
**Fix**: Delete `kithkit.db` (and any WAL/SHM files) before first real start:
```bash
rm -f ~/KKit-<AGENT>/kithkit.db*
```
**Scope**: BMO-specific (stale test artifact), but any instance could hit this.
**Upstream fix needed?** YES — the migration runner should handle pre-existing tables gracefully (use `CREATE TABLE IF NOT EXISTS` or check migration state before running). Filed as kithkit upstream issue.

### GOTCHA 2: Daemon plist must point to bootstrap.js, NOT main.js
**Symptom**: Daemon starts and serves health OK, but `"extension": null` in health response. No scheduler tasks registered, no Telegram, no integrations.
**Cause**: The plist ProgramArguments pointed to `daemon/dist/main.js` instead of `daemon/dist/bootstrap.js`. `bootstrap.ts` is what registers the agent extension before importing main. Without it, you get a bare kithkit daemon with no agent personality.
**Fix**: Update plist to use `bootstrap.js`:
```xml
<string>/opt/homebrew/bin/node</string>
<string>/path/to/KKit-AGENT/daemon/dist/bootstrap.js</string>
<string>/path/to/KKit-AGENT</string>
```
**Scope**: Applies to ALL kithkit instances with extensions.
**Upstream fix needed?** YES — the documentation and example plists should clearly specify `bootstrap.js` as the entry point, not `main.js`. The old punchlist item 4 mentioned `main.js` explicitly, which is wrong.

### GOTCHA 3: Voice extension crashes daemon if Python venv doesn't exist
**Symptom**: `Error: spawn .../voice/.venv/bin/python3 ENOENT` — daemon crash, never recovers (KeepAlive loops)
**Cause**: Voice is enabled in config (`channels.voice.enabled: true`) but the voice Python virtual environment hasn't been set up yet. The voice init spawns a Python child process and the ENOENT error is unhandled.
**Fix (immediate)**: Disable voice in config until the venv is ready:
```yaml
channels:
  voice:
    enabled: false  # Enable after setting up voice venv
```
**Fix (proper)**: The voice extension should catch ENOENT on the child process spawn and degrade gracefully instead of crashing the entire daemon.
**Scope**: Applies to ALL kithkit instances with voice configured but not yet set up.
**Upstream fix needed?** YES — critical. An unhandled ENOENT in a child process spawn should never take down the daemon. The extension init should validate that dependencies exist before attempting to spawn, and fail gracefully (log a warning + disable voice) rather than crash.

### GOTCHA 4: Core scheduler tasks aren't registered by the extension
**Symptom**: Scheduler tasks from config are loaded but core handlers (context-watchdog, todo-reminder, etc.) don't actually execute — they have no registered handler.
**Cause**: `registerCoreTasks()` exists in `daemon/src/automation/tasks/index.ts` but is never called. The BMO extension calls `registerBmoTasks()` for its own tasks but doesn't call the core registration function.
**Partially addressed**: The BMO extension registers stub handlers for tasks without real implementations, so they don't error out — but they also don't do anything useful. Core tasks like `context-watchdog` have real implementations that just aren't wired up.
**Fix**: Call `registerCoreTasks(scheduler)` in the extension's onInit, before `registerBmoTasks()`.
**Scope**: Affects ALL kithkit instances.
**Upstream fix needed?** YES — either `main.ts` should register core tasks automatically, or the extension docs should make it clear that extensions must call `registerCoreTasks()`.

---

## Upstream Issues for Kithkit (to file/fix in public repo)

| # | Issue | Severity | File(s) |
|---|-------|----------|---------|
| 1 | Migration runner doesn't handle pre-existing tables | Medium | `daemon/src/core/migrations.ts` |
| 2 | Documentation says `main.js` but extensions need `bootstrap.js` | High | docs, example plists |
| 3 | Voice extension ENOENT crash (unhandled child process error) | Critical | `daemon/src/extensions/voice/` |
| 4 | Core scheduler tasks never registered | Medium | `daemon/src/automation/tasks/index.ts`, extension init |

---

## Post-Cutover: Rebuilding Integrations

These are rebuilt fresh, not ported. Use CC4Me-<AGENT> as reference material only.

- [ ] **Telegram** — set up webhook, test send/receive
- [ ] **Email** — configure providers, test triage rules
- [ ] **A2A / agent-comms** — install SDK, configure peers, test ping
- [ ] **Voice** — create Python venv, install dependencies, enable in config
- [ ] **Browser** — configure Browserbase or local Playwright

Each integration should be tested independently before enabling in config.

---

## Timeline (BMO's actual migration)

- **2026-02-22 ~21:30 EST**: Pre-move prep (items 1-6)
- **2026-02-22 ~22:00 EST**: Cutover Phase 1 (daemon swap)
- **2026-02-22 ~22:05 EST**: Hit Gotcha 1 (stale DB) — fixed in ~2 min
- **2026-02-22 ~22:07 EST**: Cutover Phase 2 (assistant swap), save state
- **2026-02-22 ~22:08 EST**: First session from KKit-BMO
- **2026-02-22 ~22:08 EST**: Hit Gotcha 2 (main.js vs bootstrap.js) — fixed in ~1 min
- **2026-02-22 ~22:09 EST**: Hit Gotcha 3 (voice ENOENT) — fixed in ~1 min
- **2026-02-22 ~22:11 EST**: Daemon fully operational with extension + 19 scheduler tasks

Total cutover time: ~40 minutes including debugging.
