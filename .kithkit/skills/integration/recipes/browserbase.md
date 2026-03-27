# Browser Automation (Browserbase Cloud)

Cloud browser automation with built-in human hand-off support. The daemon spawns a sidecar process on port 3849 that manages Browserbase SDK sessions, Playwright CDP connections, and live view URLs for hand-off to a human.

## Prerequisites

- Browserbase account with an API key and project ID
- Node.js 22+
- `@browserbasehq/sdk` and `playwright-core` npm packages

## Setup

```bash
# Store credentials in macOS Keychain (never in config files)
security add-generic-password -s credential-browserbase-api-key -a bmo -w "<your-api-key>"
security add-generic-password -s credential-browserbase-project-id -a bmo -w "<your-project-id>"

# Install dependencies in the daemon workspace
cd /path/to/kithkit-daemon
npm install @browserbasehq/sdk playwright-core

# Enable in config (see snippet below), then reload
curl -s -X POST http://localhost:3847/api/config/reload
```

## Config Snippet

```yaml
integrations:
  browserbase:
    enabled: true
    sidecar:
      port: 3849
      startup_timeout_ms: 15000
    credentials:
      api_key_secret: credential-browserbase-api-key      # Keychain secret name
      project_id_secret: credential-browserbase-project-id
    session:
      default_timeout_ms: 300000   # 5 min session TTL
      keep_alive: false            # set true during development
    handoff:
      enabled: true
      live_view_ttl_ms: 600000     # 10 min live view link lifetime
```

## Architecture

```
Daemon
  └── browser-sidecar (port 3849)
        ├── Browserbase SDK  ──── Browserbase Cloud
        ├── Playwright CDP   ──── Remote browser instance
        ├── Context store    ──── per-session state (cookies, storage)
        └── Hand-off infra   ──── live view URLs → human
```

The daemon starts the sidecar on first use and keeps it running. The sidecar is stateful — it maintains a map of active sessions and their Playwright page references. All browser commands go through the sidecar HTTP API; the daemon never calls Browserbase directly.

## Sidecar Endpoints

All endpoints are on `http://127.0.0.1:3849`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/session/create` | Create a new Browserbase session, returns `sessionId` and `liveViewUrl` |
| `POST` | `/session/navigate` | Navigate to URL — body: `{ sessionId, url }` |
| `POST` | `/session/click` | Click an element — body: `{ sessionId, selector }` |
| `POST` | `/session/type` | Type into an input — body: `{ sessionId, selector, text }` |
| `POST` | `/session/screenshot` | Returns PNG as base64 — body: `{ sessionId }` |
| `DELETE` | `/session/destroy` | End and release a session — body: `{ sessionId }` |
| `GET` | `/session/live-url` | Get live view URL for a session — query: `?sessionId=...` |
| `GET` | `/health` | Sidecar health check |

### Example: Create Session and Navigate

```bash
# Create session
curl -s -X POST http://localhost:3849/session/create \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

# Response:
# { "sessionId": "sess_abc123", "liveViewUrl": "https://www.browserbase.com/sessions/sess_abc123" }

# Navigate
curl -s -X POST http://localhost:3849/session/navigate \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sess_abc123", "url": "https://example.com"}'

# Take screenshot
curl -s -X POST http://localhost:3849/session/screenshot \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "sess_abc123"}' | jq -r .screenshot | base64 -d > shot.png
```

### Hand-off Flow

When a task requires human interaction (CAPTCHA, MFA, approval):

1. Worker requests live view URL via `GET /session/live-url?sessionId=...`
2. Worker sends URL to human via `POST /api/send` with `channels: ["telegram"]`
3. Human completes the action in the live browser
4. Worker polls for completion (element present, URL changed, etc.) or waits for human confirmation
5. Worker resumes automation

```typescript
// Example hand-off in a worker
const { liveViewUrl } = await fetch('http://localhost:3849/session/live-url?sessionId=' + sessionId)
  .then(r => r.json());

await fetch('http://localhost:3847/api/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: `I need you to complete a CAPTCHA. Open this link:\n${liveViewUrl}`,
    channels: ['telegram'],
  }),
});

// Wait for human to confirm via a todo or message check
```

## Troubleshooting

**Sidecar fails to start**
Check that `@browserbasehq/sdk` and `playwright-core` are installed in the daemon's `node_modules`. The sidecar script path must be absolute. Check daemon logs for the spawn error. Also verify port 3849 is not in use:
```bash
lsof -i :3849
```

**401 on session create**
The API key loaded from Keychain is wrong or stale. Retrieve and verify:
```bash
security find-generic-password -s credential-browserbase-api-key -w
```
Update via `security add-generic-password -U ...` with the `-U` (update) flag.

**CDP connection fails**
Browserbase returns a `connectUrl` for Playwright CDP. If the connection fails immediately, the Browserbase session may have already expired (they have a short idle TTL). Ensure you call navigate within a few seconds of creating the session, or set `keep_alive: true` in config during development.

**Live view URL unavailable**
The live view URL is generated at session creation time. If `GET /session/live-url` returns 404, the `sessionId` is not in the sidecar's active session map — either it was never created in this sidecar process or the sidecar restarted. Re-create the session.

**Hand-off timeout**
If the human does not act within the live view TTL (`live_view_ttl_ms`), the Browserbase session may expire. Build your hand-off flow with an explicit timeout: if no completion signal arrives within N minutes, destroy the session and report failure back to the orchestrator so it can inform the human.
