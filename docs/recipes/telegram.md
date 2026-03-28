# Recipe: Telegram Bot Integration

Connect your Kithkit agent to Telegram so users can message it naturally from their phone. The agent receives messages, injects them into its Claude session, and replies via the Bot API.

Kithkit supports two modes: **webhook** (recommended for production) and **long-polling** (easier for development).

---

## Prerequisites

- A running Kithkit daemon (`http://localhost:3847` or your configured port)
- A tmux session with an active Claude Code session
- A Telegram account to create a bot through @BotFather
- For webhook mode: a publicly reachable HTTPS endpoint (Cloudflare Tunnel or ngrok)
- Node.js 22+ (daemon runtime)

---

## Setup Steps

### Step 1 — Create a bot via @BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts (pick a name and username)
3. BotFather will return a token like `7123456789:AAHxyz...` — copy it

### Step 2 — Store the token in Keychain

```bash
security add-generic-password \
  -s credential-telegram-bot \
  -a telegram \
  -w "YOUR_BOT_TOKEN_HERE"
```

Verify it stored correctly:

```bash
security find-generic-password -s credential-telegram-bot -w
```

### Step 3A — Webhook mode (production)

Webhook mode lets Telegram push updates to your daemon over HTTPS. You need a tunnel to expose your local daemon port.

**Option A: Cloudflare Tunnel**

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Authenticate and create a tunnel
cloudflared tunnel login
cloudflared tunnel create your-agent-tunnel

# Route traffic to your daemon port
cloudflared tunnel route dns your-agent-tunnel your-agent.yourdomain.com

# Start the tunnel (or configure launchd for persistence)
cloudflared tunnel run --url http://localhost:3847 your-agent-tunnel
```

**Option B: ngrok (quick local testing)**

```bash
brew install ngrok
ngrok http 3847
# Note the https://xxxx.ngrok.io URL it assigns
```

**Register the webhook with Telegram:**

```bash
TOKEN=$(security find-generic-password -s credential-telegram-bot -w)
WEBHOOK_URL="https://your-agent.yourdomain.com/telegram"

curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  | jq .
```

Expected response:

```json
{ "ok": true, "result": true, "description": "Webhook was set" }
```

Verify webhook is active:

```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq .
```

### Step 3B — Long-polling mode (development)

No tunnel required. The daemon polls Telegram for updates at a regular interval.

Delete any existing webhook first (polling and webhooks are mutually exclusive):

```bash
TOKEN=$(security find-generic-password -s credential-telegram-bot -w)
curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook" | jq .
```

Then set `mode: polling` in your config (see Config Snippet below).

### Step 4 — Add your chat ID to kithkit.config.yaml

Find your chat ID by sending a message to your bot, then:

```bash
TOKEN=$(security find-generic-password -s credential-telegram-bot -w)
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" | jq '.result[0].message.chat.id'
```

Add yourself as an authorized sender in `kithkit.config.yaml`:

```yaml
channels:
  telegram:
    owner: "123456789"          # primary owner chat ID
    allowed_users:              # additional trusted users (optional)
      - "987654321"
```

---

## Config Snippet

### Webhook mode

```yaml
channels:
  telegram:
    enabled: true
    webhook_path: "/telegram"
    # mode defaults to "webhook" when webhook_path is set
    typing_indicator: true
    media_save_path: ".kithkit/state/telegram-media/"
    channel_modes:
      - name: telegram          # Standard: forward transcript to Telegram
      - name: telegram-verbose  # Include tool outputs and intermediate steps
      - name: silent            # Daemon runs but Telegram receive-only
```

### Long-polling mode

```yaml
channels:
  telegram:
    enabled: true
    mode: polling
    poll_interval_ms: 2000
    typing_indicator: true
    media_save_path: ".kithkit/state/telegram-media/"
```

---

## Reference Code

### Architecture overview

```
Telegram Cloud
    │  (HTTPS POST, update JSON)
    ▼
Cloudflare Tunnel / ngrok
    │
    ▼
Daemon webhook handler  (/telegram)
    │  classify sender, deduplicate update_id
    │  extract text / media
    ▼
tmux inject
    │  "[Telegram] Alice: message text"
    ▼
Claude session (stdin)
    │  generates response
    ▼
Transcript stream (JSONL watcher)
    │  detects new assistant turn
    ▼
sendMessage()  →  Telegram Cloud  →  User's phone
```

### Webhook route handler (TypeScript)

```typescript
import express from "express";
import { execFile } from "child_process";

const SEEN_UPDATE_IDS = new Set<number>();
const MAX_SEEN = 1000; // rolling cap to prevent unbounded growth

app.post(config.channels.telegram.webhook_path, async (req, res) => {
  res.sendStatus(200); // always ack immediately — Telegram retries on non-200

  const update = req.body;
  const updateId: number = update.update_id;

  // Deduplicate (Telegram can deliver duplicates on retry)
  if (SEEN_UPDATE_IDS.has(updateId)) return;
  SEEN_UPDATE_IDS.add(updateId);
  if (SEEN_UPDATE_IDS.size > MAX_SEEN) {
    const oldest = SEEN_UPDATE_IDS.values().next().value;
    SEEN_UPDATE_IDS.delete(oldest);
  }

  const message = update.message || update.edited_message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const firstName = message.from?.first_name ?? "Unknown";
  const text = message.text ?? "";

  // Classify sender tier
  const tier = classifySender(chatId); // "safe" | "approved" | "pending" | "blocked"
  if (tier === "blocked") return;
  if (tier === "pending") {
    queueForApproval(chatId, firstName, text);
    return;
  }

  // Format injection string
  const prefix = tier === "approved"
    ? `[3rdParty][Telegram] ${firstName}`
    : `[Telegram] ${firstName}`;
  const injected = `${prefix}: ${text}`;

  // Handle media attachments
  if (message.photo) {
    await saveMedia(message.photo, chatId);
  }
  if (message.voice) {
    const transcript = await transcribeVoice(message.voice);
    injectToSession(`${prefix}: [voice] ${transcript}`);
    return;
  }

  injectToSession(injected);
});

function injectToSession(text: string): void {
  // Write to tmux pane — adjust session/window/pane to your config
  execFile("tmux", ["send-keys", "-t", "your-agent:0.0", text, "Enter"]);
}
```

### Sending a message

```typescript
const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4000; // Telegram hard limit is 4096; leave headroom

export async function sendMessage(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  const truncated =
    text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH - 3) + "..."
      : text;

  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: truncated }),
  });
}
```

### Typing indicator

Show a "typing..." status while the agent is working. Post `sendChatAction` every 4 seconds; Telegram clears it automatically after 5 seconds of inactivity. Apply a 3-minute safety cap so a stuck agent doesn't type forever.

```typescript
const TYPING_INTERVAL_MS = 4000;
const TYPING_MAX_DURATION_MS = 3 * 60 * 1000;

export function startTypingIndicator(
  token: string,
  chatId: string
): NodeJS.Timeout {
  const start = Date.now();

  const interval = setInterval(async () => {
    if (Date.now() - start > TYPING_MAX_DURATION_MS) {
      clearInterval(interval);
      return;
    }
    await fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
  }, TYPING_INTERVAL_MS);

  return interval;
}
```

### Sender classification

Sender authorization is driven by `kithkit.config.yaml`. The `owner` and `allowed_users` fields under `channels.telegram` define trusted senders. Third-party approved senders live in `.kithkit/state/3rd-party-senders.json`.

```typescript
// Classification is handled by registerAgentTiers() in the Telegram adapter.
// Safe senders come from config (channels.telegram.owner + allowed_users).
// Third-party approved senders come from .kithkit/state/3rd-party-senders.json.
// To add a new trusted sender: update kithkit.config.yaml and POST /api/config/reload.
```

### Media handling

```typescript
import fs from "fs/promises";
import path from "path";

const MEDIA_DIR = ".kithkit/state/telegram-media";

export async function saveMedia(
  photos: any[],
  chatId: string
): Promise<string> {
  // Telegram sends multiple sizes — take the largest
  const largest = photos[photos.length - 1];
  const fileId: string = largest.file_id;

  // Get the file path from Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN!;
  const infoRes = await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${fileId}`
  );
  const info = (await infoRes.json()) as any;
  const filePath: string = info.result.file_path;

  // Download
  const fileRes = await fetch(
    `${TELEGRAM_API}/file/bot${token}/${filePath}`
  );
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const ext = path.extname(filePath) || ".jpg";
  const dest = path.join(MEDIA_DIR, `${fileId}${ext}`);
  await fs.writeFile(dest, buffer);

  return dest; // return local path for injection into session context
}
```

---

## Troubleshooting

**Webhook not receiving updates**

- Check your tunnel is running: `curl https://your-agent.yourdomain.com/health`
- Confirm webhook is registered: `curl https://api.telegram.org/bot{TOKEN}/getWebhookInfo`
- Look for `last_error_message` in the webhook info response — Telegram reports delivery errors there
- Ensure the daemon is listening on the correct port and the webhook path matches `webhook_path` in config

**Double messages**

- Do NOT call `sendMessage()` directly if `channel.txt` is set to `telegram` — the transcript stream already forwards agent output. Calling both causes duplicates.
- Only call `sendMessage()` directly when the channel is `silent` and you need proactive outreach

**Messages arriving but agent not responding**

- Check tmux session is active: `tmux ls`
- Verify the pane target in your `injectToSession()` call matches your session name/window/pane
- Check the Claude session isn't waiting for input mid-tool-call

**3rd party messages not tagged correctly**

- Confirm the sender is in `.kithkit/state/3rd-party-senders.json` (for third-party approved senders), or add their chat ID to `kithkit.config.yaml` (for trusted users)
- The `[3rdParty]` prefix is what triggers restricted capability mode in the agent

**Media not saving**

- Confirm `telegram-media/` directory exists and is writable: `ls -la .kithkit/state/telegram-media/`
- Check the bot token has not expired (BotFather lets you revoke/regenerate tokens)

**Polling mode conflicts with webhook**

- Telegram will reject polling (`getUpdates`) if a webhook is registered. Run `deleteWebhook` first.
- You cannot run both modes simultaneously
