---
name: telegram
description: Compose and send Telegram messages to Dave or other recipients via the daemon send API. Use when sending important messages, quick updates, or notifications through Telegram.
argument-hint: ["message"] | ["message" to <recipient>]
---

# Telegram Messaging

Send Telegram messages through the daemon's channel router. Defaults to Dave (owner) as recipient.

## Commands

Parse $ARGUMENTS to determine the action:

### Send a Message
- `"Hello, just checking in"` — Send to Dave (default)
- `"Meeting moved to 3pm" to Dave` — Explicit recipient (same as default)
- `"Status update: deploy complete"` — Quick notification

If no message is provided, ask the user what they want to send.

## Implementation

### Sending via Daemon API

Use the daemon's send endpoint to route through Telegram:

```bash
curl -s -X POST http://localhost:3847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"message":"MESSAGE_TEXT","channels":["telegram"]}'
```

### Workflow

1. **Parse arguments**: Extract the message text (strip surrounding quotes if present)
2. **Send**: POST to `http://localhost:3847/api/send` with `channels: ["telegram"]`
3. **Check result**: Verify `results.telegram` is `true` in the response
4. **Confirm**: Tell the user the message was sent (or report the error)

### Error Handling

- If the daemon is not running (`connection refused`), tell the user
- If Telegram delivery fails (`results.telegram: false`), report it
- Never retry automatically — let the user decide

## Examples

```
/telegram "Hey Dave, the PR is ready for review"
/telegram "Build passed, deploying to staging now"
/telegram "Quick question — did you want me to set up the cron job?"
```

## Notes

- Messages are sent through the channel router, which handles Telegram Bot API details
- The owner chat ID is configured in `kithkit.config.yaml` under `channels.telegram.owner`
- Max message length: 4000 chars (Telegram limit, auto-truncated by the adapter)
- This skill is for the comms agent to send outbound messages — inbound Telegram messages are handled automatically by the webhook

### Group Chat Routing
The Telegram channel adapter handles both DM and group chat messages. Inbound group messages are tagged with `[group:<group_name>]` in the injection prefix. Outbound messages to groups require specifying the group chat ID instead of the owner chat ID — configure additional chat IDs in `kithkit.config.yaml` under `channels.telegram.groups`.
