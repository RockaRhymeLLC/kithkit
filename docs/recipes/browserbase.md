# Cloud Browser Integration (Browserbase)

Integrate Browserbase cloud browsers into your Kithkit assistant for authenticated browsing, anti-bot bypass, and persistent session contexts — while keeping local Playwright for ordinary scraping.

---

## Prerequisites

- Browserbase account at [browserbase.com](https://www.browserbase.com)
- Browserbase API key
- Node.js 18+ (for the sidecar process)
- Kithkit daemon running (`curl http://localhost:3847/health`)

---

## Setup Steps

### 1. Sign up and get your API key

Create an account at [browserbase.com](https://www.browserbase.com). From the dashboard, navigate to **API Keys** and generate a new key.

### 2. Store the API key in Keychain

```bash
security add-generic-password \
  -s credential-browserbase-api-key \
  -a browserbase \
  -w "YOUR_API_KEY_HERE"
```

Verify it was stored:

```bash
security find-generic-password -s credential-browserbase-api-key -w
```

### 3. Install the sidecar dependencies

The Browserbase sidecar is a local HTTP proxy that manages cloud sessions on your behalf.

```bash
cd daemon
npm install @browserbasehq/sdk playwright-core
```

### 4. Configure the sidecar in your config file

Add the `browserbase` block under `integrations` (see Config Snippet below) and set `enabled: true`.

### 5. Enable the sidecar in the daemon

The daemon automatically starts the Browserbase sidecar when `integrations.browserbase.enabled` is `true`. Restart the daemon after updating config:

```bash
launchctl unload ~/Library/LaunchAgents/com.your-agent.daemon.plist
launchctl load  ~/Library/LaunchAgents/com.your-agent.daemon.plist
```

Confirm the sidecar is up:

```bash
curl http://localhost:3849/health
# → { "status": "ok", "engine": "browserbase" }
```

---

## Decision Matrix

Use the right browser tool for each job:

| Scenario | Tool | Why |
|---|---|---|
| Public docs, Wikipedia, news | Local Playwright | Free, fast, no quota consumed |
| Simple scraping (no auth, no bot protection) | Local Playwright | Free, sufficient |
| Dev preview / localhost testing | Local Playwright | Cloud can't reach localhost |
| Authenticated flows (login, session cookies) | Browserbase | Persistent context, auth preserved |
| Anti-bot / CAPTCHA sites | Browserbase | Stealth fingerprint, optional CAPTCHA solving |
| Form filling on production apps | Browserbase | Reliable interaction, React-compatible helpers |
| Long-running sessions (multi-step workflows) | Browserbase | Session survives network interruptions |

**Budget**: Default allowance is 100 browser-hours/month. Overage is billed at $0.12/hr. Check usage in the Browserbase dashboard.

**Local Playwright MCP tools** (use these for the free path):
- `mcp__playwright__browser_navigate`
- `mcp__playwright__browser_snapshot`
- `mcp__playwright__browser_click`
- `mcp__playwright__browser_type`
- `mcp__playwright__browser_screenshot`

---

## Reference Code

### Sidecar API Pattern

All Browserbase operations go through the local sidecar on port 3849. The sidecar holds the Browserbase session and exposes a simple REST API.

```bash
# Start a session (optionally reuse a named context for persistent cookies)
curl -s -X POST http://localhost:3849/session/start \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com", "contextName": "sitename" }'
# → { "sessionId": "...", "status": "ready" }

# Navigate to a new URL within the session
curl -s -X POST http://localhost:3849/session/navigate \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/dashboard" }'

# Click an element by CSS selector
curl -s -X POST http://localhost:3849/session/click \
  -H "Content-Type: application/json" \
  -d '{ "selector": "#submit-button" }'

# Type into an input field
curl -s -X POST http://localhost:3849/session/type \
  -H "Content-Type: application/json" \
  -d '{ "selector": "#username", "text": "myuser" }'

# Evaluate JavaScript (useful for React-controlled inputs)
curl -s -X POST http://localhost:3849/session/eval \
  -H "Content-Type: application/json" \
  -d '{
    "script": "const el = document.querySelector(\"#email\"); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, \"value\").set; setter.call(el, \"user@example.com\"); el.dispatchEvent(new Event(\"input\", { bubbles: true }));"
  }'

# Take a screenshot (returns PNG bytes)
curl -s http://localhost:3849/session/screenshot --output screenshot.png

# Stop the session (pass saveContext: true to persist cookies for next run)
curl -s -X POST http://localhost:3849/session/stop \
  -H "Content-Type: application/json" \
  -d '{ "saveContext": true }'
```

### Hand-off Protocol (Human-in-the-Loop)

When a site requires human interaction (MFA, CAPTCHA that cannot be solved automatically, manual verification), use the hand-off protocol to relay control to the user via Telegram.

```
1. POST /browser/handoff/start
   → daemon starts a Browserbase session and returns a session token

2. GET /session/status
   → extract wrapperPath (the shareable session URL)

3. Send the public URL + a screenshot to the user via your configured channel
   Example message: "Need your input — open this link to continue: https://..."

4. Wait for user commands via Telegram:
   - "screenshot"    → take and send a new screenshot
   - "type: [text]"  → relay text input (NEVER logged to transcript — safe for passwords)
   - "done"          → signal completion; sidecar saves context and closes session
   - "abort"         → cancel the session without saving

5. POST /session/stop { "saveContext": true }  (on "done")
   or
   POST /session/stop { "saveContext": false } (on "abort")
```

**Security note**: `type:` commands are relayed directly to the browser and are not captured in the conversation transcript. This makes the hand-off protocol safe for password entry and sensitive form fields.

### TypeScript Sidecar Client Example

```typescript
const SIDECAR = 'http://localhost:3849';

async function withBrowserbase(
  contextName: string,
  fn: (session: BrowserSession) => Promise<void>
): Promise<void> {
  await fetch(`${SIDECAR}/session/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'about:blank', contextName }),
  });

  try {
    await fn({ navigate, click, type: typeText, eval: evalScript, screenshot });
  } finally {
    await fetch(`${SIDECAR}/session/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveContext: true }),
    });
  }
}

async function navigate(url: string) {
  await fetch(`${SIDECAR}/session/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}
```

---

## Config Snippet

Add this block to your `kithkit.config.yaml`:

```yaml
integrations:
  browserbase:
    enabled: true
    sidecar_port: 3849
    # How long to wait for a page action before timing out (seconds)
    default_timeout: 300
    # Warn user via channel when a session has been idle this long (seconds)
    idle_warning: 240
    # Hand-off mode: max time waiting for user input (seconds)
    handoff_timeout: 300
    # Max total duration of a hand-off session (seconds)
    handoff_session_timeout: 1800
    # Block known ad/tracker domains (reduces noise in screenshots)
    block_ads: true
    # Use Browserbase's built-in CAPTCHA solver (increases session cost)
    solve_captchas: false
    # Record sessions in the Browserbase dashboard for debugging
    record_sessions: false
```

---

## Troubleshooting

**Session not starting**

- Confirm your API key is stored correctly: `security find-generic-password -s credential-browserbase-api-key -w`
- Check sidecar logs: `tail -f logs/browserbase-sidecar.log`
- Verify the daemon loaded the sidecar: `curl http://localhost:3849/health`

**Timeout errors during navigation or interaction**

- Increase `default_timeout` in config (some SPAs take 10–20 seconds to render)
- Check whether the site requires authentication — an unauth redirect may be looping
- Use `GET /session/screenshot` to inspect the current page state

**CAPTCHA failures**

- Enable `solve_captchas: true` in config (note: this increases Browserbase session cost)
- For sites where auto-solve fails, use the hand-off protocol to let the user solve manually

**Context not persisting between sessions**

- Ensure you pass `{ "saveContext": true }` in the stop request — the default is `false`
- `contextName` must match exactly between the start call that saved and the one that loads
- Named contexts are stored in Browserbase cloud — check the dashboard under **Contexts**

**Sidecar port conflict**

- If port 3849 is already in use: `lsof -i :3849`
- Change `sidecar_port` in config and restart the daemon

**Hand-off type commands not working**

- Confirm your Telegram channel is configured and the agent is listening
- `type:` commands must be sent as a plain message starting with `type: ` (space after colon)
- Ensure the hand-off session has not already expired (`handoff_timeout`)
