# Kithkit

A framework for building persistent personal AI assistants with Claude Code.

Kithkit gives your agent a background daemon for state management, a multi-agent task delegation system, channel-based communication, and a scheduler — so it runs as an always-on assistant, not just a CLI tool you open when you need it.

## Features

- **Persistent daemon** — Node.js HTTP server on localhost manages SQLite state, schedules tasks, and routes messages
- **Structured memory** — store facts, decisions, and episodic memories; search by keyword, tag, category, or semantic similarity (vector embeddings via all-MiniLM-L6-v2)
- **Multi-agent task delegation** — spawn scoped worker agents (research, coding, testing, review, etc.) via the Agent SDK; each profile defines allowed tools, model, and turn limits
- **Channel adapters** — receive and send messages through Telegram, email, and custom channels
- **Scheduler** — cron and interval-based task execution with idle detection and session awareness
- **Extension model** — add custom HTTP routes, scheduler tasks, and health checks without modifying the framework
- **Identity system** — define your agent's name, personality, and communication style in a single `identity.md` file
- **Config hot-reload** — change settings without restarting the daemon

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/RockaRhymeLLC/kithkit.git my-agent
cd my-agent && npm install

# 2. Initialize your agent
npx kithkit init

# 3. Start the daemon and Claude Code session
./scripts/start-tmux.sh

# 4. Verify the daemon is running
./scripts/health.sh

# 5. Talk to your agent
curl http://localhost:3847/status
```

The init wizard asks for a name and personality template — everything else is automatic.

## Architecture

```
Human ←→ Comms Agent ←→ Daemon (Orchestrator) ←→ Worker Agents
              ↕                    ↕
          Identity              SQLite DB
```

**Comms agent** — a persistent Claude Code session with your agent's identity. Handles conversations directly and delegates complex tasks to workers.

**Daemon (Orchestrator)** — a background HTTP server on `localhost:3847`. Manages state (SQLite), agent lifecycle, scheduling, and channel routing. Acts as the Orchestrator for all Worker agents.

**Worker agents** — ephemeral Claude Code agents scoped by profiles (research, coding, testing, etc.). Spawned on demand; killed when the task is done.

See [docs/architecture.md](docs/architecture.md) for a complete breakdown including data flow, daemon internals, extension model, and scripts.

## Built-in Skills

Kithkit ships with 21 skills that your agent can use out of the box — no installation needed. Skills are Claude Code slash commands that give your agent structured capabilities.

**Development workflow:**
`/spec` → `/plan` → `/review` → `/build` → `/validate`

**State management:**
`/todo`, `/memory`, `/calendar`, `/save-state`, `/restart`

**Automation & tools:**
`/hooks`, `/mode`, `/remind`, `/playwright-cli`, `/kithkit`

**Reference skills** (loaded automatically when relevant):
`browser`, `email-compose`, `keychain`, `macos-automation`, `web-design`, `skill-create`

See [docs/skills.md](docs/skills.md) for the full reference with descriptions.

## Documentation

| Doc | What it covers |
|-----|---------------|
| [Getting Started](docs/getting-started.md) | Prerequisites, installation, first run, verification, configuration |
| [Architecture](docs/architecture.md) | Three-tier system, daemon internals, extension model, scripts |
| [Skills Reference](docs/skills.md) | All 21 built-in skills with descriptions and usage |
| [Extensions](docs/extensions.md) | Writing custom routes, tasks, and health checks |
| [API Reference](docs/api-reference.md) | All daemon HTTP endpoints with request/response examples |
| [Agent Profiles](docs/agent-profiles.md) | Worker profile format, built-in profiles, creating custom types |
| [Recipes](docs/recipes/) | Integration guides — Telegram, email, voice, browser automation |

## Requirements

- Node.js 22+
- npm
- tmux
- jq
- Claude Code CLI

## License

MIT
