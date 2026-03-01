---
name: browser
description: Browser automation SOP — choose local Playwright (free) vs Browserbase cloud (metered), with session patterns and hand-off protocol. Use when a task requires web browsing.
user-invocable: false
---

# Browser Automation

Operational guide for web browsing tasks. Two browser options are available — choose the right one for the job.

**See also**: [reference.md](reference.md) for detailed API reference, troubleshooting, credentials, and plan limits.

## Site Knowledge

Before browsing a new site, check if we have prior learnings:

```bash
# Search for site-specific memories
grep -l "category: website" .claude/state/memory/memories/*.md | xargs grep -l "example.com"
```

**Before navigating**: Grep memories for the domain. Prior knowledge includes:
- Field selectors (login forms, search boxes, data tables)
- Navigation flows (how to reach specific pages)
- Anti-bot patterns (Cloudflare, rate limits, headless detection)
- Auth requirements (OAuth, cookies, session handling)
- Known quirks (JS-heavy rendering, iframe issues, dynamic IDs)

**After successful interaction**: Capture learnings as a memory:
```
/memory add "Site example.com: login form is #auth-form, submit button .btn-primary,
rate limited to 10 req/min, requires JS for form validation" category:website tags:selectors,auth
```

Site knowledge is stored as memories (not in this skill) so the skill stays portable while learnings accumulate per-agent.

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

Remote Chrome with stealth mode, CAPTCHA solving, and human hand-off. Costs hours from 100 hrs/month budget.

**Use when:**
- Site requires authentication (human enters credentials via hand-off)
- Anti-bot protection present (Cloudflare, reCAPTCHA, headless detection)
- Banking & financial sites (need stealth + security)
- Utility account management (bill pay, account changes)
- CAPTCHA-gated workflows
- Need persistent cookies across sessions (context persistence)

**Pattern:**
```
1. POST http://localhost:3849/session/start { "url": "...", "contextName": "sitename" }
2. POST /session/navigate, /session/click, /session/type — interact
3. GET /session/screenshot — visual check
4. If blocked → hand off to human (see Hand-Off below)
5. POST /session/stop { "saveContext": true } — clean up, save cookies
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

Need persistent cookies across sessions?
  YES → Browserbase (context persistence)
  NO → Local Playwright (free)
```

## Hand-Off Protocol (Browserbase only)

When the assistant hits a blocker (CAPTCHA, login, MFA, payment approval):

1. **Take screenshot**, assess the blocker
2. **Start hand-off**: `POST http://localhost:3847/browser/handoff/start`
3. **Message human** on Telegram with:
   - Live view URL (tappable link)
   - Screenshot of current page
   - Clear description: "I'm stuck on [X] — need you to [Y]"
4. **Human interacts** via Telegram commands:
   - `type: [text]` — types into focused field (NEVER logged — safe for passwords)
   - `screenshot` — sends fresh screenshot
   - `done` / `all yours` — completes hand-off
   - `abort` — cancels and closes session
5. **Assistant resumes** autonomous navigation after `done`

### Hand-Off Triggers
- CAPTCHA that auto-solve can't handle
- Login requiring credentials the assistant doesn't have
- Multi-factor authentication (phone/email codes, authenticator)
- "Are you human?" challenges
- Payment confirmation (human must explicitly approve)
- Anything the assistant can't figure out from screenshots

## Security Rules

1. **`type:` relay text is NEVER logged** — passwords, SSNs, account numbers are safe
2. **Live view URLs only sent via private Telegram DM** — never in group chats or logs
3. **Financial transactions require explicit human approval**
4. **Session recording is OFF** — no video of banking/password screens on Browserbase servers
5. **Proxy providers block banking domains** — hand-off to human is the approach for those

## Cost Awareness

- **Budget**: 100 hours/month ($0.12/hr overage)
- **Typical task**: 2-5 minutes (login, navigate, grab data)
- **At 5 min/task**: budget supports ~1,200 tasks/month
- **Proxy bandwidth**: 1 GB/month — avoid large file downloads through Browserbase
- **When in doubt**: prefer local Playwright for anything that doesn't need stealth/auth

## References

- [reference.md](reference.md) — Detailed API reference, session lifecycle, troubleshooting, credentials, plan limits
