# Getting Started with Kithkit

This guide walks you through setting up your first Kithkit agent, from installation to a running assistant.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/) (`node --version` to check)
- **npm** — included with Node.js
- **Claude Code CLI** — [claude.ai/code](https://claude.ai/code) (`claude --version` to check)

## Quick Start

### 1. Initialize a new project

```bash
mkdir my-agent && cd my-agent
npx kithkit init
```

The init wizard will ask you two things:
1. **Agent name** — what your agent is called (default: "Assistant")
2. **Personality template** — professional, creative, or minimal

That's it. Kithkit creates everything else:

```
my-agent/
├── kithkit.config.yaml      # Your agent's configuration
├── identity.md              # Personality and communication style
├── .claude/
│   ├── CLAUDE.md            # Framework manual (auto-generated)
│   └── agents/              # Worker profiles (6 built-in)
│       ├── research.md
│       ├── coding.md
│       ├── testing.md
│       ├── email.md
│       ├── review.md
│       └── devils-advocate.md
└── kithkit.db               # SQLite database (created on first run)
```

### 2. Start the daemon

```bash
npx kithkit start
```

The daemon starts on `localhost:3847`. Verify it's running:

```bash
curl http://localhost:3847/health
```

### 3. Start the comms agent

The comms agent is your main interaction point — a Claude Code session with your agent's identity loaded:

```bash
claude --append-system-prompt identity.md
```

Your agent is now running and ready to talk.

## What Just Happened?

Kithkit set up a three-tier agent system:

1. **Comms agent** — the Claude Code session you're talking to. It has your agent's full personality and handles simple requests directly.

2. **Daemon** — a background HTTP server that manages state (todos, calendar, memories), agent lifecycle, and inter-agent messaging. Everything goes through the daemon API.

3. **Workers** — when the comms agent encounters a complex task (multi-step research, code projects), it escalates to the orchestrator, which spawns specialized workers. Workers use agent profiles to limit their capabilities (e.g., the `research` profile is read-only).

## Configuration

Edit `kithkit.config.yaml` to customize:

```yaml
agent:
  name: MyAgent
  identity_file: identity.md

daemon:
  port: 3847
  log_level: info

scheduler:
  tasks:
    - name: email-check
      enabled: true
      interval: 15m
```

After changing the config, reload without restarting:

```bash
curl -X POST http://localhost:3847/api/config/reload
```

## Customizing Your Agent

### Personality

Edit `identity.md` to change how your agent communicates. The YAML frontmatter defines metadata, and the markdown body defines behavior:

```markdown
---
name: Atlas
style: professional
humor: dry
voice: calm and measured
traits:
  - analytical
  - precise
---

You are Atlas, a research-focused assistant...
```

### Worker Profiles

Add or modify profiles in `.claude/agents/` to create specialized workers. See `docs/agent-profiles.md` for the full format.

### Skills

Install skills from the Kithkit catalog:

```bash
npx kithkit search "email"
npx kithkit install @kithkit/email
```

## Using the Daemon API

The daemon API is how your agent manages state. Common operations:

```bash
# Create a todo
curl -X POST http://localhost:3847/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title": "Write weekly report", "priority": "high"}'

# Store a memory
curl -X POST http://localhost:3847/api/memory/store \
  -H 'Content-Type: application/json' \
  -d '{"content": "User prefers dark mode", "type": "fact", "tags": ["preferences"]}'

# Search memories
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "dark mode"}'

# Spawn a research worker
curl -X POST http://localhost:3847/api/agents/spawn \
  -H 'Content-Type: application/json' \
  -d '{"profile": "research", "prompt": "Compare React vs Vue vs Svelte"}'

# Check token usage
curl http://localhost:3847/api/usage
```

See `docs/api-reference.md` for the complete API reference.

## Next Steps

- Read the [API Reference](api-reference.md) for all daemon endpoints
- Read [Agent Profiles](agent-profiles.md) to create custom worker types
- Explore the [Kithkit catalog](https://kithkit.com) for installable skills
- Check `kithkit.config.yaml` for all configuration options
