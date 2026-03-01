# Kithkit Architecture

Kithkit is built as three cooperating layers: a **CLI** for initialization, a **daemon** for persistent state and services, and a **Claude Code layer** for the agent's identity and skills. Understanding this separation makes it straightforward to extend, debug, or replace any part.

## Overview

```
Human ←→ Comms Agent ←→ Daemon ←→ Workers
              ↕            ↕
          Identity      SQLite DB
```

The **comms agent** is a Claude Code session that serves as the human-facing interface. It reads from and writes to the **daemon** (a local HTTP server) for all persistent state — todos, calendar events, memories, config. When the comms agent encounters a task requiring specialized capabilities, it spawns **workers** through the daemon's agent lifecycle API.

## Data Flow

```
User
 │  Telegram message / terminal input
 ▼
Comms Agent (Claude Code session)
 │  Tool calls to daemon API
 ▼
Daemon (localhost:3847)
 │  Reads/writes SQLite
 │  Injects prompt into tmux pane (session bridge)
 ▼
Claude Code session resumes
 │  Tool use, file edits, Bash commands
 ▼
Transcript stream (JSONL file)
 │  Daemon watches for assistant output
 ▼
Channel router → Telegram / email / stdout
```

The daemon never reads user intent directly. Instead, it injects prompts into the Claude Code tmux pane via the session bridge, and watches the JSONL transcript for outgoing messages to forward through the channel router.

---

## Layer 1: CLI (`cli/`)

The CLI is the user-facing entry point for project initialization and package management.

```
cli/
└── src/
    ├── index.ts          # CLI entry point (npx kithkit <command>)
    ├── init.ts           # Init wizard (name, template, file generation)
    ├── install.ts        # Install skills from catalog
    ├── search.ts         # Search the Kithkit catalog
    ├── update.ts         # Update installed skills
    └── prerequisites.ts  # Prerequisite checks (Node.js, tmux, jq, etc.)
```

**`npx kithkit init`** runs the wizard, prompts for agent name and personality template, and writes:
- `kithkit.config.yaml` — user config (merged over defaults)
- `identity.md` — agent personality and system prompt
- `.claude/agents/` — built-in worker profiles (copied from `profiles/`)
- `.claude/CLAUDE.md` — framework manual

**`npx kithkit install <package>`** fetches skills from the Kithkit catalog and installs them into `.claude/skills/`.

---

## Layer 2: Daemon (`daemon/`)

The daemon is a persistent Node.js HTTP server (`127.0.0.1:<port>`, default 3847) that manages all agent state and background services. It starts via `scripts/start-tmux.sh` (which launches both the daemon and a Claude Code session in tmux).

**Entry point**: Agent repos should use a `bootstrap.ts` file as the daemon entry point (not `main.ts` directly). `bootstrap.ts` calls `registerExtension()` before importing `main.ts`. Running `main.ts` directly starts a bare daemon with no extension — no scheduler tasks, no communication channels, no personality. The daemon logs a warning at startup when no extension is registered.

```
daemon/src/
├── main.ts              # Core daemon — server, route dispatch (bare without extension)
├── core/                # Foundation services
├── api/                 # HTTP route handlers
├── agents/              # Worker lifecycle
├── comms/               # Channel delivery
├── memory/              # Structured and vector memory
└── automation/          # Scheduler and tasks
```

### Core (`daemon/src/core/`)

Foundation services used across all other modules.

| File | Purpose |
|------|---------|
| `config.ts` | Load and deep-merge `kithkit.config.yaml` with `kithkit.defaults.yaml` |
| `config-watcher.ts` | Watch config file for changes; hot-reload via `POST /api/config/reload` |
| `db.ts` | Open SQLite (`kithkit.db`), run migrations, export typed query helpers |
| `migrations.ts` | Run schema migrations from `core/migrations/` in order |
| `logger.ts` | Structured logger with log rotation and configurable min level |
| `health.ts` | Basic health snapshot (uptime, version, timestamp) for `GET /health` |
| `extended-status.ts` | Extended health checks + operational status for `GET /status/extended` |
| `keychain.ts` | macOS Keychain read/write via `security` CLI |
| `session-bridge.ts` | tmux interaction — check busy state, inject text, capture pane output |
| `context-loader.ts` | Load structured recent activity (todos, calendar, memories) for session startup |
| `route-registry.ts` | Register and dispatch custom HTTP routes for extensions |
| `extensions.ts` | Extension lifecycle hooks (onInit, onRoute, onShutdown) |
| `access-control.ts` | Request authorization rules |
| `claude-api.ts` | Lightweight Anthropic Messages API client for in-process tasks |

**Config merging**: `kithkit.defaults.yaml` provides framework defaults. `kithkit.config.yaml` overrides them with deep merge. Agent repos should only set values they need to change.

**Session bridge**: Provides the tmux interface — checking whether Claude is busy (by looking for the prompt character), injecting text into a pane, and capturing pane output for context.

**Context loader**: Queries the DB for active todos, recent config decisions, in-progress items, upcoming calendar events, and recent memories. Returns a `ContextSummary` within a configurable character budget (default 8,000 characters). Extensions can register filters to augment or trim the context.

**Route registry**: Extensions call `registerRoute(pattern, handler)` to add custom HTTP endpoints. Patterns can be exact paths (`/my-ext/status`) or prefix wildcards (`/my-ext/*`). Routes are checked in registration order before the 404 fallback.

**Extended status**: Aggregates DB stats, scheduler results, and custom health checks into `GET /status/extended`. Extensions call `registerCheck(name, fn)` to add their own health checks.

### API (`daemon/src/api/`)

HTTP route handlers, one file per domain area. `main.ts` dispatches to these based on path prefix.

| File | Paths handled |
|------|--------------|
| `state.ts` | `/api/todos`, `/api/calendar`, `/api/config`, `/api/feature-state`, `/api/context` |
| `memory.ts` | `/api/memory/store`, `/api/memory/search`, `/api/memory/:id` |
| `agents.ts` | `/api/agents/spawn`, `/api/agents`, `/api/agents/:id` |
| `messages.ts` | `/api/messages` |
| `send.ts` | `/api/send` |
| `tasks.ts` | `/api/tasks`, `/api/tasks/:name/run`, `/api/tasks/:name/history` |
| `config.ts` | `/api/config/reload` |

All responses include a `timestamp` field (ISO 8601). Invalid JSON bodies return `400 { error: "Invalid JSON" }`.

### Agents (`daemon/src/agents/`)

Worker lifecycle management.

| File | Purpose |
|------|---------|
| `profiles.ts` | Load and validate `.claude/agents/*.md` (YAML frontmatter + body) |
| `lifecycle.ts` | Spawn workers via the Claude Code Agent SDK |
| `sdk-adapter.ts` | Translate daemon spawn requests to SDK calls |
| `identity.ts` | Load and apply agent identity from `identity.md` |
| `recovery.ts` | Detect and recover from worker crashes and hangs |
| `message-router.ts` | Route inter-agent messages between comms agent and workers |

Workers are ephemeral — they spawn for a task and terminate. The daemon tracks active workers in `kithkit.db` (the `agents` table) with their status, profile, PID, and activity timestamps.

### Comms (`daemon/src/comms/`)

Channel delivery for outgoing messages.

| File | Purpose |
|------|---------|
| `channel-router.ts` | Route outgoing messages to the active channel adapter(s) |
| `adapter.ts` | Channel adapter interface (Telegram, email, stdout, etc.) |

The channel router reads channel configuration from `kithkit.config.yaml` and forwards messages to all enabled channel adapters. Adapters are installed separately (see `docs/recipes/` for Telegram, email, and other channels).

### Memory (`daemon/src/memory/`)

Structured and semantic memory storage.

| File | Purpose |
|------|---------|
| `embeddings.ts` | Generate vector embeddings via all-MiniLM-L6-v2 |
| `vector-search.ts` | Semantic similarity search using sqlite-vec |

Three search modes are supported:
- **keyword** — AND-matching on query words, OR-matching on tags, exact-match on category
- **vector** — semantic similarity via embeddings (requires sqlite-vec)
- **hybrid** — combines keyword and vector results

### Automation (`daemon/src/automation/`)

Background task scheduling.

| File | Purpose |
|------|---------|
| `scheduler.ts` | Cron/interval task runner with idle detection and session checks |
| `task-runner.ts` | Subprocess execution with timeout and result capture |
| `tasks/` | Built-in in-process task handlers |

**Scheduler**: Reads task definitions from `kithkit.config.yaml`. Each task has either a `cron` expression or an `interval` (e.g., `"15m"`, `"1h"`). Tasks can be flagged `idle_only: true` to skip when the agent is actively in conversation, or `requires_session: true` to skip when no tmux session exists.

**Built-in tasks**:

| Task | Schedule | Purpose |
|------|----------|---------|
| `context-watchdog` | Every 3m | Warn at 50% context usage; prompt restart at 65% |
| `todo-reminder` | Every 30m | Prompt agent to work on open todos |
| `approval-audit` | 1st of month, 9am | Review and prune 3rd-party sender approvals |
| `backup` | Sunday 3am | Zip and verify backup of state and database |

Extensions add more tasks by registering handlers — see [Extensions](extensions.md).

---

## Layer 3: Claude Code Layer (`.claude/`)

The Claude Code layer defines the agent's identity, skills, and behavioral hooks.

```
.claude/
├── CLAUDE.md            # Framework manual (loaded as project instructions)
├── settings.json        # Claude Code settings (tools, permissions, hooks)
├── agents/              # Worker profiles (loaded by daemon/agents/profiles.ts)
│   ├── research.md
│   ├── coding.md
│   └── ...
├── skills/              # Installed skills (each has a SKILL.md)
│   └── <skill-name>/
│       ├── SKILL.md     # Skill instructions (autoContext frontmatter)
│       └── ...
├── hooks/               # Event hooks (bash scripts)
│   ├── session-start.sh
│   ├── pre-build.sh
│   └── ...
└── state/               # Persistent agent state (not committed)
    ├── identity.json
    ├── autonomy.json
    ├── todos/
    ├── memory/
    └── calendar.md
```

### Skills

Skills live in `.claude/skills/<name>/SKILL.md`. The YAML frontmatter can include `autoContext` rules that tell Claude Code when to load the skill automatically (e.g., when the user mentions a keyword).

Skills are invoked by the comms agent (either automatically via autoContext, or explicitly via `/command`). They can call daemon API endpoints, spawn workers, and interact with external services.

### Hooks

Hooks are bash scripts in `.claude/hooks/` that run at specific points in the Claude Code lifecycle:

| Hook | When it runs |
|------|-------------|
| `memory-extraction.sh` | On session stop — extracts and stores memories from the conversation |
| `pre-build.sh` | Before build commands — safety checks |
| `pre-compact.sh` | Before context compaction — saves work state |
| `set-channel.sh` | On user prompt submit — configures the active communication channel |

Hooks are configured in `.claude/settings.json`.

### Status Line

The `statusLine` setting in `.claude/settings.json` must point to the context monitor script for the context watchdog to function:

```json
{
  "statusLine": {
    "type": "command",
    "command": "\"$CLAUDE_PROJECT_DIR\"/scripts/context-monitor-statusline.sh"
  }
}
```

This script writes context usage data to `.claude/state/context-usage.json` (and `-orch.json` / `-other.json` for orchestrator/worker sessions). The `context-watchdog` scheduler task reads these files to issue proactive warnings before context limits are hit.

### State Files

Kithkit uses two layers of state persistence:

**Database state** (in `kithkit.db` via daemon API):

| Table | Purpose |
|-------|---------|
| `todos` / `todo_actions` | Todos with full action history audit trail |
| `memories` | Facts, decisions, episodic memories (with optional vector embeddings) |
| `calendar` | Scheduled events, reminders, deadlines |
| `messages` | Inter-agent message log |
| `agents` / `worker_jobs` | Agent registry and worker job tracking |
| `config` / `feature_state` | Runtime config overrides and per-feature state |
| `task_results` | Scheduler task execution history |

**File state** (in `.claude/state/`, persists across sessions):

| File/Dir | Purpose |
|----------|---------|
| `autonomy.json` | Current autonomy mode (yolo / confident / cautious / supervised) |
| `channel.txt` | Active channel (`telegram`, `silent`, etc.) |
| `assistant-state.md` | Saved work context (written before restart, read on resume) |
| `safe-senders.json` | Trusted contacts for message authentication |

---

## Config: kithkit.config.yaml

All daemon behavior is controlled by a single YAML file. The framework ships `kithkit.defaults.yaml` with safe defaults; your `kithkit.config.yaml` overrides specific values.

```yaml
# kithkit.config.yaml
agent:
  name: Atlas                   # Agent name (shown in status, logs)
  identity_file: identity.md    # Path to system prompt file

daemon:
  port: 3847                    # HTTP port (localhost only)
  log_level: info               # debug | info | warn | error
  log_dir: logs

scheduler:
  tasks:
    - name: context-watchdog
      interval: "3m"
      enabled: true
      config:
        requires_session: true

    - name: my-custom-task      # Custom task (handler registered by extension)
      interval: "1h"
      enabled: true

security:
  rate_limits:
    incoming_max_per_minute: 5
    outgoing_max_per_minute: 10
```

**Config hot-reload**: Change the config file and POST to `/api/config/reload`. The scheduler re-reads task definitions (adds new, removes deleted, updates changed) without restarting the daemon. Running tasks are not interrupted.

---

## Scripts

The `scripts/` directory provides session management and operational utilities.

### Session Management

| Script | Purpose |
|--------|---------|
| `start-tmux.sh` | Start or attach to the persistent tmux session; `--detach` for background |
| `start.sh` | Start Claude Code directly (called by tmux session) |
| `restart.sh` | Graceful restart — save state, signal restart-watcher |
| `watchdog.sh` | Auto-restart Claude on unexpected exit (used in detached mode) |
| `attach.sh` | Attach to existing tmux session |

### Operations

| Script | Purpose |
|--------|---------|
| `health.sh` | Color health check; `--watch` to poll every 10s |
| `dashboard.sh` | Live ops dashboard (tasks, usage, memory counts) |
| `backup.sh` | Manual backup of state and database |
| `repo-audit.sh` | Audit repository for uncommitted changes |
| `context-monitor-statusline.sh` | Write context usage JSON for the watchdog and tmux status bar |
| `daemon-smoke-test.sh` | Integration smoke test against running daemon |

### Shared Library

`scripts/lib/config.sh` provides bash helpers used by all scripts:
- `read_config` — read a value from `kithkit.config.yaml` via `yq` or `python3`
- `get_agent_name` — read agent name from config
- `session_exists` — check if the tmux session is running
- `claude_alive` — check if Claude Code is the active process in the session

---

## Extension Model

Extensions let agent repos add custom routes, tasks, and health checks without modifying the framework. One extension is registered per daemon instance; the extension aggregates sub-modules internally.

See [Extensions](extensions.md) for a complete authoring guide.

**Extension hooks**:

| Hook | When called | Purpose |
|------|-------------|---------|
| `onInit(config, server)` | After server starts listening | Register routes, tasks, adapters |
| `onRoute(req, res, pathname, searchParams)` | Each HTTP request (before 404) | Handle custom endpoints |
| `onShutdown()` | Before server closes | Clean up connections, flush buffers |

**Registration APIs** (imported from `kithkit/daemon`):

```typescript
import { registerExtension } from 'kithkit/daemon';
import { registerRoute } from 'kithkit/daemon/core/route-registry';
import { registerCheck } from 'kithkit/daemon/core/extended-status';
// Scheduler.registerHandler() is called on the scheduler instance passed via config
```
