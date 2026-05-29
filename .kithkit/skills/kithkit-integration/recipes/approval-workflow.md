# Approval Workflow

The approval workflow is a reusable outbound-send gate for any kithkit agent capability that initiates communication with external parties — email, calendar invitations, Teams messages, and future channels. It lives as a standalone system wired into the channel-router as middleware; it is not embedded in any capability recipe.

> **Scope**: This recipe specifies four components (Gate, Card, Approval-API, Policy-store) and the wiring sequence. It is a **design specification**, not an implementation. A developer follows it to build the integration. See `graph-m365-delegated.md §4.2` for the first concrete capability that requires this workflow as a hard prerequisite.

## Prerequisites

- Kithkit daemon running: `curl -s http://localhost:3847/health`
- Channel-router outbound path accessible (daemon extension system, see kithkit-integration skill)
- Telegram integration configured and verified (default notification channel)

---

## Components

### Gate (Function)

The gate is a middleware function interposed between `adapter.send` and the transport layer in the channel-router outbound path. Every outbound capability send passes through it before anything leaves the agent.

**Pseudo-signature**:

```
await approvalGate({
  channel:      string,    // capability identifier: 'mail', 'calendar', 'teams_chat', etc.
  recipient:    string[],  // one or more canonical addresses or user IDs
  content:      string,    // assembled message body (used for hashing and preview)
  sender_agent: string,    // agent name: 'bridget', 'bmo', etc.
}): boolean
```

**Return semantics**:

| Return | Meaning |
|--------|---------|
| `true` | Proceed with send |
| `false` | Abort send (logged as rejected or timed out) |
| _(pending)_ | Gate is waiting — blocks the send call until the human responds or timeout fires |

**Fail-closed design principle**: This is a hard design invariant, not a configuration option.

- Policy ties (a recipient matches two rules with conflicting outcomes) → `require_approval` wins
- Timeout expiry → resolved as `false` (denied), not approved
- Unrecognized `require_approval_for` value → treated as `all`
- Channel-router unreachable while gate is pending → fail-closed (abort, do not pass through)
- **Daemon restart while gate is pending → INVARIANT: resolves DENIED.** A pending gate interrupted by daemon restart, agent process crash, or any infrastructure failure mid-gate MUST resolve as denied (never silently passed, never silently lost, never auto-resumed on the assumption the human already saw the card). On daemon startup, any rows in `approval_decisions` with `decided_at IS NULL` and `created_at` older than the per-policy timeout are marked `decision='timeout', decider='system'` and the corresponding sends are aborted. If a pending gate is younger than its timeout at restart, the daemon may either re-issue the card (preferred) or mark it timed-out (acceptable); it must never silently approve.

The gate must never silently pass a send through on error. When the infrastructure fails, the send fails.

<!-- TODO: Define full error taxonomy for the remaining cases — (a) approval card delivery fails (Telegram down) → fall back to next-configured channel, then fail-closed if all exhausted; (b) policy-flagged content classifier crashes → fail-closed. Document the exact recovery semantics per failure mode. -->

### Card (UI Primitive)

The approval card is a channel-agnostic abstraction rendered via the channel-router to the human's configured notification channel. Default: Telegram. Per-agent override via config (see §Policy-store, per-agent override section).

**Card data model**:

```
{
  approval_id:  string,    // UUID — used as callback key in Approval-API
  channel:      string,    // outbound capability: 'mail', 'teams_chat', 'calendar', etc.
  recipient:    string[],  // display recipients (may be canonicalized from raw input)
  preview:      string,    // first 200 chars of content body; redacted if policy-flagged
  sender_agent: string,    // human-readable agent name
  policy:       string,    // policy rule that triggered the gate: 'all', 'first_time_recipient', etc.
  expires_at:   ISO8601,   // gate timeout timestamp (default 10 min from creation)
  buttons:      ['Approve', 'Reject']
}
```

**Redaction**: If `content` matches a policy-flagged pattern (credential-shaped strings, PII markers, etc.), `preview` is replaced with `[content redacted by policy]`. The full `content` is still hashed for the audit log — redaction applies to the preview only.

<!-- TODO: Define policy-flagged pattern detection logic — regex-based (e.g., patterns matching API keys, SSNs), ML-based classifier, or manually configured pattern list in kithkit.config.yaml? Document the redaction trigger criteria and who maintains the pattern list. -->

**Per-channel renderers**: The card data model is channel-agnostic. Each delivery channel has its own renderer:

| Channel | Renderer | Approve/Reject mechanism |
|---------|----------|--------------------------|
| Telegram | Text message with inline keyboard | Inline button callback → `POST /api/approval/decision` |
| Email | HTML message with confirmation links | Signed one-time URL → `POST /api/approval/decision` |
| Future channels | TBD renderer | TBD callback path |

**Timeout behavior**: If neither button is tapped within `expires_at`, the gate automatically resolves `false` (denied). A timeout notification ("Approval timed out — send aborted") is delivered to the human's channel. The audit log records `decision=timeout, decider=system`.

### Approval-API (Daemon Endpoints)

These endpoints are specified as a recipe — they do not yet exist in the daemon. A developer implements them following this spec.

#### POST /api/approval/decision

Receives the human's approval or rejection decision. Called by:
- The Telegram inline-button callback handler (when the user taps Approve or Reject)
- The email link handler (when the user follows the confirmation URL)

**Request body**:

```json
{
  "approval_id": "550e8400-e29b-41d4-a716-446655440000",
  "decision":    "approved",
  "decider":     "human"
}
```

`decision` must be `"approved"` or `"rejected"`. `decider` is `"human"` for interactive decisions.

**Response**: `{ "status": "ok" }` on success, standard error object on failure.

**Behavior**:
1. Validate `approval_id` exists in the pending table and has not expired
2. Resolve the waiting gate promise with `true` (approved) or `false` (rejected)
3. Write audit log entry (see §Instrumentation)
4. Mark the pending entry as resolved

**Guard**: A decision on an already-resolved or expired `approval_id` returns `409 Conflict` — it does not silently succeed or re-trigger the gate.

#### GET /api/approval/pending

Lists in-flight approvals currently awaiting a human decision. Useful for out-of-band review when the human missed the Telegram card.

**Response**:

```json
{
  "pending": [
    {
      "approval_id":   "550e8400-...",
      "channel":       "mail",
      "recipient":     ["recipient@example.com"],
      "sender_agent":  "bridget",
      "preview":       "Hello, here is the monthly report...",
      "policy":        "all",
      "expires_at":    "2026-05-27T14:30:00Z",
      "created_at":    "2026-05-27T14:20:00Z"
    }
  ]
}
```

<!-- TODO: Add filter query params (by `agent`, by `channel`, by `status`) for fleet-wide audit visibility and scripted cleanup of stale pending items -->

### Policy-Store (Config)

**v1 — static YAML config** (what this recipe specifies): Stored in `kithkit.config.yaml` under `approval_policies:`. Git-tracked, human-reviewable, auditable via version control.

**v2 — dynamic DB-backed policy store** (future work): Modify policies at runtime without a redeploy or Git commit; per-agent policy UI; fleet-wide policy broadcast. Not implemented in v1. When v2 ships, a migration guide from static config will be provided.

#### Policy config schema

```yaml
approval_policies:
  # Per-capability policy blocks.
  # require_approval_for values:
  #   all                — always require approval (safe default)
  #   first_time_recipient — require only for recipients not yet in agent_sent_recipients
  #   external_only      — require only for recipients outside the tenant's primary domain
  #   never              — bypass gate entirely (escape hatch; use with explicit justification)

  mail_send:
    require_approval_for: all
    timeout_minutes: 10

  calendar_write:
    require_approval_for: all
    timeout_minutes: 10

  teams_chat_send:
    require_approval_for: all
    timeout_minutes: 10

  # Example: external recipients get more response time
  external_email_send:
    require_approval_for: external_only
    timeout_minutes: 30

  # Example: fully automated internal reporting — gate bypassed
  internal_nightly_report:
    require_approval_for: never   # operator has explicitly approved this flow
```

> **Fail-closed reminder**: If `require_approval_for` is absent or not one of the four recognized values, the gate treats it as `all`. There is no opt-out default. This is intentional.

> **Never-policy escape hatch**: `never` bypasses the approval gate entirely. Use only for flows where the operator has explicitly reviewed and approved the automation. All `never`-policy sends are still logged for audit — they appear with `decision=approved (auto), policy=never`.

#### Per-agent notification channel override

```yaml
agents:
  bridget:
    approval_notification_channel: telegram   # default
  bmo:
    approval_notification_channel: email      # fallback if Telegram not configured for this agent
```

---

## first_time_recipient State Primitive

The `first_time_recipient` policy value requires tracking which recipients each agent has previously sent to. This state lives in the daemon database.

### Schema

```sql
CREATE TABLE agent_sent_recipients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT NOT NULL,      -- agent name ('bridget', 'bmo')
  recipient     TEXT NOT NULL,      -- canonical email address (lowercase, alias-resolved)
  first_sent_at TEXT NOT NULL,      -- ISO8601 UTC timestamp of first successful send
  UNIQUE(agent, recipient)          -- dedup-on-add: duplicate inserts are silently ignored
);
```

### Dedup behavior

On each successful send (gate returned `true` via `approved` decision, or policy is `never`):

1. Canonicalize the recipient email: lowercase; resolve known aliases to primary address (see fuzzy-match note)
2. `INSERT OR IGNORE INTO agent_sent_recipients (agent, recipient, first_sent_at) VALUES (?, ?, ?)`
3. If `INSERT OR IGNORE` is a no-op: recipient already in the table — on the next send, `first_time_recipient` policy will not trigger approval for this recipient + agent pair

A rejected send does NOT add the recipient to the table. The gate fires again on the next attempt to the same address.

### Fuzzy-match note

A single person may have multiple email addresses: primary inbox, department alias, distribution list, old domain that forwards. The `first_time_recipient` check uses fuzzy matching to avoid approval fatigue when the same person sends from different aliases.

A recipient is considered "known" if:
- Exact match on canonicalized email, OR
- The address resolves to the same canonical primary address via the alias table

<!-- TODO: Define alias table schema and population strategy. Options: (a) manual config list in kithkit.config.yaml, (b) Graph API /me/contacts lookup (cross-reference display name + domain), (c) heuristic (same display name + same tenant domain = probably same person). Document the chosen algorithm and failure mode when resolution is ambiguous. -->

**Conservative fallback**: if an alias cannot be resolved to a known primary, the gate treats the recipient as new (requiring approval). When in doubt, the gate asks.

---

## Instrumentation

Every approval decision — approved, rejected, or timed out — is written to an audit log table.

### Audit log schema

```sql
CREATE TABLE approval_decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id        TEXT NOT NULL,    -- UUID from the card
  decision           TEXT NOT NULL,    -- 'approved' | 'rejected' | 'timeout'
  decider            TEXT NOT NULL,    -- 'human' | 'system' (for timeout)
  time_to_decide     REAL,             -- seconds from card creation to decision (null if timeout)
  content_hash       TEXT NOT NULL,    -- SHA-256 of original content (not the preview)
  recipient_set_hash TEXT NOT NULL,    -- SHA-256 of JSON-sorted canonical recipient list
  sender_agent       TEXT NOT NULL,    -- agent name
  channel            TEXT NOT NULL,    -- capability: 'mail', 'teams_chat', 'calendar', etc.
  policy             TEXT NOT NULL,    -- policy rule that triggered: 'all', 'first_time_recipient', etc.
  created_at         TEXT NOT NULL,    -- ISO8601 UTC: when the card was created
  decided_at         TEXT              -- ISO8601 UTC: when the decision was recorded (null until resolved)
);
```

### Hash construction

**`content_hash`**: `SHA-256(original content string as UTF-8)` — computed on the raw content before any redaction or truncation. Allows post-hoc verification that a specific message body was approved without storing the message body itself.

**`recipient_set_hash`**: `SHA-256(JSON.stringify(recipients.map(canonical).sort()))` — sorted canonical email list serialized to JSON, then hashed. Order-independent: `[a@x.com, b@x.com]` and `[b@x.com, a@x.com]` produce the same hash.

### Compliance note

This audit trail is designed to satisfy the audit-trail requirement under **2 CFR 200** (federal grants administration — Hurleys operations scenario). The `content_hash + recipient_set_hash + sender_agent` triplet allows a compliance reviewer to confirm that a specific outbound communication was human-approved, without the audit log retaining the full message content.

Policy-tuning use: `time_to_decide` values and per-channel approval rates over time help identify alert fatigue (every routine send requiring approval → operators start rubber-stamping) and policy gaps (too many `never` entries accumulating → review needed).

---

## Wiring Sequence (Recipe)

Follow these five steps in order. The gate cannot be meaningfully tested without the policy store configured first.

### Step 1 — Define policies in kithkit.config.yaml

Start with `all` for all capabilities you plan to use. Add the `approval_policies:` block:

```yaml
approval_policies:
  mail_send:
    require_approval_for: all
    timeout_minutes: 10
  calendar_write:
    require_approval_for: all
    timeout_minutes: 10
  teams_chat_send:
    require_approval_for: all
    timeout_minutes: 10
```

Reload config without restarting the daemon:

```bash
curl -s -X POST 'http://localhost:3847/api/config/reload' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)"
```

Confirm: `{ "status": "ok" }` (or equivalent success response).

### Step 2 — Wire gate into channel-router outbound paths

Insert `approvalGate` as middleware in the channel-router outbound call chain. Placement:

```
[content assembly] → [approvalGate] → [transport.send]
                          ↑
                  must be here — AFTER content is assembled
                  (gate needs content for hashing and preview)
                  and BEFORE the transport call
                  (gate must block the actual send)
```

The gate receives `{channel, recipient, content, sender_agent}` from the router context, calls `POST /api/approval/decision` (when the human responds), and returns `true` or `false` to the router. The router MUST NOT call the transport if the gate returns `false`.

<!-- TODO: Document the exact channel-router middleware registration pattern once the extension API is finalized. Reference the extension system docs in the kithkit-integration skill folder. Include the hook name, registration call, and how to pass router context into the gate function. -->

### Step 3 — Reject test

Send outbound to a synthetic (non-deliverable) address. Verify the card appears and the Reject path works.

```bash
# This uses the daemon's outbound API — replace with the correct route for your capability once implemented
curl -s -X POST 'http://localhost:3847/api/m365/send-mail' \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)" \
  -d '{
    "to":      "synthetic-reject-test@invalid.example",
    "subject": "approval gate reject test",
    "body":    "this should never be delivered"
  }'
```

Expected sequence:
1. Approval card appears on Telegram within ~5s
2. Card shows `synthetic-reject-test@invalid.example` as recipient, `mail` as channel
3. Tap **Reject**
4. Send aborted — Graph is never called; no message sent
5. Audit log entry: `decision=rejected, decider=human, sender_agent=<your-agent>`

<!-- TODO: Replace the placeholder curl above with the correct daemon endpoint path once the M365 mail.send daemon API route (`/api/m365/send-mail` or equivalent) is implemented. Until then, trigger a send via the capability's native integration path. -->

### Step 4 — Never-policy direct-send test

Temporarily add a `never` policy for one capability to verify the escape hatch:

```yaml
approval_policies:
  mail_send:
    require_approval_for: never   # TEMPORARY — revert after test
    timeout_minutes: 10
```

Reload config and trigger a send. Expected: no approval card; send proceeds directly; audit log entry appears with `decision=approved (auto), policy=never`.

After test, revert to `require_approval_for: all` and reload:

```bash
curl -s -X POST 'http://localhost:3847/api/config/reload' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)"
```

### Step 5 — Verify audit log entries

Query completed decisions and confirm all required fields are present:

<!-- TODO: Add a GET /api/approval/decisions (or /api/approval/history) endpoint for querying completed decisions. The current /api/approval/pending only surfaces in-flight items. Document filter params (by agent, channel, date range, decision type) and add that curl command here once the endpoint is implemented. -->

```bash
# Pending only — use until /api/approval/decisions is implemented
curl -s 'http://localhost:3847/api/approval/pending' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)" | python3 -m json.tool
```

For each test run (Step 3 reject, Step 4 never-policy send), confirm the audit log contains:

```
[ ] `decision` — 'approved', 'rejected', or 'timeout'
[ ] `decider` — 'human' or 'system'
[ ] `time_to_decide` — elapsed seconds (null for timeout)
[ ] `content_hash` — non-empty SHA-256 hex string
[ ] `recipient_set_hash` — non-empty SHA-256 hex string
[ ] `sender_agent` — matches the agent that triggered the send
[ ] `channel` — matches the capability ('mail', 'teams_chat', etc.)
[ ] `policy` — matches the policy rule that triggered ('all', 'never', etc.)
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Approval card never appears | Gate not wired into channel-router (Step 2 incomplete) | Confirm middleware registration; check daemon logs for gate invocation |
| Card appears but Approve/Reject does nothing | Telegram callback handler not registered, or `POST /api/approval/decision` route missing | Confirm Telegram webhook is live; confirm daemon route exists |
| Gate resolves `false` immediately | `expires_at` already past at time of review | Increase `timeout_minutes`; confirm clock sync between daemon host and Telegram |
| `never` policy still showing card | Config not reloaded after change | Run `POST /api/config/reload` and confirm `{ "status": "ok" }` |
| Audit log missing entries | `approval_decisions` table not created (migration not run) | Check daemon migration status; run pending migrations |
| `first_time_recipient` always requiring approval | Alias not in alias table; canonical resolution failing | Temporarily switch to `all` while debugging alias resolution |
| `409 Conflict` from `POST /api/approval/decision` | Decision attempted on already-resolved or expired approval_id | Check whether the timeout fired; re-trigger the send if needed |
