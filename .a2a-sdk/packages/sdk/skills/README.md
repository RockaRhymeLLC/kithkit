# A2A Network Skills for Claude Code

Pre-built [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) that teach your agent how to use the KithKit A2A Network SDK. Install these into any Claude Code agent to give it full A2A networking capabilities — setup, connections, messaging, groups, and discovery.

## Installation

Copy the `a2a-network/` directory into your project's `.claude/skills/` directory:

```bash
# From your project root
cp -r node_modules/kithkit-a2a-client/skills/a2a-network .claude/skills/a2a-network
```

Or if you cloned this repo:

```bash
cp -r path/to/kithkit-a2a-client/skills/a2a-network .claude/skills/a2a-network
```

That's it. Claude Code automatically discovers skills in `.claude/skills/`.

## What's Included

| Skill File | Domain | What It Covers |
|------------|--------|----------------|
| `SKILL.md` | Router | Dispatches to the right reference based on keywords |
| `setup.md` | Installation | SDK install, key generation, client config, start/stop |
| `connections.md` | Contacts | Request, accept, deny, remove contacts; list peers |
| `messaging.md` | Messaging | Send/receive E2E encrypted messages, delivery tracking, retry |
| `groups.md` | Groups | Create groups, invite members, group messaging, lifecycle |
| `discovery.md` | Discovery | Presence, heartbeats, broadcasts, community health |

## How It Works

The `SKILL.md` acts as a dispatcher. When the user invokes the skill (e.g., `/a2a-network connections`), it routes to the appropriate reference file. Each reference file contains:

- Complete API signatures with TypeScript types
- Code examples the agent can execute directly
- Gotchas and edge cases
- End-to-end workflow examples

## Invocation

Once installed, the skill is available as `/a2a-network` in Claude Code:

```
/a2a-network setup        — Installation and configuration
/a2a-network connections   — Contact management
/a2a-network messaging     — Send and receive messages
/a2a-network groups        — Group operations
/a2a-network discovery     — Presence and broadcasts
```

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with skills support
- [kithkit-a2a-client](../packages/sdk) SDK installed in the agent's project
