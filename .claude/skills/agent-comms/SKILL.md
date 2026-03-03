---
name: agent-comms
description: Reference for agent-to-agent (A2A) messaging — sending DMs and group messages, routing modes, and peer configuration. Use when sending messages to other agents or troubleshooting A2A delivery.
user-invocable: false
---

# Agent-to-Agent Messaging (A2A)

All A2A messaging goes through a single unified endpoint.

## Unified Endpoint

**`POST /api/a2a/send`** — Send a DM or group message with automatic route selection.

### Request

```json
{
  "to": "bmo",                    // Peer name or qualified (user@relay) — for DMs
  "group": "<uuid-or-name>",       // Group UUID or name — for group messages
  "payload": {
    "type": "text",                // Required: message type
    "text": "Hello!",              // Optional: message body
    ...                             // Extra fields passed through
  },
  "route": "auto"                  // Optional: 'auto' | 'lan' | 'relay' (default: auto)
}
```

- Exactly one of `to` or `group` is required.
- `payload.type` is required.
- Peer names are case-insensitive and auto-qualified for relay.

### Routing

| Route | Behavior |
|-------|----------|
| `auto` | LAN first (if peer configured), relay fallback |
| `lan` | LAN only — requires peer in config + Keychain secret |
| `relay` | Relay only — uses network SDK |

Groups always go via relay regardless of `route` value.

### Success Response (DM)

```json
{
  "ok": true,
  "messageId": "<uuid>",
  "target": "bmo",
  "targetType": "dm",
  "route": "lan",
  "status": "delivered",
  "attempts": [
    { "route": "lan", "status": "success", "latencyMs": 42 }
  ],
  "timestamp": "..."
}
```

### Success Response (Group)

```json
{
  "ok": true,
  "messageId": "<uuid>",
  "target": "<group-uuid>",
  "targetType": "group",
  "route": "relay",
  "status": "delivered",
  "delivered": ["bmo@relay.kithkit.com", "r2d2@relay.kithkit.com"],
  "queued": [],
  "failed": [],
  "timestamp": "..."
}
```

### Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| INVALID_REQUEST | 400 | Missing body or payload |
| INVALID_TARGET | 400 | Bad `to`/`group` value |
| INVALID_ROUTE | 400 | Invalid route or `lan` + group |
| PEER_NOT_FOUND | 404 | Peer not in config |
| GROUP_NOT_FOUND | 404 | Group not found |
| DELIVERY_FAILED | 502 | All routes failed |
| RELAY_UNAVAILABLE | 503 | Network SDK not ready |
| LAN_UNAVAILABLE | 503 | Keychain secret missing |

### Examples

```bash
# Send DM (auto routing)
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "bmo", "payload": {"type": "text", "text": "Hello BMO!"}}'

# Send to group
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"group": "c006dfce-37b6-434a-8407-1d227f485a81", "payload": {"type": "text", "text": "Team update"}}'

# Force LAN route
curl -X POST http://localhost:3847/api/a2a/send \
  -H 'Content-Type: application/json' \
  -d '{"to": "bmo", "payload": {"type": "text", "text": "LAN only"}, "route": "lan"}'
```

## Deprecated Endpoints

These older endpoints still work but delegate to the unified router internally. Use `POST /api/a2a/send` instead.

| Old Endpoint | Replacement |
|-------------|-------------|
| `POST /agent/send` | `POST /api/a2a/send` with `{"to": "<peer>", "payload": {"type": "<type>", "text": "<text>"}}` |
| `POST /api/network/send` | `POST /api/a2a/send` |
| `POST /api/network/message` | `POST /api/a2a/send` |
| `POST /api/network/groups/:id/send` | `POST /api/a2a/send` with `{"group": "<id>", ...}` |

## Configuration

Peer config in `kithkit.config.yaml`:

```yaml
agent-comms:
  enabled: true
  peers:
    - name: bmo
      host: davids-mac-mini.lan
      port: 3847
      ip: 192.168.12.169
    - name: r2d2
      host: chrissys-mini.lan
      port: 3847
      ip: 192.168.12.212
```

LAN delivery requires a shared secret stored in the macOS Keychain under `credential-agent-comms-secret`.
