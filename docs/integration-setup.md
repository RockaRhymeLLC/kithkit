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
