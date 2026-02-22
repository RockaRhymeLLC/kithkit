# Kithkit

A framework for building personal AI assistants with Claude Code.

Kithkit gives your Claude Code agent a persistent daemon, structured memory, multi-agent task delegation, and channel-based communication — so it can run as an always-on assistant, not just a CLI tool.

## Quick Start

```bash
mkdir my-agent && cd my-agent
npx kithkit init
```

The wizard asks for a name and personality template. Everything else is automatic.

## Architecture

```
Human ←→ Comms Agent ←→ Daemon ←→ Orchestrator ←→ Workers
              ↕            ↕            ↕
          Channels      SQLite DB    Agent SDK
```

**Comms agent** — persistent Claude Code session with your agent's identity. Handles simple requests directly.

**Daemon** — Node.js HTTP server on localhost. Manages state (SQLite), agent lifecycle, inter-agent messaging, scheduling, and channel routing.

**Orchestrator** — spawned on-demand when the comms agent encounters complex tasks. Decomposes work and manages workers.

**Workers** — ephemeral agents scoped by profiles (research, coding, testing, etc.). Each profile defines allowed tools, model, and turn limits.

## What's Included

- **SQLite state management** — todos, calendar, memories, config, feature state, usage tracking
- **Structured + vector memory** — keyword search, tag/category filters, semantic similarity via all-MiniLM-L6-v2
- **Agent lifecycle management** — spawn, monitor, timeout, kill workers via API
- **Inter-agent messaging** — logged, auditable message routing between agents
- **Channel adapters** — pluggable delivery to Telegram, email, and custom channels
- **Scheduler** — cron and interval-based task execution
- **Agent profiles** — 6 built-in worker types (research, coding, testing, email, review, devil's advocate)
- **Identity system** — 3 personality templates (professional, creative, minimal)
- **Config hot-reload** — change settings without restarting the daemon
- **Error recovery** — automatic detection and recovery from worker crashes and hangs
- **Skills catalog** — install community skills via `npx kithkit install`

## Project Structure

```
kithkit/
├── daemon/               # Node.js daemon (HTTP API, SQLite, lifecycle)
│   └── src/
│       ├── core/         # Config, DB, health, logging
│       ├── api/          # HTTP route handlers
│       ├── agents/       # Lifecycle, profiles, SDK adapter, recovery
│       ├── comms/        # Channel router + adapters
│       ├── memory/       # Structured search + vector embeddings
│       └── automation/   # Scheduler + task runner
├── cli/                  # npx kithkit command
│   └── src/
│       ├── index.ts      # CLI entry point
│       ├── init.ts       # Init wizard
│       └── prerequisites.ts
├── profiles/             # Built-in agent profiles
├── templates/            # Identity templates + default config
├── packages/             # Kithkit ecosystem packages
│   ├── kithkit-client/   # Catalog API client
│   ├── kithkit-linter/   # Skill quality linter
│   ├── kithkit-catalog/  # Catalog index builder
│   └── kithkit-sign/     # Ed25519 skill signing
└── docs/                 # Documentation
```

## Documentation

- [Getting Started](docs/getting-started.md) — from zero to running agent
- [API Reference](docs/api-reference.md) — all daemon HTTP endpoints
- [Agent Profiles](docs/agent-profiles.md) — profile format and built-in types

## Requirements

- Node.js 22+
- npm
- Claude Code CLI

## License

MIT
