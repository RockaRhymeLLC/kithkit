# Messages API Reference

Inter-agent messaging — send messages between agents and retrieve history.

## POST /api/messages

Send a message between agents. Messages are logged and auditable.

```bash
curl -X POST http://localhost:3847/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"from": "orchestrator", "to": "comms", "type": "result", "body": "Task complete"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Sender agent ID |
| `to` | string | yes | Recipient agent ID |
| `body` | string | yes | Message content |
| `type` | string | no | Message type (default: `text`). Common types: `text`, `task`, `result`, `status` |
| `metadata` | object | no | Arbitrary key/value pairs |

**Responses:**

| Status | Body |
|--------|------|
| 200 | `{ "messageId": "...", "delivered": true, "timestamp": "..." }` |
| 400 | Missing `from`, `to`, or `body` |
| 403 | Worker attempted a restricted send (workers can only message their spawning orchestrator) |

**Gotchas:**
- Workers can only message the orchestrator that spawned them — sending to other targets returns 403
- Message type defaults to `text` if not specified
- The `delivered` field indicates if the message was routed to the recipient's session

---

## GET /api/messages

Get message history for an agent.

```bash
# All messages for an agent
curl "http://localhost:3847/api/messages?agent=comms"

# Filter by type with limit
curl "http://localhost:3847/api/messages?agent=comms&type=result&limit=10"

# Unread messages (marks them as read)
curl "http://localhost:3847/api/messages?agent=comms&unread=true"
```

**Query params:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | yes | Agent ID to fetch messages for |
| `type` | string | no | Filter by message type |
| `limit` | number | no | Max number of results |
| `unread` | string | no | Set to `"true"` to get unread messages only (also marks them as read) |

**Response (200):**
```json
{
  "data": [
    {
      "id": "msg-uuid",
      "from": "orchestrator",
      "to": "comms",
      "body": "Task complete",
      "type": "result",
      "metadata": null,
      "created_at": "2026-02-22T10:00:00.000Z"
    }
  ],
  "timestamp": "..."
}
```

**Gotchas:**
- The `agent` query param is required — omitting it returns 400
- `unread=true` is a consume-once pattern: it returns unread messages AND marks them as read in the same call
- Messages are ordered by `created_at`
