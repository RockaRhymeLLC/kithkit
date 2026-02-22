---
name: agent-comms
description: Sends and receives messages with peer agents on the local network. Use when messaging R2, checking peer availability, coordinating shared work, or reviewing agent-comms logs.
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

### P2P SDK (Internet — Primary)
- **Transport**: HTTPS directly to peer's public endpoint (E2E encrypted)
- **Encryption**: X25519 ECDH key exchange + AES-256-GCM, Ed25519 signed envelopes
- **Sending**: If LAN fails and CC4Me Network SDK is active, sends directly to peer via P2P SDK
- **Receiving**: SDK event handler routes incoming messages to session
- **Identity**: Agent Ed25519 keypair in Keychain (`credential-cc4me-agent-key`), public key in relay directory
- **Key point**: Messages go directly between agents — the relay is never in the message path

### Legacy Relay (Deprecated Fallback)
- **Transport**: HTTPS via CC4Me Relay (configured in `cc4me.config.yaml` under `network.relay_url`) — store-and-forward
- **Auth**: Ed25519 per-request signatures (X-Agent + X-Signature headers)
- **Sending**: Only used if both LAN and P2P SDK fail
- **Note**: Being deprecated in favor of P2P SDK. Messages through legacy relay are signed but not E2E encrypted

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
