---
name: telegram-tos
description: Telegram Bot API Terms of Service compliance — rate limits, webhook rules, privacy requirements, bot interaction rules. Use before Telegram bot operations or configuration changes.
user-invocable: false
---

# Telegram Bot API TOS Compliance

Reference skill for operating within Telegram's Bot Developer Terms of Service. Loaded automatically when performing Telegram bot operations.

**Why this exists**: The assistant's primary communication channel with the user is via Telegram bot. These rules ensure the bot stays active and the account doesn't get flagged.

## Hard Rules (Violations = Bot Removed / Account Suspended)

1. **No spam**: No unsolicited bulk messaging (Bot Dev TOS, Prohibited Activities)
2. **No data scraping**: Cannot collect data to build datasets or ML/AI models
3. **No circumventing rate limits** — explicitly prohibited
4. **No impersonation** of Telegram or unauthorized entities
5. **No sharing user data with third parties** without explicit consent
6. **No phishing**: Cannot request passwords or OTPs
7. **No malware distribution**
8. **No MLM schemes or social growth manipulation**
9. **Data must be encrypted at rest**, keys stored separately from data
10. **Must have a privacy policy** accessible to users

## Rate Limits

### Message Sending

| Limit | Value |
|-------|-------|
| Per-chat (same chat) | ~1 msg/sec (brief bursts tolerated) |
| Group chats | 20 msgs/min per group |
| Bulk (different chats) | ~30 msgs/sec global |
| API requests overall | ~30 req/sec all methods |

### Our Usage
At 50-100 messages/day to a single chat, we average ~0.001 msg/sec — orders of magnitude below limits. Even burst scenarios (morning briefing, digest) send 3-5 messages in seconds, well within tolerance.

### 429 Handling
When receiving HTTP 429: extract `retry_after` from response body and wait that duration before retrying. Do NOT retry immediately.

### Content Limits

| Limit | Value |
|-------|-------|
| Message text | 4,096 characters |
| Caption | 1,024 characters (4,096 for Premium) |
| Upload (standard API) | 50 MB |
| Download (standard API) | 20 MB |
| Inline results per page | 50 |

Our daemon truncates at 4,000 characters — compliant.

## Webhook Requirements

- **HTTPS mandatory** — no plain HTTP webhooks
- **TLS 1.2 minimum**
- **Supported ports**: 443, 80, 88, 8443 only
- **IPv4 required** — IPv6 not supported
- **Telegram source IPs**: `149.154.160.0/20` and `91.108.4.0/22`

**Our setup**: Telegram → Cloudflare Tunnel (port 443, TLS) → Daemon (port 3847). Fully compliant.

## Bot Interaction Rules

### Fundamental Rules
- **Bots cannot initiate conversations** — users must message first
- **Bots must respond to all incoming messages** — BotFather monitors response rates
- **Bots cannot message other bots** — bot-to-bot blocked

### Required Commands
- `/start` — Must be implemented (initiates interaction)
- `/help` — Must provide functionality overview
- `/settings` — Display user-specific settings (when applicable)

### Our Compliance
- The user always initiates. We send proactive notifications because they started the conversation first -- compliant.
- **Action needed**: Register `/start`, `/help`, `/settings` with BotFather if not already done.

## Privacy & Data

### Requirements
- **Privacy policy**: All bots MUST have one (set via BotFather)
- **Data minimization**: Only collect/store data essential to function
- **Delete on request**: Must delete data when user requests
- **Consent**: Users must give explicit, active, revocable consent

### Our Status
- **Privacy policy**: Should set one via BotFather (even Telegram's standard policy)
- **Data minimization**: Transcript JSONL with 7-day retention ✓
- **Consent**: The user explicitly configured the bot ✓
- **Action needed**: Set privacy policy via BotFather

## Bot Token Security

- Token stored in Keychain as `credential-telegram-bot` ✓
- Not in plaintext files, env vars, or git ✓
- **If compromised**: Revoke immediately via BotFather `/revoke`, generate new token, update all systems

## AI Agent Operating a Bot

**No explicit prohibition**. The TOS governs "bot developers" and their applications without distinguishing human-operated vs AI-operated. Requirements are behavioral (no spam, rate limit compliance, data protection) — the control mechanism is unrestricted.

## Action Items

| Priority | Action |
|----------|--------|
| Medium | Set privacy policy via BotFather |
| Medium | Register /start, /help, /settings commands |
| Low | Implement 429 backoff with `retry_after` in daemon |
| Low | Verify webhook TLS chain is complete |

## Key TOS References

| Document | Topic |
|----------|-------|
| Bot Developer TOS | Prohibited activities, data handling, privacy |
| General TOS | Platform-wide rules |
| Bot API Documentation | API reference, rate limits |
| Bot Features | Privacy mode, commands, interaction rules |
| Webhooks Guide | Setup, security, requirements |
