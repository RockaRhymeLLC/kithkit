# Integration Setup Guide

Post-migration integration wiring for kithkit instances. Follow this in order: Telegram, Email, Voice.

## Prerequisites

- Daemon running on `localhost:3847`
- Cloudflare tunnel active with routing to daemon port
- macOS Keychain accessible

## 1. Telegram

### Keychain Requirements

| Keychain Service | Purpose |
|---|---|
| `credential-telegram-bot` | Bot token from BotFather |
| `credential-telegram-chat-id` | Primary user's chat ID |
| `credential-shortcut-auth` | Siri Shortcut auth token |

### Setup Steps

1. **Verify keychain entries exist** — all three are required for full functionality
2. **Set webhook URL** — must point to your Cloudflare tunnel hostname:
   ```bash
   TOKEN=$(security find-generic-password -s "credential-telegram-bot" -w)
   curl -s "https://api.telegram.org/bot${TOKEN}/setWebhook" \
     -d "url=https://YOUR_HOSTNAME/telegram" \
     -d 'allowed_updates=["message","message_reaction"]' \
     -d 'max_connections=40'
   ```
3. **Verify webhook**: `curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"`
4. **Test send**:
   ```bash
   CHAT_ID=$(security find-generic-password -s "credential-telegram-chat-id" -w)
   curl -s "https://api.telegram.org/bot${TOKEN}/sendMessage" \
     -d "chat_id=${CHAT_ID}" -d "text=Integration test"
   ```
5. **Test receive** — send a message from Telegram and check daemon logs

### Common Issues

- **Keychain name mismatch**: The adapter reads `credential-telegram-bot` (NOT `credential-telegram-bot-token`). Check the adapter source if sends fail silently.
- **Webhook pointing to old domain**: After migration, the webhook URL may still point to a previous hostname. Always re-set it.
- **Read timeout errors in getWebhookInfo**: The daemon is not responding to webhook POSTs — check Cloudflare tunnel routing.

## 2. Email

### Graph API (M365)

| Keychain Service | Purpose |
|---|---|
| `credential-azure-client-id` | Azure AD app client ID |
| `credential-azure-tenant-id` | Azure AD tenant ID |
| `credential-azure-secret-value` | Azure AD client secret |
| `credential-graph-user-email` | Mailbox email address |

**Note**: The keychain entry is `credential-graph-user-email` (NOT `credential-azure-user-email`). This is a common mismatch when porting from other setups.

Verify token acquisition:
```bash
TENANT=$(security find-generic-password -s "credential-azure-tenant-id" -w)
CLIENT_ID=$(security find-generic-password -s "credential-azure-client-id" -w)
SECRET=$(security find-generic-password -s "credential-azure-secret-value" -w)
curl -s "https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token" \
  -d "client_id=${CLIENT_ID}" \
  -d "scope=https://graph.microsoft.com/.default" \
  -d "client_secret=${SECRET}" \
  -d "grant_type=client_credentials"
```

### Himalaya CLI

- Configured via `~/.config/himalaya/config.toml`
- Accounts use Keychain-backed credentials (gmail app password, etc.)
- Test: `/opt/homebrew/bin/himalaya envelope list --page-size 3`
- Himalaya v1.1.0: account flag is `-a NAME` on subcommands (not global)

### Config Provider Types

The daemon recognizes these `channels.email.providers[].type` values:
- `graph` — M365 Graph API adapter
- `himalaya` — Himalaya CLI adapter (requires `account` field)

**Not implemented**: `jmap`, `outlook` (logged as warnings). Use `graph` for Outlook/M365 and `himalaya` for Gmail/IMAP.

### Common Issues

- **Graph "not configured"**: Usually a keychain name mismatch on the user email entry
- **Himalaya OAuth hang**: Outlook OAuth tokens expire; re-auth requires interactive browser login (human must do this)
- **WARN lines in himalaya JSON output**: The adapter filters these, but they appear in stderr

## 3. Voice

### Prerequisites

| Component | Location | Install |
|---|---|---|
| whisper-cli | `/opt/homebrew/bin/whisper-cli` | `brew install whisper-cpp` |
| ffmpeg | `/opt/homebrew/bin/ffmpeg` | `brew install ffmpeg` |
| Python 3.12 | `/opt/homebrew/bin/python3.12` | `brew install python@3.12` |

### Model Files

Required in `PROJECT_ROOT/models/`:
- `ggml-small.en.bin` (465MB) — Whisper STT model
- `kokoro-v1.0.onnx` (310MB) — Kokoro TTS model
- `voices-v1.0.bin` (27MB) — Kokoro voice data

Download from HuggingFace or copy from an existing agent installation.

### Python Virtual Environment

```bash
python3.12 -m venv daemon/src/extensions/voice/.venv
daemon/src/extensions/voice/.venv/bin/pip install kokoro-onnx numpy
```

### Config

Set `channels.voice.enabled: true` in `kithkit.config.yaml`.

### Verification

1. **TTS worker health**: `curl -s http://localhost:3848/health`
2. **Voice status**: `curl -s http://localhost:3847/voice/status`
3. **TTS test**:
   ```bash
   curl -s -X POST http://localhost:3847/voice/speak \
     -H "Content-Type: application/json" \
     -d '{"text":"Hello, voice test."}' -o /tmp/test.wav
   file /tmp/test.wav  # Should show: RIFF WAVE audio, 16 bit, mono 24000 Hz
   ```
4. **STT test**: `curl -s -X POST http://localhost:3847/voice/stt --data-binary @/tmp/test.wav`
5. **Round-trip**: TTS -> STT should return the original text

### Common Issues

- **Voice crashes daemon on startup**: Missing Python venv — always create before enabling in config
- **TTS worker not ready**: Model loading can take a few seconds; check logs for `READY port=3848`
- **STT model not found**: Ensure `models/ggml-small.en.bin` exists
- **Python shebang**: tts-worker.py says `python3.12` — the venv must be Python 3.12
- **No voice clients connected**: Expected — the voice client app must register separately via `/voice/register`

## 4. Microsoft Teams

Kithkit integrates with Microsoft Teams via the Bot Framework. The Teams extension registers a `ChannelAdapter` named `teams` and an inbound webhook route (`POST /api/teams/messages`). Source: `daemon/src/extensions/teams/index.ts`.

### Keychain Requirements

| Keychain Service | Purpose |
|---|---|
| `credential-teams-bot-client-id` | Bot app ID (also the `MicrosoftAppId`); used for both inbound JWT verification and outbound auth |
| `credential-teams-bot-secret` | Bot app password — never logged |

### Config (`kithkit.config.yaml`)

```yaml
channels:
  teams:
    enabled: true
    tenantId: "<azure-tenant-id>"   # Required for single-tenant bots
```

Both keychain entries must be present or the extension disables itself at startup (logs a warning).

### How it works

**Inbound** — The Bot Framework sends a `POST /api/teams/messages` to your Cloudflare tunnel. The daemon verifies the RS256 JWT bearer token against the Bot Framework JWKS and injects valid `message` activities into the comms tmux session. Other activity types (e.g., `conversationUpdate`, `typing`) receive a `200 {"ok":true}` acknowledgement and are silently dropped.

**Outbound** — `POST /api/send` with `channel: "teams"` routes through the Teams adapter, which replies to the most recently seen conversation using the botframework-connector SDK. To target a specific conversation, pass `metadata.conversationId` in the request body.

The adapter does not support images, buttons, or HTML; markdown is passed through as-is. Max message length: 28,000 characters.

### Approval gate (optional)

To require human approval before outbound Teams messages are sent, add an entry to `approval_policies` in config:

```yaml
approval_policies:
  teams:
    require_approval_for: all
    timeout_minutes: 10
```

### Setup Steps

1. **Register a bot in Azure** — create an Azure Bot resource, note the bot app ID and secret
2. **Store credentials in Keychain**:
   ```bash
   security add-generic-password -s "credential-teams-bot-client-id" -a "$USER" -w "<bot-app-id>"
   security add-generic-password -s "credential-teams-bot-secret" -a "$USER" -w "<bot-password>"
   ```
3. **Set `channels.teams` in config** — enable the extension and set your Azure tenant ID
4. **Point the bot's messaging endpoint** at your Cloudflare tunnel:
   `https://YOUR_HOSTNAME/api/teams/messages`
5. **Restart the daemon** — look for `Teams extension initialized` in logs
6. **Test**: send a Teams message to the bot; confirm it appears in the comms session

### Common Issues

- **Extension not initializing**: Keychain entries are missing. The extension logs `Teams extension: credentials not found in Keychain — Teams disabled`.
- **Inbound 401 errors**: The Bot Framework JWT is failing verification. Confirm the bot app ID stored in `credential-teams-bot-client-id` matches the bot registered in Azure.
- **Outbound fails with "no conversation reference"**: The Teams adapter requires at least one inbound message before it can reply (the conversation reference is stored from inbound traffic). Send a message to the bot first.
- **Wrong tenant on outbound**: Ensure `channels.teams.tenantId` matches the Azure AD tenant where the bot is registered. Leaving it empty causes HTTP 400 from the connector.

---

## Post-Setup Checklist

- [ ] Daemon health: `curl localhost:3847/health` — status "ok"
- [ ] Telegram send test succeeds
- [ ] Telegram webhook set to current hostname
- [ ] Telegram webhook test via Cloudflare returns `{"ok":true}`
- [ ] Graph email adapter shows "enabled" in logs
- [ ] Himalaya adapter shows "enabled" in logs
- [ ] Voice extension shows "initialized" in logs
- [ ] TTS worker shows "READY" in logs
- [ ] TTS synthesis produces valid WAV
- [ ] STT transcription returns text
- [ ] Teams extension shows "initialized" in logs (if configured)
- [ ] Teams inbound message appears in comms session
