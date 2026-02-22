# Kithkit — Framework Manual

This file tells Claude Code how to operate within a Kithkit-managed project. It covers platform mechanics, behavioral directives, interaction rules, and quality standards. It does NOT define your personality — that's in your identity file (`identity.md`).

## Platform Usage

### Architecture

Kithkit uses a three-tier agent architecture managed by a small, stable daemon:

```
Human ←→ Comms Agent ←→ Daemon ←→ Orchestrator ←→ Workers
              ↕            ↕            ↕
          Channels      SQLite DB    Agent SDK
```

- **Comms agent** — persistent tmux session, full personality, handles simple requests directly
- **Orchestrator** — spawned on-demand, no personality, decomposes complex tasks, manages workers
- **Workers** — ephemeral SDK `query()` calls, scoped by agent profiles, report results and die
- **Daemon** — Node.js HTTP server on `localhost:3847`, owns SQLite DB, routes messages, manages lifecycle

### Daemon API

The daemon exposes a local HTTP API on `127.0.0.1:<port>` (default 3847). Use it for all state operations.

**Quick reference:**

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check (status, uptime, version) |
| `GET /status` | Quick status (agent name, uptime) |
| `POST /api/agents/spawn` | Spawn a worker with a profile and prompt |
| `GET /api/agents` | List all agents |
| `GET /api/agents/:id` | Get agent details |
| `GET /api/agents/:id/status` | Get agent/job status |
| `DELETE /api/agents/:id` | Kill a running worker |
| `GET /api/todos` | List todos |
| `POST /api/todos` | Create a todo |
| `PUT /api/todos/:id` | Update a todo |
| `DELETE /api/todos/:id` | Delete a todo |
| `GET /api/calendar` | List calendar events |
| `POST /api/calendar` | Create a calendar event |
| `GET /api/usage` | Aggregate token/cost stats |
| `POST /api/messages` | Send inter-agent message |
| `GET /api/messages?agent=X` | Get message history |
| `POST /api/send` | Deliver message through channel router |
| `POST /api/memory/store` | Store a memory |
| `POST /api/memory/search` | Search memories (keyword, vector, hybrid) |
| `GET /api/tasks` | List scheduler tasks |
| `POST /api/tasks/:name/run` | Manually trigger a task |
| `POST /api/config/reload` | Hot-reload config from disk |

See `docs/api-reference.md` for full request/response details.

### Configuration

All behavior is controlled by `kithkit.config.yaml` in the project root. Defaults are in `kithkit.defaults.yaml` — your config overrides them via deep merge.

```yaml
agent:
  name: MyAgent
  identity_file: identity.md

daemon:
  port: 3847
  log_level: info        # debug | info | warn | error
  log_dir: logs
  log_rotation:
    max_size_mb: 10
    max_files: 5

scheduler:
  tasks: []              # Array of { name, enabled, interval?, cron?, config? }

security:
  rate_limits:
    incoming_max_per_minute: 5
    outgoing_max_per_minute: 10
```

Config changes take effect after `POST /api/config/reload` or daemon restart.

### Agent Profiles

Worker agents are scoped by profiles in `.claude/agents/*.md`. Each profile uses YAML frontmatter to define capabilities:

```yaml
---
name: research
description: Read-only research worker
tools: [Read, Glob, Grep, WebSearch, WebFetch, Task]
disallowedTools: [Bash, Edit, Write, NotebookEdit]
model: sonnet
permissionMode: bypassPermissions
maxTurns: 20
---

System prompt / instructions for this worker type.
```

See `docs/agent-profiles.md` for the full format and built-in profiles.

### Database

All state lives in `kithkit.db` (SQLite, WAL mode). Tables: agents, worker_jobs, memories, todos, todo_actions, calendar, messages, config, feature_state, task_results, migrations.

Never modify the database directly — always use the daemon API.

### Memory System

Store and search memories via the daemon API:

- `POST /api/memory/store` — create a memory (fact, episodic, or procedural)
- `POST /api/memory/search` — search by keyword, tags, category, date range, or semantic similarity
- Keyword search: multi-word queries use AND matching, results ranked by relevance
- Vector search: uses all-MiniLM-L6-v2 ONNX embeddings with sqlite-vec
- Hybrid search: combines keyword relevance with vector similarity

## Directives

### Task Escalation

- **Handle simple requests directly** — weather, calendar, quick lookups, single-step tasks
- **Escalate complex tasks** — multi-step research, code projects, anything needing multiple tools or workers
- Escalate by sending a message to the orchestrator via `POST /api/messages`
- The orchestrator decomposes the task and spawns workers with appropriate profiles

### State Management

- Use the daemon API for all state (todos, calendar, memories, config)
- Don't store state in flat files — use the database
- Track token usage — it's automatically recorded per worker job
- Check `GET /api/usage` to monitor costs

### Error Recovery

- If a worker hangs (no output within timeout), the daemon kills it and notifies the orchestrator
- On daemon restart, orphaned agents are cleaned up and interrupted jobs are marked failed
- Pending jobs can be recovered via the recovery system

## Rules of Engagement

### Security

- The daemon binds to `127.0.0.1` only — no remote access
- No authentication on the API (localhost-only is the security boundary)
- Never expose the daemon port externally
- Protect credentials — use the system keychain, not config files

### Inter-Agent Communication

- All agent-to-agent messages go through `POST /api/messages`
- Messages are logged and auditable via `GET /api/messages`
- Workers can only message the orchestrator that spawned them
- The comms agent is the only agent that talks to humans

### Channel Delivery

- Use `POST /api/send` to deliver messages to the human
- The channel router handles delivery to configured channels (Telegram, email, etc.)
- Don't bypass the router — it handles formatting and delivery tracking

## Quality Standards

### Code

- Read existing code before modifying it
- Follow project conventions (TypeScript, ESM, Node.js 22+)
- Write tests for new functionality
- Keep changes focused on the assigned task

### Communication

- Be concise and direct
- Match your tone to your identity file
- Structure complex information clearly
- Proactively flag issues and share relevant context

### Workmanship

- Prefer accuracy over speed
- Verify your work before reporting completion
- Clean up after yourself (temp files, stale state)
- Track what you commit to and follow through
