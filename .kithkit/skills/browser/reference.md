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
Human's phone/laptop (channel link)
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

Context names map to Browserbase context IDs in `.kithkit/state/browser-contexts.json`.

## Session & Hand-Off Timeouts

| Timer | Default | Configurable | What happens |
|-------|---------|-------------|--------------|
| Automation session timeout | 300s (5 min) | `SESSION_TIMEOUT` env var on sidecar | Warning at T-60s, then session auto-closes |
| Hand-off idle warning | 10 min | No | Human gets "still there?" message |
| Hand-off idle timeout | 30 min | No | Session closes, hand-off deactivated |

**Automation timeout**: When the assistant is driving the browser (no hand-off active), sessions auto-close after 300 seconds of the session being open (not idle time — total elapsed time). For long workflows, either:
- Work quickly and close the session when done
- Set `SESSION_TIMEOUT` to a higher value on the sidecar if needed

**During hand-off**: The automation timeout is paused. The hand-off idle timers take over instead. Idle timers reset on every `type:`, `click`, `scroll`, or `screenshot` interaction.

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
| `POST /session/eval` | Run `page.evaluate()` in active session (see below) |
| `GET /contexts` | List contexts |
| `DELETE /contexts/:name` | Delete context |
| `POST /cleanup` | Orphan recovery |
| `POST /handoff/set` | Update hand-off flag |

### `/session/eval` — JavaScript Evaluation

Runs `page.evaluate()` on the active Browserbase session. This is the most powerful tool for form filling, field discovery, and DOM inspection.

**Request:**
```
POST http://localhost:3849/session/eval
Content-Type: application/json

{ "script": "document.title" }
```

**Response:**
```json
{ "result": "Page Title Here" }
```

The `script` value is passed directly to Playwright's `page.evaluate()`. It can be any valid JavaScript expression or IIFE. The return value is serialized as JSON in the `result` field.

**Calling from the assistant (curl):**
```bash
curl -s -X POST http://localhost:3849/session/eval \
  -H 'Content-Type: application/json' \
  -d '{"script": "document.title"}'
```

**Calling from Python (recommended for complex scripts):**

For scripts with quotes, newlines, or complex logic, use Python to avoid JSON/shell escaping issues:

```python
import json, subprocess

script = """
Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
  tag: el.tagName, type: el.type, name: el.name, id: el.id,
  label: el.labels?.[0]?.textContent?.trim() || null,
  value: el.value
})).filter(f => f.type !== 'hidden' && f.name !== '')
"""

payload = json.dumps({"script": script})
r = subprocess.run(
    ["curl", "-s", "-X", "POST", "http://localhost:3849/session/eval",
     "-H", "Content-Type: application/json", "-d", payload],
    capture_output=True, text=True
)
result = json.loads(r.stdout)
print(json.dumps(result, indent=2))
```

**Key constraints:**
- Requires an active session (call `/session/start` first)
- The script runs in the browser context, not Node.js — no access to `require`, `fs`, etc.
- Return values must be JSON-serializable (no DOM elements, functions, or circular refs)
- For long-running scripts, keep them under the session timeout (default 300s)

## Form Filling Best Practices

### The `/session/eval` Advantage

The `/session/eval` endpoint makes Browserbase dramatically more efficient for form filling. Instead of calling `/session/type` once per field (each call takes a screenshot roundtrip), use `/session/eval` to fill all fields in a single call.

**Comparison:**
- `/session/type` x 10 fields = 10 HTTP calls + 10 screenshots = slow, chatty
- `/session/eval` x 1 batch fill = 1 HTTP call, then 1 screenshot to verify = fast, efficient

### Step 1: Discover Form Fields

Always discover fields before filling. This avoids guessing at IDs and catches hidden/disabled fields.

```javascript
// Field discovery script — run via /session/eval
Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
  tag: el.tagName,
  type: el.type,
  name: el.name,
  id: el.id,
  label: el.labels?.[0]?.textContent?.trim() || null,
  placeholder: el.getAttribute('placeholder'),
  value: el.value,
  required: el.required,
  disabled: el.disabled,
  visible: el.offsetParent !== null,
  ariaLabel: el.getAttribute('aria-label'),
  options: el.tagName === 'SELECT'
    ? Array.from(el.options).map(o => ({ val: o.value, text: o.text }))
    : undefined
})).filter(f => f.type !== 'hidden' && !f.name.startsWith('goog') && f.name !== '')
```

### Step 2: Batch Fill All Fields

Use the React-compatible native setter pattern. This works on React, Vue, Angular, and vanilla sites.

```javascript
// Batch fill script — run via /session/eval
(() => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  const textareaSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;

  const fields = {
    'firstName': 'John',
    'lastName': 'Smith',
    'email': 'john@example.com',
    'address': '123 Main St',
    'city': 'Baltimore',
    'zip': '21201'
  };

  const results = [];
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (!el) { results.push({ id, status: 'not found' }); continue; }

    if (el.tagName === 'TEXTAREA') {
      textareaSetter.call(el, val);
    } else {
      setter.call(el, val);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    results.push({ id, status: 'filled' });
  }
  return results;
})()
```

**Why the native setter pattern?** React (and similar frameworks) replaces the native `value` setter with a synthetic one that tracks state. Setting `el.value = 'x'` directly bypasses React's change detection, so the framework never updates its internal state. Using `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` calls the real DOM setter, and dispatching `input` + `change` events triggers the framework's event handlers to sync state.

### Handling Dropdowns (`<select>`)

For native `<select>` elements, set `.value` and dispatch `change`:

```javascript
// Dropdown fill — run via /session/eval
(() => {
  const selects = {
    'state': 'MD',
    'filingStatus': '2'  // Married Filing Jointly
  };

  for (const [id, val] of Object.entries(selects)) {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
})()
```

### Handling Checkboxes and Radio Buttons

Set `.checked` and dispatch `click` + `change`:

```javascript
// Checkbox/radio fill — run via /session/eval
(() => {
  // Checkboxes — set by ID
  const checks = { 'agreeTerms': true, 'newsletter': false };
  for (const [id, checked] of Object.entries(checks)) {
    const el = document.getElementById(id);
    if (el && el.checked !== checked) {
      el.checked = checked;
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Radio buttons — set by name + value
  const radios = { 'shippingMethod': 'express' };
  for (const [name, val] of Object.entries(radios)) {
    const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (el) {
      el.checked = true;
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
})()
```

### When NOT to Use Batch Fill

Use `/session/type` (one field at a time) instead of eval batch fill when:
- **Masked/formatted fields** (SSN, phone, credit card) — these need keystroke events to trigger formatting logic
- **Custom component dropdowns** (React Select, Material UI Autocomplete) — need click-based interaction
- **Fields with debounced async validation** — need time between entries for server calls
- **CAPTCHA-adjacent fields** — some anti-bot systems monitor how values are entered

### Reliable Interaction Patterns

**Locator strategy priority** (when using `/session/click` or `/session/type` with selectors):
1. `[aria-label="..."]` or `#id` — most stable
2. `[name="..."]` — reliable for form fields
3. `button:has-text("Submit")` — for buttons by visible text
4. CSS class selectors — fragile, avoid unless necessary

**Verify after fill**: Always take a screenshot (`GET /session/screenshot`) after batch filling to visually confirm all fields populated correctly. Cheaper than debugging a failed submission.

**Wait for page readiness**: After navigation or postback, wait before interacting:
```bash
# Navigate, then wait a beat, then screenshot to confirm page loaded
curl -s -X POST http://localhost:3849/session/navigate -H 'Content-Type: application/json' -d '{"url": "https://example.com/form"}'
sleep 2
curl -s http://localhost:3849/session/screenshot > /tmp/page-loaded.png
```

### Government & Enterprise Site Tips

**ASP.NET Web Forms** (common on .gov sites):
- Pages include `__VIEWSTATE`, `__EVENTVALIDATION` hidden fields — do NOT modify these
- Dropdown changes often trigger full-page postbacks — wait for page reload before continuing
- Use eval to detect ASP.NET: `typeof __doPostBack !== 'undefined'`

**Session timeouts**: Government sites often have 5-15 minute idle timeouts. Keep sessions active by interacting regularly. If the session expires, you may need to start over.

**CAPTCHA patterns**: Many .gov sites present CAPTCHAs on submission. Use eval to detect them:
```javascript
!!(document.querySelector('.g-recaptcha') ||
   document.querySelector('[class*="captcha"]') ||
   document.querySelector('iframe[src*="captcha"]'))
```
If detected, hand off to human via the hand-off protocol.

**PDF downloads**: Government forms often link to PDFs. Use eval to find download links:
```javascript
Array.from(document.querySelectorAll('a[href$=".pdf"]')).map(a => ({
  text: a.textContent.trim(), href: a.href
}))
```

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
| `.kithkit/state/browser-contexts.json` | Context manifest data |
| `.kithkit/state/browser-session.json` | Crash recovery state (transient) |

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
