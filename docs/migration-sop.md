# Kithkit Migration SOP

Standard operating procedure for migrating a CC4Me agent to a Kithkit instance.
Written by BMO during the CC4Me-BMO → KKit-BMO cutover (2026-02-22).

**Audience**: R2, Marvho, and any future agent doing this migration.

---

## Overview

Kithkit is the successor framework to CC4Me. Migration involves:
1. Cloning the private KKit repo and configuring it for your agent
2. Writing your agent extension (`bootstrap.ts` + extension code)
3. Building the daemon
4. Cutting over launchd plists from the old repo to the new one
5. Verifying everything works
6. Rebuilding integrations (Telegram, email, voice, A2A) fresh — **not** porting old code

**Key differences from CC4Me:**
- Config file: `cc4me.config.yaml` → `kithkit.config.yaml`
- Entry point: `daemon/dist/core/main.js` → `daemon/dist/bootstrap.js`
- All state in SQLite (`kithkit.db`) — no flat-file state except `assistant-state.md`
- Extensions register via `bootstrap.ts` before `main.ts` runs
- Three-tier architecture: comms agent → orchestrator → workers (via daemon API)

---

## Pre-Migration Checklist

Work through every item before touching launchd. Do this while your old CC4Me instance is still running.

### 1. Clone and configure the repo

```bash
# Clone your private KKit repo
git clone git@github.com:RockaRhymeLLC/KKit-<AGENT>.git ~/KKit-<AGENT>
cd ~/KKit-<AGENT>
```

### 2. Create your config file

Copy `kithkit.defaults.yaml` as a starting point and customize:

```bash
cp kithkit.defaults.yaml kithkit.config.yaml
```

Required settings:
```yaml
agent:
  name: "YourAgentName"
  identity_file: "identity.md"

tmux:
  session: "youragent"     # tmux session name (lowercase, no spaces)

daemon:
  port: 3847               # pick a port that doesn't conflict
  log_level: "info"
  log_dir: "logs"
```

**Important**: Start with integrations disabled. Enable them one at a time after cutover:
```yaml
channels:
  telegram:
    enabled: false   # Enable after webhook is configured
  email:
    enabled: false   # Enable after keychain entries are verified
  voice:
    enabled: false   # Enable ONLY after Python venv is built (see Gotcha 3)
```

### 3. Identity file

Put your identity at `identity.md` in the repo root. This is your personality/behavioral instructions for the comms agent.

### 4. Write your agent extension

Every KKit instance needs a `bootstrap.ts` that registers the agent extension before importing main. Here's the pattern:

**`daemon/src/bootstrap.ts`:**
```typescript
import { registerExtension } from './core/extensions.js';
import { myExtension } from './extensions/index.js';

// Register extension before daemon starts
registerExtension(myExtension);

// This triggers the daemon bootstrap
await import('./main.js');
```

Your extension in `daemon/src/extensions/index.ts` must export an object implementing the extension interface with `onInit`, `onShutdown`, and route/task registration. Reference BMO's extension as a template.

**Extension initialization order matters:**
1. Communication adapters (Telegram, email)
2. Agent-to-agent comms
3. Network/relay registration
4. Voice (if enabled — only after venv exists)
5. Route registration
6. Scheduler tasks: `registerCoreTasks()` **then** your agent-specific tasks
7. Access control
8. Health checks

### 5. Build and verify daemon

```bash
cd ~/KKit-<AGENT>
npm install
npm run build

# Test manually — Ctrl-C to stop
node daemon/dist/bootstrap.js .
# Confirm: curl http://localhost:<port>/health
# Should show: {"status":"ok","extension":"<your-agent-name>"}
# The "extension" field MUST NOT be null — see Gotcha 2 if it is
```

### 6. Create required directories

```bash
mkdir -p ~/KKit-<AGENT>/logs
mkdir -p ~/KKit-<AGENT>/projects
```

### 7. Delete any stale test database

If you did test builds, a `kithkit.db` may exist with an empty migrations table. This **will** crash the daemon on real startup (see Gotcha 1).

```bash
rm -f ~/KKit-<AGENT>/kithkit.db*
```

### 8. Set up Claude Code project memory

Claude Code stores project-specific memory in a path derived from the working directory:

```bash
# The path uses dashes instead of slashes
mkdir -p ~/.claude/projects/-Users-<user>-KKit-<AGENT>/memory/

# Create MEMORY.md with context ported from old repo
# Include: repo context, architecture notes, known issues, user preferences
```

**Tip**: Don't copy your old MEMORY.md verbatim. Review it and update paths, repo names, and any CC4Me-specific references.

### 9. Prepare launchd plists

You need 3 plists. Copy from the old ones and update all paths.

#### Daemon plist (`com.<agent>.daemon.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.assistant.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <!-- CRITICAL: Must be bootstrap.js, NOT main.js — see Gotcha 2 -->
        <string>/Users/<user>/KKit-<AGENT>/daemon/dist/bootstrap.js</string>
        <string>/Users/<user>/KKit-<AGENT></string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/<user>/KKit-<AGENT></string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/<user></string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/<user>/KKit-<AGENT>/logs/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<user>/KKit-<AGENT>/logs/daemon-stderr.log</string>
</dict>
</plist>
```

#### Assistant plist (`com.assistant.<agent>.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.assistant.<agent></string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/<user>/KKit-<AGENT>/scripts/start-tmux.sh</string>
        <string>--detach</string>
        <string>--skip-permissions</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/<user>/KKit-<AGENT></string>
    <key>RunAtLoad</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <!-- Include .local/bin for claude binary -->
        <string>/Users/<user>/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/<user></string>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/Users/<user>/.claude/logs/assistant.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<user>/.claude/logs/assistant.error.log</string>
</dict>
</plist>
```

**Note**: The assistant plist includes `~/.local/bin` in PATH (for the `claude` binary). The daemon plist does NOT — this is intentional. The daemon doesn't need `claude` in its own PATH; the orchestrator spawner uses the full path `~/.local/bin/claude`.

#### Restart watcher plist (`com.<agent>.restart-watcher.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.<agent>.restart-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/<user>/KKit-<AGENT>/scripts/restart-watcher.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/<user>/KKit-<AGENT></string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/<user>/KKit-<AGENT>/logs/restart-watcher.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<user>/KKit-<AGENT>/logs/restart-watcher-error.log</string>
</dict>
</plist>
```

### 10. Verify keychain entries

Check that all required keychain entries exist **before** cutover. Names must match exactly — mismatches cause silent failures.

```bash
# Test each credential (will print the value or error)
security find-generic-password -s "credential-telegram-bot" -w
security find-generic-password -s "credential-telegram-chat-id" -w
security find-generic-password -s "credential-azure-client-id" -w
security find-generic-password -s "credential-azure-tenant-id" -w
security find-generic-password -s "credential-azure-secret-value" -w
security find-generic-password -s "credential-graph-user-email" -w     # NOT credential-azure-user-email
security find-generic-password -s "credential-agent-comms-secret" -w
```

**Common keychain mismatches** (see Gotcha 5):
- Telegram: adapter reads `credential-telegram-bot`, NOT `credential-telegram-bot-token`
- Email: adapter reads `credential-graph-user-email`, NOT `credential-azure-user-email`

### 11. Save comms agent state

Before cutover, make sure the comms agent saves its current state:
```bash
# From the comms tmux session, or trigger via the save-state skill
# This writes assistant-state.md with pending work context
```

---

## Cutover Procedure

**Estimated time**: 15–20 minutes (40 minutes if you hit gotchas, which you shouldn't if you followed the checklist).

### Phase 1: Stop old services

```bash
# Stop old daemon and restart-watcher
launchctl unload ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist

# Verify they stopped
launchctl list | grep -i <agent>
# The assistant session should still be listed — we stop it in Phase 3
```

### Phase 2: Backup and install new plists

```bash
# Backup old plists (keep as rollback option)
mkdir -p ~/KKit-<AGENT>/.cutover-backup
cp ~/Library/LaunchAgents/com.<agent>.*.plist ~/KKit-<AGENT>/.cutover-backup/
cp ~/Library/LaunchAgents/com.assistant.<agent>.plist ~/KKit-<AGENT>/.cutover-backup/
date > ~/KKit-<AGENT>/.cutover-backup/timestamp.txt

# Install new plists (overwrite old ones)
cp ~/KKit-<AGENT>/launchd/*.plist ~/Library/LaunchAgents/
# Or copy them individually if you don't have a launchd/ directory:
# cp <your-prepared-plists> ~/Library/LaunchAgents/
```

### Phase 3: Start new daemon

```bash
# Start new daemon + restart watcher
launchctl load ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl load ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist

# Wait 2-3 seconds for daemon to initialize, then verify
sleep 3
curl -s http://localhost:<port>/health | python3 -m json.tool

# Expected output:
# {
#     "status": "ok",
#     "extension": "<agent-name>",    ← MUST NOT be null
#     "uptime": <seconds>
# }
```

**If `extension` is null**: You hit Gotcha 2. Stop immediately, fix the plist entry point, and restart the daemon.

### Phase 4: Swap assistant session

```bash
# Stop old comms agent
launchctl unload ~/Library/LaunchAgents/com.assistant.<agent>.plist

# Install new assistant plist (already done in Phase 2 if you copied all plists)
# Start new comms agent
launchctl load ~/Library/LaunchAgents/com.assistant.<agent>.plist

# Verify tmux session started
tmux list-sessions
# Should show: <agent-name>: 1 windows ...
```

### Phase 5: Verify new session

Attach to the new tmux session and confirm the comms agent is alive:
```bash
tmux attach -t <session-name>
```

The comms agent should start up in the KKit repo directory. Check that it can reach the daemon:
```
curl localhost:<port>/health
```

---

## Post-Migration Verification

Run through this checklist after cutover. Every item must pass.

### Core (required)

- [ ] **Daemon health**: `curl http://localhost:<port>/health` → `{"status":"ok","extension":"<name>"}`
- [ ] **Extension loaded**: health response `extension` field is NOT null
- [ ] **Identity loaded**: `curl http://localhost:<port>/status` → shows agent name
- [ ] **Scheduler tasks**: `curl http://localhost:<port>/api/tasks` → lists configured tasks
- [ ] **Database created**: `ls -la ~/KKit-<AGENT>/kithkit.db` → file exists
- [ ] **Logs writing**: `ls ~/KKit-<AGENT>/logs/` → daemon-stdout.log, daemon-stderr.log present
- [ ] **Tmux session**: `tmux list-sessions` → shows agent session
- [ ] **Working directory**: comms agent pwd is `~/KKit-<AGENT>/`
- [ ] **Old repo untouched**: `~/CC4Me-<AGENT>/` still exists as reference (don't delete yet)

### Integrations (rebuild one at a time)

Follow `docs/integration-setup.md` for detailed steps on each integration. Order:

1. **Telegram** — set webhook URL to current hostname, test send/receive
2. **Email** — verify keychain entries, test Graph token acquisition, test himalaya
3. **Agent-to-agent comms** — configure peers, test ping
4. **Voice** — build Python venv first, then enable in config (see integration guide)
5. **Browser** — configure Browserbase or local Playwright

Enable each in `kithkit.config.yaml` and hot-reload:
```bash
curl -s -X POST http://localhost:<port>/api/config/reload
```

Or restart daemon:
```bash
launchctl kickstart -k gui/$(id -u)/com.assistant.daemon
```

### Integration verification checklist

- [ ] Telegram send test succeeds
- [ ] Telegram webhook set to current hostname (not old CC4Me domain)
- [ ] Telegram webhook receives messages (check daemon logs)
- [ ] Graph email adapter shows "enabled" in logs
- [ ] Himalaya adapter shows "enabled" in logs (if configured)
- [ ] Agent-comms peer ping succeeds
- [ ] Voice TTS/STT tests pass (see integration guide)

---

## Gotchas & Lessons Learned

These are real issues we hit during the BMO migration. Read all of them before starting.

### GOTCHA 1: Stale test database crashes daemon

**Symptom**: `SqliteError: table memories already exists` — daemon crash loop on startup.

**Cause**: A `kithkit.db` from testing has tables created but an empty migrations table. The daemon runs migrations, finds the table already exists, and dies.

**Fix**: Delete `kithkit.db` (and WAL/SHM files) before first real start:
```bash
rm -f ~/KKit-<AGENT>/kithkit.db*
```

**Prevention**: Step 7 in the pre-migration checklist covers this. Always delete any test databases before cutover.

### GOTCHA 2: Daemon plist must point to bootstrap.js, NOT main.js

**Symptom**: Daemon starts and health check returns OK, but `"extension": null`. No scheduler tasks, no Telegram, no integrations — a bare daemon with nothing loaded.

**Cause**: The plist `ProgramArguments` points to `daemon/dist/main.js` (or the old CC4Me path `daemon/dist/core/main.js`) instead of `daemon/dist/bootstrap.js`.

**Why it matters**: `bootstrap.ts` calls `registerExtension()` before importing `main.ts`. Without it, the daemon starts but has no idea your extension exists. There is no error message — it just silently runs without your agent code.

**Fix**: The plist must use `bootstrap.js`:
```xml
<key>ProgramArguments</key>
<array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/<user>/KKit-<AGENT>/daemon/dist/bootstrap.js</string>
    <string>/Users/<user>/KKit-<AGENT></string>
</array>
```

**How to detect**: If `curl localhost:<port>/health` returns `"extension": null`, this is the problem.

### GOTCHA 3: Voice extension crashes daemon if Python venv is missing

**Symptom**: `Error: spawn .../voice/.venv/bin/python3 ENOENT` — daemon crash loop (KeepAlive restarts it, it crashes again).

**Cause**: Voice is enabled in config (`channels.voice.enabled: true`) but the Python virtual environment at `daemon/src/extensions/voice/.venv/` doesn't exist. The voice init spawns a Python child process and the ENOENT error is unhandled.

**Fix (immediate)**: Disable voice in config until the venv is ready:
```yaml
channels:
  voice:
    enabled: false  # Enable after setting up voice venv
```

**Fix (proper)**: Build the venv before enabling voice. See `docs/integration-setup.md` § Voice for full instructions:
```bash
python3.12 -m venv daemon/src/extensions/voice/.venv
daemon/src/extensions/voice/.venv/bin/pip install kokoro-onnx numpy
```

**Prevention**: The pre-migration config template above starts with voice disabled. Only enable after the venv is built and tested.

### GOTCHA 4: Core scheduler tasks not registered

**Symptom**: Scheduler tasks appear in `GET /api/tasks` but core handlers (context-watchdog, todo-reminder, etc.) never execute — they have no registered handler function.

**Cause**: `registerCoreTasks()` exists in `daemon/src/automation/tasks/index.ts` but must be called explicitly by the extension's `onInit`. It is NOT called automatically by the daemon.

**Fix**: In your extension's `onInit`, call core tasks first, then your own:
```typescript
registerCoreTasks(scheduler);   // Core handlers (context-watchdog, todo-reminder, etc.)
registerMyAgentTasks(scheduler); // Your agent-specific tasks
```

### GOTCHA 5: Keychain credential name mismatches

**Symptom**: Integration adapter silently fails — no error, just doesn't work. Telegram sends fail, Graph email shows "not configured."

**Cause**: The daemon's adapter code reads specific keychain service names. If your keychain entries use different names (carried over from CC4Me or set up manually), the adapter can't find them.

**Known mismatches**:

| What the adapter reads | Common wrong name |
|---|---|
| `credential-telegram-bot` | `credential-telegram-bot-token` |
| `credential-graph-user-email` | `credential-azure-user-email` |
| `credential-agent-comms-secret` | `credential-a2a-secret` |

**Fix**: Rename keychain entries to match what the adapter expects, or add new entries with the correct names:
```bash
# Add a new entry (doesn't affect old one)
security add-generic-password -s "credential-telegram-bot" -a "$(whoami)" -w "YOUR_TOKEN"
```

**Prevention**: Step 10 in the pre-migration checklist verifies all keychain entries.

### GOTCHA 6: Webhook URLs still pointing to old hostname

**Symptom**: Telegram webhook verification works, but incoming messages never reach the daemon.

**Cause**: The Telegram webhook URL still points to the old CC4Me hostname/tunnel. The URL is stored on Telegram's servers and doesn't change just because you migrated.

**Fix**: Re-set the webhook URL after migration:
```bash
TOKEN=$(security find-generic-password -s "credential-telegram-bot" -w)
curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -d "url=https://YOUR_CURRENT_HOSTNAME/telegram" \
  -d 'allowed_updates=["message","message_reaction"]'
```

**Verify**: `curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"` should show the new URL and `pending_update_count: 0` after a test message.

### GOTCHA 7: Tmux session name conflicts

**Symptom**: `start-tmux.sh` says session already exists but claude isn't running, or attaches to the wrong session.

**Cause**: Your `kithkit.config.yaml` `tmux.session` value matches an existing tmux session from the old CC4Me install (or another agent).

**Fix**: Kill the stale session before starting:
```bash
tmux kill-session -t <old-session-name>
```

Or use a different session name in your config. The session name should be unique per agent.

---

## Rollback Procedure

If something goes badly wrong during cutover and you need to get back to CC4Me:

```bash
# Stop new services
launchctl unload ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl unload ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist
launchctl unload ~/Library/LaunchAgents/com.assistant.<agent>.plist

# Restore old plists from backup
cp ~/KKit-<AGENT>/.cutover-backup/*.plist ~/Library/LaunchAgents/

# Start old services
launchctl load ~/Library/LaunchAgents/com.<agent>.daemon.plist
launchctl load ~/Library/LaunchAgents/com.<agent>.restart-watcher.plist
launchctl load ~/Library/LaunchAgents/com.assistant.<agent>.plist

# Verify old daemon is running
curl http://localhost:<port>/health
```

**Important**: If you already re-set webhook URLs (Telegram, etc.), you'll need to set them back to the old hostname.

---

## Post-Cutover: Rebuilding Integrations

Integrations are rebuilt fresh, not ported. Use your old `CC4Me-<AGENT>/` repo as reference material only.

Follow `docs/integration-setup.md` for detailed step-by-step instructions. Summary:

| Integration | Key steps | Config key |
|---|---|---|
| **Telegram** | Verify keychain, set webhook URL, test send/receive | `channels.telegram` |
| **Email (Graph)** | Verify Azure keychain entries, test token acquisition | `channels.email.providers[type=graph]` |
| **Email (Himalaya)** | Configure `~/.config/himalaya/config.toml`, test CLI | `channels.email.providers[type=himalaya]` |
| **Agent-comms** | Configure peers in config, test ping | `agent-comms` |
| **Voice** | Build Python venv, install models, then enable in config | `channels.voice` |
| **Browser** | Configure Browserbase credentials or local Playwright | `integrations.browserbase` |

Enable each integration one at a time. Test it. Then move to the next. Hot-reload config after each change:
```bash
curl -s -X POST http://localhost:<port>/api/config/reload
```

---

## Upstream Issues for Kithkit (to file/fix in public repo)

| # | Issue | Severity | File(s) |
|---|-------|----------|---------|
| 1 | Migration runner doesn't handle pre-existing tables | Medium | `daemon/src/core/migrations.ts` |
| 2 | Documentation says `main.js` but extensions need `bootstrap.js` | High | docs, example plists |
| 3 | Voice extension ENOENT crash (unhandled child process error) | Critical | `daemon/src/extensions/voice/` |
| 4 | Core scheduler tasks never registered automatically | Medium | `daemon/src/automation/tasks/index.ts`, extension init |

---

## Timeline (BMO's actual migration)

For reference — this is how long it took us, including debugging:

| Time (EST) | Event |
|---|---|
| 2026-02-22 ~21:30 | Pre-move prep (steps 1–11) |
| 2026-02-22 ~22:00 | Cutover Phase 1 — daemon swap |
| 2026-02-22 ~22:05 | Hit Gotcha 1 (stale DB) — fixed in ~2 min |
| 2026-02-22 ~22:07 | Cutover Phase 2 — assistant swap, save state |
| 2026-02-22 ~22:08 | First session from KKit-BMO |
| 2026-02-22 ~22:08 | Hit Gotcha 2 (main.js vs bootstrap.js) — fixed in ~1 min |
| 2026-02-22 ~22:09 | Hit Gotcha 3 (voice ENOENT) — fixed in ~1 min |
| 2026-02-22 ~22:11 | Daemon fully operational with extension + 19 scheduler tasks |

**Total cutover time**: ~40 minutes including debugging. With this SOP, expect 15–20 minutes.

---

## Quick Reference Card

For agents who want a tl;dr after reading the full doc once:

```
PRE-FLIGHT:
  □ kithkit.config.yaml created (voice DISABLED)
  □ identity.md in repo root
  □ npm install && npm run build
  □ node daemon/dist/bootstrap.js . → health shows extension != null
  □ rm -f kithkit.db*
  □ Keychain entries verified (exact names!)
  □ New plists prepared (bootstrap.js, not main.js)
  □ mkdir -p logs projects

CUTOVER:
  1. launchctl unload old daemon + watcher
  2. Backup old plists to .cutover-backup/
  3. Install new plists
  4. launchctl load new daemon + watcher
  5. Verify: curl health → extension != null
  6. launchctl unload/load assistant plist
  7. Attach to tmux, verify comms agent

POST-CUTOVER:
  □ Enable integrations one at a time (see docs/integration-setup.md)
  □ Re-set Telegram webhook URL
  □ Test each integration before enabling the next
  □ Keep CC4Me-<AGENT>/ as reference (don't delete)
```
