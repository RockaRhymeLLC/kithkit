---
name: telegram
description: Reference for Telegram integration - sending messages, receiving media, gateway architecture, and API patterns. Use when working with Telegram features.
user-invocable: false
---

# Telegram Integration

Reference for working with Telegram.

**See also**: [setup.md](setup.md) for setup instructions and API basics.

## Architecture Overview (v2 — Daemon)

```
Telegram Cloud → Webhook → Cloudflare Tunnel → Daemon (port 3847) → tmux injection
                                                     ↓
                                              channel.txt = "telegram"
                                                     ↓
                                              Transcript Stream → sends responses to Telegram
```

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Telegram Adapter | `daemon/src/comms/adapters/telegram.ts` | Receives webhooks, downloads media, injects to tmux, sends messages |
| Transcript Stream | `daemon/src/comms/transcript-stream.ts` | Watches transcript JSONL, sends assistant text to active channel |
| Channel Router | `daemon/src/comms/channel-router.ts` | Routes outgoing messages to the active channel |
| Channel Flag | `.claude/state/channel.txt` | Current output channel: `terminal`, `telegram`, or `silent` |
| Channel Hook | `.claude/hooks/set-channel.sh` | UserPromptSubmit hook - auto-detects channel from message source |
| Send Utility | `scripts/telegram-send.sh` | Manual message/typing indicator sending |
| Media Storage | `.claude/state/telegram-media/` | Downloaded photos and documents |

### How It Works

1. **Incoming**: Telegram message → Daemon webhook → sets `channel.txt` to `telegram` → injects message into tmux session
2. **Outgoing**: You write response → transcript entry added → daemon transcript stream detects new assistant text → reads channel → sends to Telegram
3. **Channel switching**: UserPromptSubmit hook detects `[Telegram]` prefix → sets channel to `telegram`. Direct terminal input → sets channel to `terminal`.

### Channel Modes

| Channel | Behavior |
|---------|----------|
| `terminal` | Responses stay in terminal only (default) |
| `telegram` | Text responses sent to user via Telegram (no thinking blocks) |
| `telegram-verbose` | Text + thinking blocks sent to Telegram |
| `silent` | No messages sent anywhere — you work quietly |

**To change channel manually**: Write to `.claude/state/channel.txt` or ask the user (e.g., "switch to verbose", "go silent").

**Auto-detection**: The `set-channel.sh` hook runs on every prompt and sets the channel based on whether the message has a `[Telegram]` prefix. It preserves `-verbose` suffix if already in verbose mode.

## Proactive Communication

**IMPORTANT**: Switch to `telegram` channel proactively when:
- Something goes wrong and you need the user's input
- You're blocked and need a decision to proceed
- Something important or urgent needs the user's attention
- You believe the user should know about something immediately

Your human is here to help. If you need them, reach out.

To do this:
```bash
echo "telegram" > .claude/state/channel.txt
```
Then write your message as normal text — the daemon's transcript stream will send it.

## Sending Messages

### Which Method to Use

**IMPORTANT**: Do NOT double-send. The channel mode determines how to send:

| Channel | How to Send | Why |
|---------|-------------|-----|
| `telegram` | Just write to terminal — the daemon delivers | Transcript stream is active and forwarding. Using telegram-send.sh would cause duplicate messages. |
| `telegram-verbose` | Just write to terminal — the daemon delivers | Same as above, but thinking blocks also forwarded. |
| `silent` | Use `telegram-send.sh` for important messages only | Transcript stream is NOT forwarding. Use sparingly — deliverables, alerts, blockers. |
| `terminal` | Don't send to Telegram at all | User is at the terminal. |

### Via Transcript Stream (channel = telegram)

Just write your response as normal terminal output. The daemon's transcript stream will detect the new assistant text and send it to Telegram automatically. No extra action needed.

### Via Utility Script (channel = silent only)
```bash
# With explicit chat ID (from safe-senders.json or memory)
TELEGRAM_CHAT_ID=CHAT_ID ./scripts/telegram-send.sh "Your message"

# Two-argument form
./scripts/telegram-send.sh "CHAT_ID" "Your message"

# Typing indicator
TELEGRAM_CHAT_ID=CHAT_ID ./scripts/telegram-send.sh typing
```

### Via API (curl)
```bash
BOT_TOKEN=$(security find-generic-password -s "credential-telegram-bot" -w)
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "CHAT_ID", "text": "Message"}'
```

## Receiving Messages

Messages arrive as `[Telegram] Name: content` in the conversation.

### Text Messages
```
[Telegram] Sam: Hello!
```

### Photos
```
[Telegram] Sam: [Sent a photo: /path/to/photo.jpg]
[Telegram] Sam: [Sent a photo: /path/to/photo.jpg] Optional caption
```

### Documents
```
[Telegram] Sam: [Sent a document: /path/to/file.pdf]
```

**To view media**: Use the Read tool on the file path.

## Daemon Details

### How Wake-on-Message Works
1. Daemon checks if tmux session exists
2. If not, runs `start-tmux.sh --detach`
3. Waits 12 seconds for Claude to initialize
4. Processes queued messages

### Media Download Process
1. Get `file_id` from message (photo/document)
2. Call `getFile` API to get `file_path`
3. Download from `https://api.telegram.org/file/bot{token}/{file_path}`
4. Save to `.claude/state/telegram-media/`

## Transcript Structure
- Entries are JSONL (one JSON object per line)
- Types: `assistant`, `user`, `progress`, `system`
- Assistant text is in `.message.content[]` where `.type == "text"`
- Each entry has a unique `uuid` and `timestamp`

## Gotchas

### Interactive UI Elements Don't Forward
- `AskUserQuestion`, multiple-choice prompts, and other TUI widgets render in the terminal but are NOT captured in the transcript JSONL
- When channel is `telegram`, the user will never see these — they only see text output from the transcript stream
- **Rule**: When channel is `telegram`, ask questions as plain text in your response instead of using interactive tools

### tmux Socket Path
- Scripts running from launchd need explicit socket path
- Use: `/opt/homebrew/bin/tmux -S /private/tmp/tmux-$(id -u)/default`

### Message Escaping
- Single quotes in messages need escaping for tmux: `'\\''`
- JSON in curl needs proper quoting

### Telegram Message Limits
- Max message length: 4096 characters
- Daemon truncates at 4000 chars with "..." suffix

## Telegram API Reference

### Useful Endpoints
| Endpoint | Purpose |
|----------|---------|
| `sendMessage` | Send text message |
| `sendChatAction` | Send typing indicator |
| `getFile` | Get file path for download |
| `getMe` | Verify bot token |

### Chat Actions
- `typing` - Text typing indicator
- `upload_photo` - Photo upload indicator
- `upload_document` - Document upload indicator

### Bot Token
Stored in Keychain as `credential-telegram-bot`

```bash
security find-generic-password -s "credential-telegram-bot" -w
```

### Chat ID
Stored in safe-senders.json and/or memory.

## Testing

### Verify Daemon Running
```bash
curl http://localhost:3847/health
```

### Check Daemon Logs
```bash
tail -f logs/daemon.log
```

## Future Enhancements

- [ ] Voice message transcription
- [ ] Location handling
- [ ] Reply context (know what message is being replied to)
- [ ] Inline keyboards for quick responses
- [ ] Edit previous messages instead of sending new ones
