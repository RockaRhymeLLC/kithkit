# Browserbase Integration — Setup & API Reference

Detailed reference for Browserbase cloud browser setup, API endpoints, and troubleshooting.

**Operational guide**: See [SKILL.md](SKILL.md) for decision matrix, session patterns, and hand-off protocol.

## Architecture Overview

```
Assistant (Claude Code)
  ↕ injects/reads tmux
Daemon (port 3847)
  ↕ HTTP (localhost)
Browser Sidecar (port 3849)
  ↕ CDP over WebSocket
Browserbase Cloud Chrome
  ↕ live view URL
Human's phone/laptop (Telegram link)
```

**Key principle**: The assistant drives, the human assists when blocked. The hand-off is an escape valve, not the primary mode.

## Session Lifecycle

### Starting a Session

```
POST http://localhost:3849/session/start
{
  "url": "https://example.com",          // Optional: navigate immediately
  "contextName": "verizon",              // Optional: reuse saved cookies
  "keepAlive": true                      // Optional: survive disconnects
}
```

**Returns**: `{ sessionId, liveViewUrl, screenshot? }`

Session creation automatically:
- Sets region to `us-east-1` (default, configurable)
- Blocks ads
- Disables session recording (privacy — banking/password screens)
- Sets server-side timeout matching config (safety net if sidecar crashes)
- Enables CAPTCHA auto-solving (Browserbase default on Developer plan)

### Navigating

```
POST /session/navigate  { "url": "https://..." }
POST /session/click     { "selector": "#login-btn" } or { "text": "Sign In" }
POST /session/type      { "text": "...", "selector": "#email" }
POST /session/scroll    { "direction": "down", "amount": 500 }
GET  /session/screenshot
```

All navigation endpoints return a screenshot.

### Closing a Session

```
POST http://localhost:3849/session/stop
{ "saveContext": true }   // Persist cookies for next time
```

### Context Persistence

Contexts store cookies and localStorage across sessions. One context per site.

```
GET  /contexts                    — List all saved contexts
POST /session/start { "contextName": "chase" }  — Reuse or auto-create
DELETE /contexts/verizon          — Delete a context
```

Context names map to Browserbase context IDs in `.claude/state/browser-contexts.json`.

## Hand-Off Timeouts

| Timer | Default | What happens |
|-------|---------|-------------|
| Session timeout | 5 min (configurable) | Warning at T-60s, then session auto-closes |
| Hand-off idle warning | 10 min | Human gets "still there?" message |
| Hand-off idle timeout | 30 min | Session closes, hand-off deactivated |

Idle timers reset on every `type:`, `click`, `scroll`, or `screenshot` interaction.

## API Quick Reference

### Daemon endpoints (port 3847)

| Endpoint | Purpose |
|----------|---------|
| `POST /browser/handoff/start` | Activate hand-off mode |
| `POST /browser/handoff/stop` | Deactivate hand-off |
| `GET /browser/handoff/status` | Check hand-off state |
| `POST /browser/timeout-warning` | Receives timeout alerts from sidecar |

### Sidecar endpoints (port 3849)

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check |
| `POST /session/start` | Create session |
| `POST /session/stop` | Close session |
| `GET /session/status` | Session info |
| `GET /session/screenshot` | Take screenshot |
| `POST /session/navigate` | Go to URL |
| `POST /session/click` | Click element |
| `POST /session/type` | Type text |
| `POST /session/scroll` | Scroll page |
| `GET /contexts` | List contexts |
| `DELETE /contexts/:name` | Delete context |
| `POST /cleanup` | Orphan recovery |
| `POST /handoff/set` | Update hand-off flag |

## Troubleshooting

### Session won't start
- Check sidecar health: `curl http://localhost:3849/health`
- Check credentials: `security find-generic-password -s credential-browserbase-api-key -w`
- Check Browserbase status: session creation returns specific error codes

### CAPTCHA not auto-solving
- Auto-solve works on basic visual CAPTCHAs, takes 5-30 seconds
- For Cloudflare challenges, reCAPTCHA v3, or complex CAPTCHAs: hand off to human
- Adding proxies (`proxies: true` in session creation) improves CAPTCHA success rates

### Context/cookies expired
- Use `ctx.markExpired(name)` to flag stale context
- Delete and recreate: `DELETE /contexts/sitename`, then start fresh session with `contextName`
- Some sites expire cookies after 24-48 hours regardless

### Orphan sessions (sidecar crashed)
- On startup, sidecar auto-detects and cleans up orphan sessions
- Manual cleanup: `POST http://localhost:3849/cleanup`
- Server-side timeout ensures Browserbase releases the session even if cleanup fails

### Rate limits
- Developer plan: 25 concurrent sessions, 25 creates/minute
- Single-session guard in sidecar prevents accidental concurrency
- 429 errors get user-friendly messages via `wrapApiError()`

## Developer Plan Limits

| Resource | Limit |
|----------|-------|
| Browser hours/month | 100 (then $0.12/hr) |
| Proxy bandwidth | 1 GB (then $12/GB) |
| Concurrent sessions | 25 |
| Session duration max | 6 hours |
| Session creation rate | 25/minute |
| Data retention | 30 days |
| Projects | 2 |
| CAPTCHA solving | Included |
| Ad blocking | Included |
| Stealth mode | Basic |

## Credentials

Stored in macOS Keychain:
- `credential-browserbase-api-key` — API key
- `credential-browserbase-project-id` — Project ID

## Key Files

| File | Purpose |
|------|---------|
| `browser-sidecar/src/main.ts` | Sidecar HTTP server, timeouts, orphan recovery |
| `browser-sidecar/src/session-manager.ts` | Provider boundary — all Browserbase SDK calls |
| `browser-sidecar/src/context-store.ts` | Context manifest (name→ID mapping) |
| `daemon/src/browser/browser-sidecar.ts` | Sidecar process lifecycle management |
| `daemon/src/comms/adapters/telegram.ts` | Hand-off command interception |
| `.claude/state/browser-contexts.json` | Context manifest data |
| `.claude/state/browser-session.json` | Crash recovery state (transient) |

## Implementation Notes

Compared implementation against Browserbase docs:
- **Session recording**: OFF by default (privacy for banking/password screens)
- **Server-side timeout**: Passed to Browserbase API (not just client-side)
- **Region**: `us-east-1` default (configurable)
- **Ad blocking**: Enabled

Known gaps (acceptable for initial release):
- Context deletion doesn't call Browserbase delete API (local manifest only)
- Orphan recovery closes rather than reconnects (could improve with keepAlive)
- No proxy configuration (not needed yet; note: proxy providers block banking domains)
- No `userMetadata` tagging (nice-to-have for debugging)
- Stagehand AI integration not used (raw Playwright is more appropriate for current use case)
