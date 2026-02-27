# Telegram Bot Integration

Connect Kithkit's comms agent to Telegram so messages from safe senders are injected into the Claude session and replies are sent back via the bot.

## Prerequisites

- Kithkit daemon running (`GET /health` returns 200)
- Telegram account
- For webhook mode: a publicly reachable HTTPS endpoint (Cloudflare Tunnel or ngrok)

## Setup

### 1. Create a bot

Open Telegram, start a chat with `@BotFather`, and run:

```
/newbot
```

Follow the prompts. BotFather will give you an HTTP API token.

### 2. Store token in Keychain

```bash
security add-generic-password -s credential-telegram-bot -a bmo -w "<YOUR_TOKEN>"
```

The daemon reads this credential at startup.

### 3. Find your chat ID

Start a conversation with your bot, then call:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'
```

### 4. Set up delivery — choose one mode

**Webhook mode (recommended for production)**

Point Telegram at your HTTPS endpoint:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-tunnel.example.com/telegram/webhook"
```

Verify:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

**Polling mode (simpler, no public URL needed)**

Set `polling: true` in config (see below). The daemon polls every few seconds. Do not use alongside webhook — Telegram will reject one of them.

### 5. Add your chat ID to safe-senders

Edit `kithkit.config.yaml`:

```yaml
telegram:
  safe_senders:
    - chat_id: 123456789   # your personal Telegram user ID
      name: Dave
```

## Configuration

### Webhook mode

```yaml
extensions:
  telegram:
    enabled: true
    mode: webhook
    webhook_path: /telegram/webhook
    token_credential: credential-telegram-bot
    safe_senders:
      - chat_id: 123456789
        name: Dave
    media_dir: data/telegram-media
    max_message_length: 4000
```

### Polling mode

```yaml
extensions:
  telegram:
    enabled: true
    mode: polling
    poll_interval_ms: 3000
    token_credential: credential-telegram-bot
    safe_senders:
      - chat_id: 123456789
        name: Dave
    media_dir: data/telegram-media
    max_message_length: 4000
```

## Architecture

```
Telegram Cloud
      |
      | HTTPS POST (webhook) or GET (polling)
      v
Cloudflare Tunnel / ngrok
      |
      v
Daemon  /telegram/webhook
      |
      | classify sender
      | dedup update_id
      v
tmux inject -> comms session (Claude)
      |
      v
Claude processes message
      |
      v
POST /api/send  { channels: ["telegram"] }
      |
      v
Daemon  sendMessage API
      |
      v
Telegram Cloud -> User
```

## Key Reference Code

### Webhook handler with dedup

```typescript
// extensions/telegram/webhook.ts
const seen = new Set<number>();

app.post(config.webhook_path, async (req, res) => {
  const update = req.body as TelegramUpdate;
  res.sendStatus(200); // ack immediately

  if (!update.message) return;
  const { update_id, message } = update;

  // Dedup: Telegram may retry on timeout
  if (seen.has(update_id)) return;
  seen.add(update_id);
  if (seen.size > 1000) {
    const first = seen.values().next().value;
    seen.delete(first);
  }

  const classification = classifySender(message.chat.id);
  if (classification === 'blocked') return;
  if (classification !== 'safe') {
    await notifyPending(message);
    return;
  }

  await injectToSession(message.text ?? '[media]');
});
```

### sendMessage with truncation

```typescript
async function sendMessage(chatId: number, text: string): Promise<void> {
  const MAX = 4000; // Telegram limit is 4096; leave headroom
  const chunks: string[] = [];

  for (let i = 0; i < text.length; i += MAX) {
    chunks.push(text.slice(i, i + MAX));
  }

  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }),
    });
  }
}
```

### Typing indicator

```typescript
// Send "bot is typing" while Claude works.
// Max 3 minutes to avoid runaway loops.

async function withTyping(chatId: number, fn: () => Promise<void>): Promise<void> {
  const MAX_MS = 3 * 60 * 1000;
  const INTERVAL_MS = 4000;
  const start = Date.now();

  const timer = setInterval(async () => {
    if (Date.now() - start > MAX_MS) { clearInterval(timer); return; }
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  }, INTERVAL_MS);

  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
}
```

### Sender classification

```typescript
type SenderClass = 'safe' | 'approved' | 'pending' | 'blocked';

function classifySender(chatId: number): SenderClass {
  const entry = config.safe_senders.find(s => s.chat_id === chatId);
  if (!entry) return 'pending';
  return entry.status ?? 'safe';
}
```

### Media handling

```typescript
// Download and save a photo (largest available size)
async function savePhoto(photo: TelegramPhotoSize[]): Promise<string> {
  const largest = photo.sort((a, b) => b.file_size - a.file_size)[0];
  const fileInfo = await getFile(largest.file_id);
  const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const dest = path.join(config.media_dir, path.basename(fileInfo.file_path));
  await downloadToFile(url, dest);
  return dest;
}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Webhook receives nothing | Telegram can't reach your URL | Check tunnel is running; re-register webhook URL |
| Double messages delivered | Webhook AND polling both active | Set only one mode; delete webhook with `deleteWebhook` API |
| Agent not responding to messages | Chat ID not in safe_senders | Add the correct chat ID; check classification logs |
| Media files not saving | `media_dir` missing or not writable | Create directory; check permissions |
| Polling conflicts / 409 errors | Webhook still registered | Call `deleteWebhook` before enabling polling |
| Markdown render errors | Unescaped special chars | Strip or escape `_*[]()~` in output before sending |
