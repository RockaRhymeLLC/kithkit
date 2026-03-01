# Telegram Integration

How to set up and use Telegram bot integration for the assistant.

**See also**: `.claude/skills/telegram/SKILL.md` for full architecture, channel modes, and operational details.

## Prerequisites

- Telegram account
- Bot created via @BotFather
- Bot token stored in Keychain

## Setup

### 1. Create a Bot

1. Open Telegram, search for `@BotFather`
2. Send `/newbot`
3. Follow prompts to name your bot
4. Save the bot token (looks like `123456789:ABCdefGHI...`)

### 2. Store Token in Keychain

```bash
security add-generic-password -a "assistant" -s "credential-telegram-bot" -w "YOUR_BOT_TOKEN" -U
```

### 3. Get Your Chat ID

1. Start a conversation with your bot
2. Send any message
3. Visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
4. Find your `chat.id` in the response

### 4. Add to Safe Senders

Update `.claude/state/safe-senders.json`:
```json
{
  "telegram": {
    "users": ["YOUR_CHAT_ID"]
  }
}
```

## Architecture

Responses are delivered via a transcript watcher that streams to the active channel.

See `.claude/skills/telegram/SKILL.md` for full architecture details, including:
- Channel modes (terminal, telegram, telegram-verbose, silent)
- Transcript watcher operation
- Gateway details
- Proactive communication guidelines

### Channel Modes (Quick Reference)

| Channel | Behavior |
|---------|----------|
| `terminal` | Responses stay in terminal only (default) |
| `telegram` | Text responses sent to Telegram (no thinking blocks) |
| `telegram-verbose` | Text + thinking blocks sent to Telegram |
| `silent` | No messages sent anywhere |

## Common Operations

### Send a Message

```bash
BOT_TOKEN=$(security find-generic-password -s "credential-telegram-bot" -w)
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "CHAT_ID", "text": "Message"}'
```

### Send with Markdown

```bash
curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "CHAT_ID", "text": "*Bold* and _italic_", "parse_mode": "Markdown"}'
```

## Security Notes

- Never log or expose the bot token
- Always verify sender is in safe senders list before processing
- Apply secure data gate rules (see CLAUDE.md)
- Bot token is stored encrypted in Keychain

## Troubleshooting

**Bot not responding:**
- Check token is correct
- Ensure gateway is running: `curl http://localhost:3847/health`
- Verify chat ID in safe senders
- Check watcher is running: `pgrep -f transcript-watcher`

**Permission denied:**
- Keychain may need unlock
- Check Keychain Access permissions
