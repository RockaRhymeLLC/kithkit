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

### Sending (Unified A2A Endpoint — preferred)

Use `POST /api/a2a/send` for all outbound A2A messaging (DM and group):

```bash
curl -s -X POST 'http://localhost:3847/api/a2a/send' \
  -H 'Content-Type: application/json' \
  -d '{"to": "r2", "payload": {"type": "text", "text": "Hey, are you free?"}}'
```

**Request format:**
```json
{
  "to": "r2",
  "payload": {
    "type": "coordination",
    "text": "Claiming the auth refactor task"
  },
  "route": "auto"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `to` | yes* | Peer name (e.g. `r2`) or qualified name (`r2@relay.bmobot.ai`) |
| `group` | yes* | Group UUID (for group messages) — mutually exclusive with `to` |
| `payload.type` | yes | `text`, `status`, `coordination`, or `pr-review` |
| `payload.text` | no | Message body (**always use `text`, not `message` or `content`**) |
| `route` | no | `auto` (default), `lan`, or `relay` |

*One of `to` or `group` is required.

**Coordination example:**
```bash
curl -s -X POST 'http://localhost:3847/api/a2a/send' \
  -H 'Content-Type: application/json' \
  -d '{"to": "r2", "payload": {"type": "coordination", "text": "Claiming the auth refactor", "action": "claim", "task": "auth-refactor"}}'
```

**PR review example:**
```bash
curl -s -X POST 'http://localhost:3847/api/a2a/send' \
  -H 'Content-Type: application/json' \
  -d '{"to": "r2", "payload": {"type": "pr-review", "text": "Ready for review", "repo": "RockaRhymeLLC/kithkit", "branch": "feat/auth", "pr": "142"}}'
```

**Group message example:**
```bash
curl -s -X POST 'http://localhost:3847/api/a2a/send' \
  -H 'Content-Type: application/json' \
  -d '{"group": "c006dfce-37b6-434a-8407-1d227f485a81", "payload": {"type": "text", "text": "Team standup: all clear"}}'
```

**Success response (HTTP 200):**
```json
{"ok": true, "messageId": "uuid", "target": "r2", "targetType": "dm", "route": "lan", "status": "delivered", "attempts": [...]}
```

**Failure response (HTTP 4xx/5xx):**
```json
{"ok": false, "error": "All delivery routes failed", "code": "DELIVERY_FAILED", "attempts": [...]}
```

The router tries LAN first (if peer is in config), falls back to relay automatically when `route` is `auto`.

### Sending (Legacy endpoint)

The old `/agent/send` endpoint still works but is not recommended:
```bash
curl -s -X POST 'http://localhost:3847/agent/send' \
  -H 'Content-Type: application/json' \
  -d '{"peer": "r2", "type": "text", "text": "Hey"}'
```

### Receiving (Inbound)
Peers send to our `POST /agent/message` endpoint (handled by the daemon automatically). Inbound messages require Bearer auth and must include `messageId` and `timestamp`:

```json
{
  "from": "r2",
  "type": "text",
  "text": "Hey, PR is ready for review",
  "messageId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-02-27T15:30:00.000Z"
}
```

**Response:** `{"ok": true, "queued": false}`

The daemon validates the Bearer token, formats the message, and injects it into the comms tmux session.

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

Peers are configured in `kithkit.config.yaml` under `agent-comms.peers`. Each peer has a name, host, port, and optional fallback IP.

```yaml
agent-comms:
  enabled: true
  secret: "credential-agent-comms-secret"  # Keychain credential name
  peers:
    - name: "R2"
      host: "chrissys-mini.lan"
      port: 3847
      ip: "192.168.12.212"  # Fallback IP for LAN retry
```

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

### Group Messaging
Use the unified endpoint with `group` instead of `to`:
```bash
curl -s -X POST 'http://localhost:3847/api/a2a/send' \
  -H 'Content-Type: application/json' \
  -d '{"group": "<group-uuid>", "payload": {"type": "text", "text": "Message to all members"}}'
```
The old `POST /api/network/groups/:id/send` endpoint still works but is deprecated.

## Canonical P2P Message Schema

All agents MUST use these field names when sending P2P messages:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Sender agent name (lowercase) |
| `type` | string | yes | Message type: `text`, `status`, `coordination`, `pr-review` |
| `text` | string | no | Message content body (**canonical field name**) |
| `timestamp` | string | yes | ISO 8601 timestamp |
| `messageId` | string | yes | UUID for deduplication |

**Important — field name convention:**
- Always send message content in the `text` field (not `message`, `body`, or `content`)
- The receiving daemon accepts `message` as a legacy alias for `text`, but senders MUST use `text`
- This was standardized in issue #118 after field name mismatches caused empty message delivery

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
