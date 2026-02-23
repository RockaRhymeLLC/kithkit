# Getting Started with Kithkit

This guide walks you through setting up your first Kithkit agent, from zero to a running assistant.

## Prerequisites

Before you begin, install the following:

| Tool | Version | Check | Install |
|------|---------|-------|---------|
| **Node.js** | 22+ | `node --version` | [nodejs.org](https://nodejs.org/) |
| **npm** | 10+ | `npm --version` | Included with Node.js |
| **tmux** | Any | `tmux -V` | `brew install tmux` / `apt install tmux` |
| **jq** | Any | `jq --version` | `brew install jq` / `apt install jq` |
| **Claude Code CLI** | Latest | `claude --version` | [claude.ai/code](https://claude.ai/code) |

Verify everything is ready:

```bash
node --version   # v22.x.x or higher
tmux -V          # tmux 3.x or higher
claude --version # any version
```

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/RockaRhymeLLC/kithkit.git my-agent
cd my-agent
npm install
```

## Init Wizard

Run the init wizard to configure your agent:

```bash
npx kithkit init
```

The wizard prompts for:

1. **Agent name** — what your assistant is called (e.g., "Atlas", "Aria", "Assistant")
2. **Personality template** — choose from:
   - `professional` — concise, analytical, task-focused
   - `creative` — expressive, idea-generating, exploratory
   - `minimal` — bare-bones, no personality overrides

After init, your project contains:

```
my-agent/
├── kithkit.config.yaml      # Your agent's configuration (edit this)
├── kithkit.defaults.yaml    # Framework defaults (do not edit)
├── identity.md              # Personality and communication style
├── kithkit.db               # SQLite database (created on first run)
├── .claude/
│   ├── CLAUDE.md            # Framework manual (auto-generated)
│   ├── skills/              # 21 built-in skills (slash commands)
│   │   ├── build/           #   /build — implement features from stories
│   │   ├── todo/            #   /todo — persistent cross-session tasks
│   │   ├── memory/          #   /memory — store and retrieve facts
│   │   ├── ...              #   (18 more — see docs/skills.md)
│   └── agents/              # Worker profiles (6 built-in)
│       ├── research.md
│       ├── coding.md
│       ├── testing.md
│       ├── email.md
│       ├── review.md
│       └── devils-advocate.md
├── scripts/                 # Session and ops scripts
└── logs/                    # Daemon logs (created on first run)
```

## First Run

Start the daemon and Claude Code session together:

```bash
./scripts/start-tmux.sh
```

This script:
1. Starts (or attaches to) a persistent tmux session
2. Launches the Kithkit daemon in the background
3. Opens a Claude Code session with your agent's identity loaded
4. Survives terminal close and system sleep

To start detached (useful for servers or launchd):

```bash
./scripts/start-tmux.sh --detach
```

To skip Claude's interactive permission prompts:

```bash
./scripts/start-tmux.sh --skip-permissions
```

## Verification

Check that the daemon is healthy:

```bash
./scripts/health.sh
```

Or poll every 10 seconds:

```bash
./scripts/health.sh --watch
```

You can also query the daemon directly:

```bash
curl http://localhost:3847/health
# {"status":"ok","uptime":12,"version":"0.1.0","timestamp":"..."}

curl http://localhost:3847/status
# {"daemon":"running","agent":"Atlas","uptime":12.5,"timestamp":"..."}
```

If the daemon port differs from the default 3847, check `kithkit.config.yaml` and use `http://localhost:<port>`.

## How It Works

Kithkit runs a three-tier agent system:

```
Human ←→ Comms Agent ←→ Daemon ←→ Workers
              ↕            ↕
          Identity      SQLite DB
```

**Comms agent** — the Claude Code session with your agent's personality. Handles conversations directly and delegates complex tasks to workers.

**Daemon** — a background HTTP server on localhost. Manages state (todos, calendar, memories), agent lifecycle, scheduling, and channel routing. Everything goes through its API. Agent repos use a `bootstrap.ts` entry point that registers the extension before starting the daemon — running `main.ts` directly starts a bare daemon with no extension loaded.

**Workers** — ephemeral Claude Code agents scoped by profiles (research, coding, testing, etc.). Each profile defines allowed tools, model, and turn limits. The comms agent spawns workers on demand.

See [Architecture](architecture.md) for a detailed breakdown.

## Configuration

Edit `kithkit.config.yaml` to customize your agent:

```yaml
agent:
  name: Atlas
  identity_file: identity.md

daemon:
  port: 3847
  log_level: info

scheduler:
  tasks:
    - name: context-watchdog
      interval: "3m"
      enabled: true
    - name: todo-reminder
      interval: "30m"
      enabled: true
```

Hot-reload the config without restarting the daemon:

```bash
curl -X POST http://localhost:3847/api/config/reload
```

## Customizing Your Agent

### Personality

Edit `identity.md` to change how your agent communicates. The YAML frontmatter defines metadata; the markdown body becomes the system prompt:

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

You are Atlas, a research-focused assistant who values precision over speed.
Always cite your sources. Prefer structured output. Be direct.
```

### Worker Profiles

Worker profiles live in `.claude/agents/`. Add a new `.md` file with YAML frontmatter to create a custom worker type. See [Agent Profiles](agent-profiles.md) for the full format.

### Skills

Kithkit ships with 21 built-in skills your agent can use immediately — no installation needed. These are Claude Code slash commands that live in `.claude/skills/`:

| Category | Skills |
|----------|--------|
| Dev workflow | `/spec`, `/plan`, `/review`, `/build`, `/validate` |
| State management | `/todo`, `/memory`, `/calendar`, `/save-state`, `/restart` |
| Automation | `/hooks`, `/mode`, `/remind`, `/playwright-cli`, `/kithkit` |
| Reference | `browser`, `email-compose`, `keychain`, `macos-automation`, `web-design`, `skill-create` |

See [skills.md](skills.md) for detailed descriptions of each skill.

You can also install additional skills from the Kithkit catalog:

```bash
npx kithkit search "email"
npx kithkit install @kithkit/email
```

## Common Operations

Once your agent is running, use the daemon API for state management:

```bash
# Create a todo
curl -X POST http://localhost:3847/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title": "Review project proposal", "priority": "high"}'

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
  -d '{"profile": "research", "prompt": "Summarize the top 3 TypeScript testing frameworks"}'

# Check token usage
curl http://localhost:3847/api/usage
```

## Session Management Scripts

The `scripts/` directory provides common operational commands:

| Script | Purpose |
|--------|---------|
| `start-tmux.sh` | Start or attach to the tmux session |
| `start.sh` | Start Claude Code directly (no tmux) |
| `restart.sh` | Graceful restart (save state, relaunch) |
| `watchdog.sh` | Auto-restart Claude on unexpected exit |
| `attach.sh` | Attach to existing tmux session |
| `health.sh` | Color health check (`--watch` to poll) |
| `dashboard.sh` | Ops dashboard (tasks, usage, memory) |
| `backup.sh` | Manual backup of state and database |
| `repo-audit.sh` | Audit repository for uncommitted changes |

## Next Steps

- Read [Skills Reference](skills.md) — all 21 built-in skills with descriptions
- Read [Architecture](architecture.md) — understand the daemon, extensions, and data flow
- Read [Extensions](extensions.md) — add custom routes, tasks, and integrations
- Read [API Reference](api-reference.md) — complete daemon HTTP endpoint documentation
- Read [Agent Profiles](agent-profiles.md) — create specialized worker types
- Browse `docs/recipes/` — ready-made integration guides (Telegram, email, voice, browser)
