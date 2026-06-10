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
- `.kithkit/agents/` — built-in worker profiles (copied from `profiles/`)
- `.kithkit/CLAUDE.md` — framework manual

**`npx kithkit install <package>`** fetches skills from the Kithkit catalog and installs them into `.kithkit/skills/`.

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
| `agents.ts` | `/api/agents/spawn`, `/api/agents`, `/api/agents/:id`, `/api/agents/:id/activity` |
| `messages.ts` | `/api/messages` |
| `send.ts` | `/api/send` |
| `tasks.ts` | `/api/scheduler/tasks`, `/api/scheduler/tasks/:name/run`, `/api/scheduler/tasks/:name/history` |
| `config.ts` | `/api/config/reload` |
| `approval.ts` | `/api/approval/decision`, `/api/approval/pending` |
| `contacts.ts` | `/api/contacts`, `/api/contacts/:id`, `/api/contacts/search` |
| `email.ts` | `/api/email/inbox`, `/api/email/inbox/search` |
| `metrics.ts` | `/api/metrics`, `/api/metrics/ingest` |
| `orchestrator.ts` | `/api/orchestrator/escalate`, `/api/orchestrator/status`, `/api/orchestrator/shutdown` |
| `task-queue.ts` | `/api/orchestrator/tasks`, `/api/orchestrator/tasks/:id`, `/api/orchestrator/tasks/:id/activity`, `/api/orchestrator/tasks/:id/workers` |
| `unified-tasks.ts` | `/api/tasks`, `/api/tasks/:id` |
| `selftest.ts` | `/api/selftest` |
| `sync-claude.ts` | `/api/sync/claude` |
| `timer.ts` | `/api/timer`, `/api/timers` |
| `self-improvement.ts` | `/api/self-improvement/stats` |

All responses include a `timestamp` field (ISO 8601). Invalid JSON bodies return `400 { error: "Invalid JSON" }`.

`helpers.ts` and `rate-limit.ts` are shared utilities — they do not register routes directly.

### Agents (`daemon/src/agents/`)

Worker lifecycle management.

| File | Purpose |
|------|---------|
| `profiles.ts` | Load and validate `.kithkit/agents/*.md` (YAML frontmatter + body) |
| `lifecycle.ts` | Spawn workers via the Claude Code Agent SDK |
| `sdk-adapter.ts` | Translate daemon spawn requests to SDK calls |
| `identity.ts` | Load and apply agent identity from `identity.md` |
| `recovery.ts` | Detect and recover from worker crashes and hangs |
| `message-router.ts` | Route inter-agent messages between comms agent and workers |
| `tmux.ts` | tmux session management — spawn orchestrator, inject text, check session state |

Workers are ephemeral — they spawn for a task and terminate. The daemon tracks active workers in `kithkit.db` (the `agents` table) with their status, profile, PID, and activity timestamps.

#### Fact Verifier and Quarantine (`daemon/src/agents/fact-verifier.ts`)

The fact verifier runs automatically after every worker job completes (fire-and-forget, bounded by a 30-second timeout). It extracts verifiable claims from the job's result text and checks each one cheaply:

| Claim type | Validation method |
|------------|-------------------|
| PR references (`#123`, `PR #123`, GitHub URLs) | `gh pr view` — confirms PR exists; checks asserted title and review state if present |
| Commit SHAs (7–40 hex chars) | `git cat-file -t` — confirms object exists and is type `commit` |
| File:line citations (`path/to/file.ts:42`) | `fs.existsSync` + line count check |
| ISO dates (`YYYY-MM-DD`) | Calendar round-trip validation; rejects invalid dates and dates > 5 years future |
| Orchestrator task IDs (UUID / 32-hex) | `GET /api/orchestrator/tasks/:id` — 200 = verified, 404 = contradicted |

Each claim receives one of three verdicts:
- **`VERIFIED`** — the claim checks out
- **`UNVERIFIABLE`** — the tool (`gh`, `git`, daemon) was unavailable or returned an unexpected result; treated as inconclusive, not a failure
- **`CONTRADICTED`** — the claim was checked and found to be false (wrong PR title, missing file, 404 task ID, etc.)

**Quarantine trigger**: a job is quarantined when any claim is `CONTRADICTED`, or when the job has `status = completed` but an empty/whitespace result.

**What quarantine means**: the job's output is annotated in the DB — the worker output is preserved and not deleted or rewritten. The daemon delivers a warning message to the comms agent listing the contradicted claims. The operator (comms agent / human) reviews the output and decides whether to trust, reject, or re-run the work.

**DB fields** (added by migration 028 in `worker_jobs`):

| Column | Values | Description |
|--------|--------|-------------|
| `verification_status` | `pending` \| `clean` \| `quarantined` \| `skipped` \| `error` | Overall result: `skipped` = no claims found; `error` = verifier itself failed |
| `verification_report` | JSON blob | Full per-claim results (`ClaimResult[]`) with verdict and reason for each |
| `verification_flagged_at` | ISO 8601 UTC | Timestamp when quarantine was set (null if not quarantined) |

**Reviewing a quarantined job**: fetch the job record with `GET /api/agents/:id/status`. The `verification_report` field contains the detailed per-claim breakdown. The `verification_flagged_at` timestamp shows when the quarantine was set. There is no dedicated release endpoint — the operator reviews the output inline and takes action (re-running the task, discarding the result, or accepting it with the contradiction noted).

The fact verifier skips `retro` and `fact-verifier` profile jobs to prevent infinite loops.

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

**Built-in tasks** (source: `daemon/src/automation/tasks/index.ts` — 16 registered handlers):

| Task | Purpose |
|------|---------|
| `context-watchdog` | Warn at 50% context usage; prompt restart at 65% |
| `todo-reminder` | Prompt agent to work on open todos |
| `approval-audit` | Review and prune 3rd-party sender approvals |
| `backup` | Zip and verify backup of state and database |
| `orchestrator-idle` | Monitor orchestrator session — spawn/wake on pending tasks, teardown on idle |
| `message-delivery` | Deliver queued inter-agent messages to tmux sessions |
| `comms-heartbeat` | Nudge comms agent when workers finish; flush relay messages on session revival |
| `peer-heartbeat` | Send periodic status messages to configured peer agents; detect peer liveness |
| `api-metrics-aggregation` | Hourly rollup of `api_request_logs` into `api_metrics_hourly`; purge raw logs older than 24h |
| `daily-digest` | Morning summary report: git activity, todos, failed tasks, peer status, error rates |
| `morning-briefing` | Daily briefing: calendar events, weather, todos, overnight messages, email status |
| `kkit-reflection` | Nightly self-improvement loop: review retro memories, apply skill updates and memory cleanup |
| `self-watchdog` | Detect zombie daemon state — alert when no real work has occurred for a configurable idle threshold |
| `orch-stale-task-recovery` | Time-based safety net for orphaned `assigned`/`in_progress` orchestrator tasks |
| `stale-todo-archive` | Auto-archive stale FYI/Reminder/Maintenance todos that exceed a configured age |
| `stale-todo-surfacing` | Weekly report of stale pending/in-progress todos delivered via the channel router |

Schedules are configured per-instance in `kithkit.config.yaml` (or `kithkit.defaults.yaml` for defaults). Handlers are only registered if a corresponding task entry exists in config.

**Orchestrator liveness detection**: `isOrchestratorAlive()` in `tmux.ts` uses `ORCH_SESSION_PATTERN` (`/^orch\d*$/`) to scan all tmux sessions by name, rather than checking only the default `orch1` session. This means non-default orchestrator session names (e.g., `orch`, `orch2`) are detected correctly.

Extensions add more tasks by registering handlers — see [Extensions](extensions.md).

---

## Layer 3: Claude Code Layer (`.kithkit/` and `.claude/`)

The Claude Code layer defines the agent's identity, skills, and behavioral hooks. It uses a **two-directory model**:

- **`.kithkit/`** — the authoritative source. Humans and agents edit files here.
- **`.claude/`** — a synced read-only copy that Claude Code reads from. Maintained by `POST /api/sync/claude`.

```
.kithkit/                        # Authoritative source (edit here)
├── CLAUDE.md                    # Framework manual
├── settings.json                # Claude Code settings (tools, permissions, hooks)
├── agents/                      # Worker profiles (loaded by daemon/agents/profiles.ts)
│   ├── research.md
│   ├── coding.md
│   └── ...
├── skills/                      # Installed skills (each has a SKILL.md)
│   └── <skill-name>/
│       ├── SKILL.md             # Skill instructions (autoContext frontmatter)
│       └── ...
├── hooks/                       # Event hooks (bash scripts)
│   ├── session-start.sh
│   ├── pre-build.sh
│   └── ...
└── state/                       # Persistent agent state (not committed)
    ├── identity.json
    ├── autonomy.json
    ├── todos/
    ├── memory/
    └── calendar.md

.claude/                         # Synced copy (Claude Code reads from here)
├── CLAUDE.md                    # Synced from .kithkit/ — full overwrite
├── settings.json                # Synced from .kithkit/ — JSON merge
├── agents/                      # Synced from .kithkit/agents/ — rsync --delete
├── skills/                      # Synced from .kithkit/skills/ — rsync --delete
├── projects/                    # Claude Code internals — not synced
├── worktrees/                   # Claude Code internals — not synced
└── state/                       # Symlinked or shared with .kithkit/state/
```

**Sync**: The daemon's `POST /api/sync/claude` endpoint copies from `.kithkit/` to `.claude/`. Use the `/kkitclaudesync` skill to trigger a sync after editing `.kithkit/` files. Never edit `.claude/` directly — changes will be overwritten on next sync.

### Skills

Skills live in `.kithkit/skills/<name>/SKILL.md`. The YAML frontmatter can include `autoContext` rules that tell Claude Code when to load the skill automatically (e.g., when the user mentions a keyword).

Skills are invoked by the comms agent (either automatically via autoContext, or explicitly via `/command`). They can call daemon API endpoints, spawn workers, and interact with external services.

### Hooks

Hooks are bash scripts in `.kithkit/hooks/` that run at specific points in the Claude Code lifecycle:

| Hook | When it runs |
|------|-------------|
| `memory-extraction.sh` | On session stop — extracts and stores memories from the conversation |
| `pre-build.sh` | Before build commands — safety checks |
| `pre-compact.sh` | Before context compaction — saves work state |
| `set-channel.sh` | On user prompt submit — configures the active communication channel |

Hooks are configured in `.kithkit/settings.json` (synced to `.claude/settings.json`).

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

**File state** (in `.kithkit/state/`, persists across sessions):

| File/Dir | Purpose |
|----------|---------|
| `autonomy.json` | Current autonomy mode (yolo / confident / cautious / supervised) |
| `channel.txt` | Active channel (`telegram`, `silent`, etc.) |
| `assistant-state.md` | Saved work context (written before restart, read on resume) |


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

**Config hot-reload**: Change the config file and POST to `/api/config/reload`. On every reload, `kithkit.defaults.yaml` is deep-merged over the user config so defaults-only values hot-apply without a daemon restart. The scheduler re-reads task definitions (adds new, removes deleted, updates changed) without restarting the daemon. Running tasks are not interrupted.

---

## Scripts

The `scripts/` directory provides session management and operational utilities.

### Session Management

| Script | Purpose |
|--------|---------|
| `start-tmux.sh` | Start or attach to the persistent tmux session; `--detach` for background |
| `start.sh` | Start Claude Code directly (called by tmux session) |
| `restart.sh` | Graceful restart — save state, signal restart-watcher |
| `restart-watcher.sh` | Watch for restart signal and relaunch Claude session |
| `watchdog.sh` | Auto-restart Claude on unexpected exit (used in detached mode) |
| `attach.sh` | Attach to existing tmux session |

### Operations

| Script | Purpose |
|--------|---------|
| `health.sh` | Color health check; `--watch` to poll every 10s |
| `dashboard.sh` | Live ops dashboard (tasks, usage, memory counts) |
| `backup.sh` | Manual backup of state and database |
| `repo-audit.sh` | Audit repository for uncommitted changes |
| `context-monitor-statusline.sh` | Output context usage for tmux status bar |
| `daemon-smoke-test.sh` | Integration smoke test against running daemon |

### Shared Library

`scripts/lib/config.sh` provides bash helpers used by all scripts:
- `read_config` — read a value from `kithkit.config.yaml` via `yq` or `python3`
- `get_agent_name` — read agent name from config
- `session_exists` — check if the tmux session is running
- `claude_alive` — check if Claude Code is the active process in the session

---

## Extension Model

Extensions let agent repos add custom routes, tasks, and health checks without modifying the framework. There are two mechanisms:

1. **Compiled-in extension** — ONE per daemon instance, registered at boot, aggregates sub-modules internally. Changing it requires a build and daemon restart. Use for boot-ordered core infrastructure.
2. **Hot-loadable plugins** — self-contained `.js` files in `.kithkit/extensions/` (config: `extensions.plugins`), loaded/reloaded/unloaded at RUNTIME via an fs watcher and the token-gated `/api/extensions` management API. Plugins register routes (under `/api/ext/`), scheduler tasks, channel adapters, and health checks; loads are transactional with rollback and broken plugins are contained as error records. Monolith components are progressively decomposed into plugins via the cache-busted `ctx.import()` wiring pattern (Granola is the first worked example).

See [Extensions](extensions.md) for the complete authoring guide for both.

**Extension hooks**:

| Hook | When called | Purpose |
|------|-------------|---------|
| `onInit(config, server)` | After server starts listening | Register routes, tasks, adapters |
| `onRoute(req, res, pathname, searchParams)` | Each HTTP request (before 404) | Handle custom endpoints |
| `onShutdown()` | Before server closes | Clean up connections, flush buffers |

**Registration APIs** (imported from `kithkit/daemon`):

```typescript
// In your agent repo's extension file (relative to daemon/src/)
import { registerExtension } from './core/extensions.js';
import { registerRoute } from './core/route-registry.js';
import { registerCheck } from './core/extended-status.js';
// Scheduler.registerHandler() is called on the scheduler instance passed via config
```

Import paths are relative to `daemon/src/`. Agent repos that use a `bootstrap.ts` entry point import from within the daemon source tree.
