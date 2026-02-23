# Channels API Reference

Outbound message delivery via the channel router (Telegram, email, etc.).

## POST /api/send

Deliver a message through configured channels.

```bash
# Send to all active channels
curl -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message": "Task complete — PR ready for review"}'

# Send to specific channel(s)
curl -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message": "Quick update", "channels": ["telegram"]}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | Message text to deliver |
| `channels` | string[] | no | Specific channels to use. Omit to send to all active channels |
| `metadata` | object | no | Arbitrary key/value pairs passed to channel adapters |

**Responses:**

| Status | Body |
|--------|------|
| 200 | `{ "results": /* channel router result */, "timestamp": "..." }` |
| 400 | `{ "error": "message is required" }` |
| 413 | `{ "error": "Request body too large" }` |

**How it works:**
1. The channel router reads active channels from `kithkit.config.yaml`
2. Forwards the message to each matching channel adapter
3. Returns delivery results per channel

**Gotchas:**
- If no `channels` specified, the message goes to ALL active channels configured in the config
- Channel adapters must be configured in `kithkit.config.yaml` — if no channels are set up, the message is silently dropped
- This is for outbound delivery to humans — for inter-agent messaging, use `POST /api/messages` instead
- Only the comms agent should use this endpoint — workers and orchestrator communicate via messages API
