---
name: browser
description: Browser automation SOP — choose local Playwright (free) vs Browserbase cloud (metered), with session patterns and hand-off protocol. Use when a task requires web browsing.
user-invocable: false
---

# Browser Automation

Operational guide for web browsing tasks. Two browser options are available — choose the right one for the job.

**See also**: [reference.md](reference.md) for detailed API reference, troubleshooting, credentials, and plan limits.

## Decision Matrix

### Option A: Local Playwright (MCP tools) — FREE, unlimited

The Playwright MCP server provides `mcp__playwright__browser_*` tools directly in the session.

**Use when:**
- Reading public web content (docs, articles, search results, prices)
- Simple scraping of public data
- Form fills on sites without bot protection
- Development/testing (previewing pages, checking our apps)
- Quick lookups (weather, reference, public info)
- Any site that doesn't actively block automation

**Limitations:**
- Detectable as headless browser (no stealth mode)
- No CAPTCHA auto-solving
- No human hand-off capability
- No persistent cookies across sessions
- Blocked by Cloudflare, aggressive anti-bot, headless detection

**Pattern:**
```
1. mcp__playwright__browser_navigate → go to URL
2. mcp__playwright__browser_snapshot → get page accessibility tree (preferred over screenshot for actions)
3. mcp__playwright__browser_click/type/etc → interact
4. mcp__playwright__browser_take_screenshot → visual capture when needed
5. mcp__playwright__browser_close → clean up when done
```

### Option B: Browserbase Cloud (sidecar on port 3849) — METERED

Remote Chrome with stealth mode, CAPTCHA solving, human hand-off, and **`/session/eval`** for efficient form filling via `page.evaluate()`.

**Use when:**
- Site requires authentication (human enters credentials via hand-off)
- Anti-bot protection present (Cloudflare, reCAPTCHA, headless detection)
- Banking & financial sites (need stealth + security)
- Utility account management (bill pay, account changes)
- CAPTCHA-gated workflows
- Need persistent cookies across sessions (context persistence)
- **Form filling tasks** — `/session/eval` enables batch-filling all fields in one call

**Pattern:**
```
1. POST http://localhost:3849/session/start { "url": "...", "contextName": "sitename" }
2. POST /session/eval — discover fields, batch-fill forms (see Form Filling Protocol)
3. POST /session/navigate, /session/click, /session/type — interact as needed
4. GET /session/screenshot — visual check
5. If blocked → hand off to human (see Hand-Off below)
6. POST /session/stop { "saveContext": true } — clean up, save cookies
```

### Decision Flowchart

```
Is there an API, CLI tool, or curl option?
  YES → Use that (no browser needed)
  NO ↓

Is the content public with no bot protection?
  YES → Local Playwright (free)
  NO ↓

Anti-bot protection, CAPTCHA, or headless detection?
  YES → Browserbase
  NO ↓

Need human to enter credentials or approve something?
  YES → Browserbase (hand-off)
  NO ↓

Need to fill forms on a site with bot protection?
  YES → Browserbase (/session/eval for efficient batch fill)
  NO ↓

Need persistent cookies across sessions?
  YES → Browserbase (context persistence)
  NO → Local Playwright (free)
```

## Hand-Off Protocol (Browserbase only)

When the assistant hits a blocker (CAPTCHA, login, MFA, payment approval):

1. **Take screenshot**, assess the blocker
2. **Start hand-off**: `POST http://localhost:3847/browser/handoff/start`
3. **Get session info**: `GET http://localhost:3849/session/status` → extract `wrapperPath`
4. **Build the public hand-off URL**: `https://yourdomain.com{wrapperPath}`
   - **IMPORTANT**: Always use your configured public domain URL, NEVER `localhost` — the human is on their phone/laptop, not on this machine
   - The daemon proxies `/handoff/*` to the sidecar automatically
5. **Message human** on the active channel with:
   - Hand-off URL (tappable link to the interactive web UI)
   - Screenshot of current page
   - Clear description: "I'm stuck on [X] — need you to [Y]"
   - **Always include the available commands** (see below)
6. **Human interacts** via the web UI or channel commands:
   - `type: [text]` — types into focused field (NEVER logged — safe for passwords)
   - `screenshot` — sends fresh screenshot
   - `done` / `all yours` — completes hand-off (shows confirmation overlay in web UI)
   - `abort` — cancels and closes session
7. **Done confirmation**: When the human taps Done in the web UI, a confirmation overlay appears asking them to confirm. This prevents accidental hand-back while still interacting.
8. **Assistant resumes** autonomous navigation after `done` is confirmed

### Hand-Off Message Template

Always include this in the initial hand-off message to the human:

```
I need your help with [description of blocker].

Hand-off page: https://yourdomain.com/handoff/page?token=TOKEN_HERE

[Description of what's on screen and what you need them to do]

Available commands:
• type: [text] — type into the focused field
• screenshot — get a fresh screenshot
• done — hand control back to me
• abort — cancel and close the session
```

### Hand-Off Triggers
- CAPTCHA that auto-solve can't handle
- Login requiring credentials the assistant doesn't have
- Multi-factor authentication (phone/email codes, authenticator)
- "Are you human?" challenges
- Payment confirmation (human must explicitly approve)
- Anything the assistant can't figure out from screenshots

## Form Filling Protocol (Browserbase)

When filling forms via Browserbase, follow this efficient workflow:

### 1. Navigate to the Form Page

```bash
curl -s -X POST http://localhost:3849/session/start \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com/application", "contextName": "sitename"}'
```

### 2. Discover All Form Fields

Use `/session/eval` to enumerate every field on the page:

```bash
curl -s -X POST http://localhost:3849/session/eval \
  -H 'Content-Type: application/json' \
  -d '{"script": "Array.from(document.querySelectorAll(\"input, select, textarea\")).map(el => ({tag: el.tagName, type: el.type, name: el.name, id: el.id, label: el.labels?.[0]?.textContent?.trim() || null, options: el.tagName===\"SELECT\" ? Array.from(el.options).map(o=>({val:o.value,text:o.text})) : undefined})).filter(f => f.type !== \"hidden\" && f.name !== \"\")"}'
```

For complex discovery scripts, use Python to avoid escaping issues (see reference.md for the Python eval helper pattern).

### 3. Batch-Fill All Fields in One Call

Use `/session/eval` with the React-compatible native setter pattern:

```bash
# Use Python for the actual call — much cleaner than curl with escaped JSON
python3 -c "
import json, subprocess
script = '''(() => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const fields = {'firstName': 'John', 'lastName': 'Smith', 'email': 'john@example.com'};
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) { setter.call(el, val); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
  }
  return 'filled';
})()'''
r = subprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3849/session/eval',
  '-H', 'Content-Type: application/json', '-d', json.dumps({'script': script})],
  capture_output=True, text=True)
print(r.stdout)
"
```

### 4. Screenshot to Verify

```bash
curl -s http://localhost:3849/session/screenshot > /tmp/form-filled.png
```

Review the screenshot to confirm all fields are populated correctly.

### 5. Submit or Hand Off

- If the form is ready: use `/session/click` to submit
- If there is a CAPTCHA or login blocker: hand off to human (see Hand-Off Protocol)
- If the human needs to review before submitting: hand off with instructions to review and click Submit

### Tips

- **Use Python for eval scripts**: Shell escaping of JSON containing JavaScript is error-prone. Python's `json.dumps()` handles it cleanly.
- **Session timeout is 300s by default**: For multi-page forms, work quickly. You can set `SESSION_TIMEOUT` env var on the sidecar for longer workflows.
- **Discover before filling**: Never guess field IDs. Always run the discovery script first. Field IDs vary wildly across sites.
- **Dropdowns need separate handling**: Native `<select>` uses `.value` + `change` event. Custom dropdowns (React Select, etc.) need click-based interaction via `/session/click`.
- **Masked fields need `/session/type`**: For SSN, phone, credit card fields with input masks, use `/session/type` with the field selector instead of eval. Masks rely on keystroke events.
- **Government sites**: Watch for ASP.NET postbacks (dropdown changes reload the page), aggressive session timeouts, and CAPTCHA on submission. See reference.md for detailed tips.

## Security Rules

1. **`type:` relay text is NEVER logged** — passwords, SSNs, account numbers are safe
2. **Live view URLs only sent via private channel DM** — never in group chats or logs
3. **Financial transactions require explicit human approval**
4. **Session recording is OFF** — no video of banking/password screens on Browserbase servers
5. **Proxy providers block banking domains** — hand-off to human is the approach for those

## Site Knowledge (Memory-Based)

Per-site learnings (field selectors, navigation flows, quirks, anti-bot patterns) are stored as **memories** in `.claude/state/memory/memories/`, NOT in this skill. This keeps the skill shareable without leaking site-specific knowledge.

### Before Browsing: Look Up What You Know

Before interacting with any site, check memory for prior learnings:

```bash
# Search by domain
Grep "egov.maryland.gov" path=".claude/state/memory/memories/"

# Search by category
Grep "category: website" path=".claude/state/memory/memories/"

# Search by tag
Grep "tags:.*md-business-express" path=".claude/state/memory/memories/"
```

If you find a matching memory, read it. It may contain field IDs, navigation steps, known quirks, or auth requirements that save you from re-discovering everything.

### After Browsing: Capture What You Learned

When you discover something useful about a site, store it immediately using `/memory add`:

**Memory format for website learnings:**
```yaml
---
date: 2026-02-11T21:00:00
category: website
importance: medium
subject: egov.maryland.gov — LLC Filing Form
tags: [maryland, business-express, llc, government, form-filling]
confidence: 0.9
source: observation
---

# egov.maryland.gov — LLC Filing Form

## Access
- URL: https://egov.maryland.gov/BusinessExpress
- Auth: account required (credential-md-business-express-username)
- Anti-bot: minimal (no Cloudflare, no CAPTCHA on forms)
- Browser: Browserbase recommended (account login required)

## Navigation
- Register LLC: Dashboard → Register → Maryland Limited Liability Company → "Use Online Forms"
- 6-step wizard: Business Name → Business Info → Resident Agent → Additional → Confirm → Pay

## Form Fields (Step 1 — Business Name)
- `#BusinessSuffix`: select, options: ", LLC" / ", L.L.C." / ", Limited Liability Company"
- `#BusinessName`: input, the LLC name without suffix
- Availability check button: `#btnCheckAvailability`

## Quirks
- Dropdown changes trigger ASP.NET postbacks (full page reload)
- County dropdown populates after state selection — wait for reload
- Session timeout: aggressive, ~15 min idle
```

### What to Capture

| Category | Examples |
|----------|----------|
| **Access** | URL, auth method, anti-bot level, which browser option to use |
| **Navigation** | How to reach key pages, menu paths, wizard steps |
| **Form fields** | IDs, names, types, labels, dropdown options, masked fields |
| **Quirks** | Postbacks, session timeouts, dynamic field loading, JS framework |
| **Anti-bot** | Cloudflare, reCAPTCHA, headless detection, rate limits |
| **Auth flow** | Login URL, MFA type, credential keychain keys |
| **Failures** | What didn't work and why (stale selectors, blocked approaches) |

### Staleness & Verification

Site knowledge can go stale (redesigns, updated field IDs). Handle this with verify-on-use:

1. **Try the stored knowledge** — use remembered selectors/flows
2. **If it fails** — re-discover (run field enumeration, take screenshots)
3. **Update the memory** — correct the stale data immediately
4. **Note the last verified date** in the memory content

Don't preemptively invalidate — trust stored knowledge until it actually fails.

### Naming Convention

Website memory files follow the standard memory naming:
```
YYYYMMDD-HHMM-site-slug.md
```

Examples:
- `20260211-2100-egov-maryland-llc-filing.md`
- `20260212-1400-chase-bank-login.md`
- `20260213-0900-irs-ein-application.md`

### Sharing

This skill (SKILL.md, reference.md) can be shared upstream or with peers. Per-site memories stay in each agent's private `.claude/state/memory/memories/` directory. An agent receiving this skill will build their own site knowledge through use.

## Cost Awareness

- **Budget**: 100 hours/month ($0.12/hr overage)
- **Typical task**: 2-5 minutes (login, navigate, grab data)
- **At 5 min/task**: budget supports ~1,200 tasks/month
- **Proxy bandwidth**: 1 GB/month — avoid large file downloads through Browserbase
- **When in doubt**: prefer local Playwright for anything that doesn't need stealth/auth

## References

- [reference.md](reference.md) — Detailed API reference, session lifecycle, troubleshooting, credentials, plan limits
