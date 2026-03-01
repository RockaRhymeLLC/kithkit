---
name: agent-comms
description: Send messages to peer agents and check agent-comms status.
argument-hint: [send <peer> "<message>" | status | log]
---

# Agent-to-Agent Communication

Send and receive messages with peer agents on the local network.

## Commands

Parse the arguments to determine action:

### Send
- `send <peer> "<message>"` - Send a text message to a peer
- `send <peer> "<message>" status` - Send a status update
- `send <peer> "<message>" coordination` - Send a coordination message
- `send <peer> "<message>" pr-review` - Send a PR review request

### Status
- `status` - Show agent-comms status (peers, queue, connectivity)

### Log
- `log` - Show recent agent-comms log entries
- `log <n>` - Show last n log entries

### Examples
- `/agent-comms send r2d2 "Hey, are you free to review a PR?"`
- `/agent-comms send r2d2 "Claiming the auth refactor" coordination`
- `/agent-comms send r2d2 "idle" status`
- `/agent-comms status`
- `/agent-comms log 10`

## Implementation

### Sending
Use the CLI script for reliable delivery:
```bash
scripts/agent-send.sh <peer> "<message>" [type]
```

Or via the daemon endpoint (uses curl internally):
```bash
curl -s -X POST http://localhost:3847/agent/send \
  -H 'Content-Type: application/json' \
  --data-raw '{"peer":"<name>","type":"text","text":"<message>"}'
```

### Checking Status
```bash
# Local daemon status
curl -s http://localhost:3847/status

# Peer status (direct)
curl -s http://<peer-host>:<peer-port>/agent/status
```

### Reading Logs
```bash
tail -20 logs/agent-comms.log
```

## Peers

Peers are configured in `cc4me.config.yaml` under `agent-comms.peers`. Each peer has a name, host, and port.

## Architecture

### LAN (Direct)
- **Inbound**: Daemon receives on `POST /agent/message`, validates auth (bearer token from Keychain), injects directly into tmux session with `[Agent] Name:` prefix (same as Telegram — tmux buffers input natively)
- **Outbound**: Daemon sends via `curl` subprocess (not Node.js `http.request`, which has macOS LAN networking issues)
- **Auth**: Shared secret stored in macOS Keychain (`credential-agent-comms-secret`)

### Relay (Internet Fallback)
- **Transport**: HTTPS via CC4Me Relay (https://relay.bmobot.ai)
- **Auth**: Ed25519 per-request signatures (X-Agent + X-Signature headers)
- **Sending**: If LAN fails and `network.enabled` is true, automatically falls back to relay
- **Receiving**: `relay-inbox-poll` task polls every 30s, verifies signatures, injects messages
- **Identity**: Agent keypair in Keychain (`credential-cc4me-agent-key`), public key registered with relay
- **Policy**: No sensitive data over relay until E2E encryption is added (see `docs/relay-usage-policy.md`)

### Logging
- All messages logged as JSONL to `logs/agent-comms.log`
- Directions: `in` (LAN inbound), `out` (LAN outbound), `relay-in`, `relay-out`

## Usage Protocol

This protocol governs how and when agents use agent-to-agent comms.

### When to Use Agent Comms
- **Coordination**: Claiming/releasing tasks, proposing approaches, agreeing on who does what
- **Status**: Quick presence pings and availability changes
- **PR notifications**: Ready for review, merged, needs changes
- **Direct questions**: Quick technical questions between agents
- **Handoffs**: Context handoff on shared work (when one agent hits context limits)

### When NOT to Use Agent Comms
- Anything needing human attention (use Telegram)
- Long-form specs or proposals (use email)
- Anything requiring a paper trail for the humans (use email)

### Message Types
| Type | Use For |
|------|---------|
| `text` | General messages, questions, updates, FYIs |
| `status` | Availability changes: idle, busy, restarting |
| `coordination` | Claim/release tasks, propose approaches, agree on work split |
| `pr-review` | PR review requests (include repo, branch, PR number) |

### Etiquette
- Keep messages concise — both agents are context-limited
- Batch related updates when possible
- Trust delivery when the other agent is busy — tmux buffers input natively
- Acknowledge receipt on important coordination messages
- One topic per message when practical
- Respond to coordination claims promptly

## Troubleshooting

### Messages not delivering
1. Check peer is online: `curl -s http://<host>:<port>/agent/status`
2. Check daemon is running: `curl -s http://localhost:3847/health`
3. Check logs: `tail logs/agent-comms.log`

### Auth failures
- Verify shared secret matches: `security find-generic-password -s credential-agent-comms-secret -w`
- Both agents must have the same secret in their Keychain
