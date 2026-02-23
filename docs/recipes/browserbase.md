# Recipe: Browser Automation (Browserbase Cloud)

Set up cloud browser automation for your Kithkit agent using Browserbase. The daemon runs a sidecar process that manages Browserbase sessions and provides navigation primitives. Human hand-off via live view URLs enables unblocking when the agent encounters CAPTCHAs, logins, or verification steps.

---

## Prerequisites

- Browserbase account at [browserbase.com](https://www.browserbase.com)
- Browserbase API key
- Node.js 22+ (for the sidecar process)
- Kithkit daemon running (`curl http://localhost:3847/health`)

---

## Setup Steps

### 1. Get Browserbase credentials

Sign up at browserbase.com, then find your API key and project ID in the dashboard settings.

### 2. Store credentials in Keychain

```bash
security add-generic-password -s credential-browserbase-api-key -a default -w "YOUR_API_KEY"
security add-generic-password -s credential-browserbase-project-id -a default -w "YOUR_PROJECT_ID"
```

### 3. Install dependencies

In the browser sidecar directory:

```bash
npm install @browserbasehq/sdk playwright-core
```

### 4. Enable in config

```yaml
integrations:
  browserbase:
    enabled: true
    sidecar_port: 3849
    default_timeout: 300
    handoff_timeout: 300
    handoff_session_timeout: 1800
    block_ads: true
    solve_captchas: false
    record_sessions: false
```

---

## Architecture

```
Daemon (port 3847)
├── Spawns browser-sidecar on init
│   ├── HTTP server on port 3849
│   ├── Health checks every 30s
│   └── Auto-restart on crash (max 3 retries)
│
Browser Sidecar (port 3849)
├── Session Manager
│   ├── Browserbase SDK — session create/connect/destroy
│   ├── Playwright CDP — navigation, clicks, typing, screenshots
│   └── Context Store — saved login sessions per site
├── Hand-off Infrastructure
│   ├── Live view URL generation
│   ├── Telegram delivery for human interaction
│   └── Session resume after unblock
└── Endpoints
    ├── POST /session/create — new browser session
    ├── POST /session/navigate — go to URL
    ├── POST /session/click — click element
    ├── POST /session/type — type into element
    ├── POST /session/screenshot — capture page
    ├── POST /session/destroy — close session
    ├── GET  /session/live-url — get live view URL
    └── GET  /health — health check
```

---

## Config Snippet

```yaml
integrations:
  browserbase:
    enabled: true
    sidecar_port: 3849
    default_timeout: 300
    idle_warning: 120
    handoff_timeout: 300
    handoff_session_timeout: 1800
    block_ads: true
    solve_captchas: false
    record_sessions: false
```

**Keychain credentials**:
- `credential-browserbase-api-key` — Browserbase API key
- `credential-browserbase-project-id` — Browserbase project ID

---

## Troubleshooting

### Sidecar fails to start

Check that `@browserbasehq/sdk` and `playwright-core` are installed. The sidecar is a separate Node.js process with its own package.json.

### Session create fails (401)

API key is invalid or expired. Regenerate from the Browserbase dashboard and update Keychain.

### CDP connection fails

Browserbase sessions have a connect URL that changes per session. Ensure you are using the connectUrl from the session object, not a cached URL.

### Live view URL not available

Live view URLs are only generated for active sessions. If the session has been destroyed or timed out, create a new one.

### Hand-off times out

The default hand-off timeout is 5 minutes. If the user needs more time, increase handoff_timeout in config. The session itself stays alive for handoff_session_timeout (30 min default).
