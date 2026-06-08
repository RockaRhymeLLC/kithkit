# Microsoft Graph M365/Teams — Delegated Access

Follow this recipe to wire up delegated (user-impersonating) access to Microsoft 365 for a kithkit agent. This covers mail read/send, calendar, contacts, and Teams chat — all authenticated as the signed-in user via the device-code OAuth flow.

> **Auth mode contrast with graph-email.md**: `graph-email.md` uses client-credentials (server-to-server; app acts as itself; no interactive sign-in; Application permissions). This recipe uses **delegated** access (device-code; the agent acts *as the user*; personal-data access; Delegated permissions). The app registration, permission model, and token lifecycle are all different. Create a new app registration — do not reuse the client-credentials app.

See the [Microsoft Graph API overview](https://learn.microsoft.com/en-us/graph/api/overview) for the full API surface.

## Prerequisites

- Microsoft 365 account (the user the agent will act on behalf of)
- Azure portal access (`portal.azure.com`) with permission to register applications
- Admin consent access, or a Global Admin / Application Admin who can grant it on your behalf
- Kithkit daemon running: `curl -s http://localhost:3847/health`
- `approval-workflow.md` fully implemented before testing §4.2 mail.send (see §4.2 HARD PREREQUISITE)

---

## 1. App Registration

### 1.1 Create the application

1. Go to **Azure Active Directory > App registrations > New registration**
2. Name: `kithkit-m365-delegated` (or your fleet naming convention)
3. Supported account type: **Accounts in this organizational directory only (Single tenant)**
4. Redirect URI: leave blank — configured in the next step
5. Click **Register** and note the **Application (client) ID** and **Directory (tenant) ID**

### 1.2 Add the device-code platform

1. In the app registration, go to **Authentication > Add a platform**
2. Choose **Mobile and desktop applications**
3. Under **Custom redirect URIs**, enter: `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Click **Configure**

### 1.3 Enable public client flows

> **Silent-failure gotcha**: If you skip this step, the device-code POST silently returns `AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'`. Nothing in that error message points to this toggle — it is the only fix.

Toggle path: **Authentication > Advanced settings > Allow public client flows → Yes**

Save the page. Confirm the toggle shows **Yes** in the portal before continuing. This setting is what distinguishes a public client (device-code, CLI) from a confidential client (client-credentials, server app).

> **Delta from graph-email.md**: `graph-email.md` uses a confidential client (client secret). This recipe uses a public client (no secret, public client flows enabled). Never create a client secret for this registration.

### 1.4 Add API permissions (Delegated)

In **API permissions > Add a permission > Microsoft Graph > Delegated permissions**, add the following. Add all now; you can narrow scope later.

| Capability | Permission | Purpose |
|------------|------------|---------|
| All | `offline_access` | Refresh tokens — **required** for persistent access across restarts |
| mail.read | `Mail.Read` | Read messages in the mailbox |
| mail.send | `Mail.Send` | Send messages as the signed-in user |
| calendar.read | `Calendars.Read` | Read calendar events |
| calendar.write | `Calendars.ReadWrite` | Create, update, and delete events |
| contacts | `Contacts.Read` | Read personal contacts folder |
| teams.chat | `Chat.ReadWrite` | Read and send 1:1 and group chat messages |
| teams.chat | `ChannelMessage.Send` | Post in Teams channels the user has access to |
| teams.chat | `Chat.Create` | Start new 1:1 chats |

> **Admin consent checkpoint**: After adding permissions, inspect the **Status** column. A yellow warning icon means your tenant requires admin consent. Click **Grant admin consent for [Tenant]** if you have the Global Admin or Application Admin role. If not, send the portal URL to your tenant admin and ask them to grant consent before you proceed. Without consent, delegated calls for the blocked scope return `403 Forbidden` regardless of the token.

### 1.5 No client secret required

Delegated device-code flow authenticates the user — not the app — so no client secret is needed. Do not create one. (Contrast with `graph-email.md` which requires a client secret for client-credentials.)

---

## 2. Device-Code OAuth Flow

> **Reference**: [OAuth 2.0 device authorization grant](https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-device-code)

The device-code flow authenticates the agent as the user without requiring a browser on the agent's machine. The user signs in on any browser-capable device; the agent polls until sign-in completes.

### Step 1 — Request a device code

```bash
CLIENT_ID="<your-app-client-id>"
TENANT_ID="<your-tenant-id>"

# Space-delimited scopes — offline_access is mandatory for refresh tokens
SCOPE="offline_access Mail.Read Mail.Send Calendars.ReadWrite Contacts.Read Chat.ReadWrite ChannelMessage.Send Chat.Create"

curl -s -X POST \
  "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/devicecode" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "scope=${SCOPE}"
```

Response:

```json
{
  "device_code":        "DAQAB...",
  "user_code":          "ABCD-1234",
  "verification_uri":   "https://microsoft.com/devicelogin",
  "expires_in":         900,
  "interval":           5,
  "message":            "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-1234 to authenticate."
}
```

Note `device_code` (private — keep on agent), `user_code` (share with the user), `interval` (poll cadence in seconds), and `expires_in` (code validity window, typically 900s).

### Step 2 — Surface the code to the user

The agent must tell the user about the code. The canonical kithkit pattern is to deliver it via channel-router to the human's Telegram:

```bash
USER_CODE="ABCD-1234"
VERIFICATION_URI="https://microsoft.com/devicelogin"

curl -s -X POST 'http://localhost:3847/api/send' \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)" \
  -d "{
    \"message\": \"M365 sign-in needed.\n\nGo to: ${VERIFICATION_URI}\nEnter code: ${USER_CODE}\n\nCode expires in 15 minutes.\",
    \"channel\": \"telegram\"
  }"
```

Replace `USER_CODE` and `VERIFICATION_URI` with the values from Step 1. The user opens the URL on any device and enters the code. The agent does nothing until the poll in Step 3 succeeds.

> **NOTE — caller context**: `/api/send` requires a comms-tier or owner-tier agent token (`X-Agent-Token` header). Worker-tier agents receive 403 per PR #290. If your device-code surfacing runs from a worker, route it through your comms agent instead.

### Step 3 — Poll for the token

Poll `POST /oauth2/v2.0/token` every `interval` seconds (from Step 1 — typically 5s). Do NOT poll faster; Microsoft will respond with `slow_down`.

```bash
curl -s -X POST \
  "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "device_code=${DEVICE_CODE}"
```

| Response `error` | Meaning | Action |
|-----------------|---------|--------|
| `authorization_pending` | User has not signed in yet | Wait `interval` seconds and retry |
| `slow_down` | Polling too fast | Add 5s to your interval and retry |
| `access_denied` | User declined or tenant policy blocked consent | Abort; notify user; check admin consent (§1.4) |
| `expired_token` | Device code expired (>15 min) | Restart from Step 1 |
| _(no `error` field)_ | Success | Extract tokens — see Step 4 |

### Step 4 — Cache tokens

On success the response contains:

```json
{
  "access_token":  "eyJ0...",
  "refresh_token": "0.AW...",
  "expires_in":    3600,
  "token_type":    "Bearer",
  "scope":         "Mail.Read Mail.Send Calendars.ReadWrite ..."
}
```

**Access token** (~1h TTL): use for all Graph API calls. Cache in memory, or optionally in Keychain for cross-restart persistence (see §3 Keychain Convention).

**Refresh token** (no hard expiry; invalidated if unused >90 days or if the user revokes access): store in Keychain ONLY. Never store in config files, environment variables, or the daemon database.

```bash
# Store access token (optional cache — re-fetched on daemon restart if not present)
security add-generic-password -s "credential-m365-access-<agent>" -a "<agent>" -w "<ACCESS_TOKEN>"

# Store refresh token (required for persistence without repeated device-code prompts)
security add-generic-password -s "credential-m365-refresh-<agent>" -a "<agent>" -w "<REFRESH_TOKEN>"
```

Replace `<agent>` with your agent name (e.g., `bridget`).

### Refresh flow

On any Graph API call returning `401 Unauthorized`:

1. Attempt token refresh:

```bash
curl -s -X POST \
  "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}" \
  --data-urlencode "scope=${SCOPE}"
```

2. **On refresh success**: write the new access token (and new refresh token if returned) to Keychain; resume the original request.

3. **On refresh failure** (e.g., token revoked, user signed out, >90 days inactive): re-trigger the full device-code flow from Step 1. Notify the user via channel-router that a new sign-in is required.

---

## 3. Keychain Convention

This recipe establishes the **canonical M365 Keychain naming standard** for kithkit agents. Use this convention for all new setups and natural reauth events.

### 3.1 Canonical naming (new standard)

```bash
# Shared — same for all agents using the same app registration
# (use -a "shared" for the account so fleet members read back with the same pattern)
security add-generic-password -s "credential-m365-app-client-id" -a "shared"  -w "<CLIENT_ID>"
security add-generic-password -s "credential-m365-app-tenant-id" -a "shared"  -w "<TENANT_ID>"

# Per-agent — one set per agent identity
security add-generic-password -s "credential-m365-refresh-<agent>" -a "<agent>" -w "<REFRESH_TOKEN>"
security add-generic-password -s "credential-m365-access-<agent>"  -a "<agent>" -w "<ACCESS_TOKEN>"  # optional short-lived cache
```

> **Read-back note**: `security find-generic-password -s ... -w` ignores the `-a` account flag when reading by service name. The `-a "shared"` is for human discoverability — if you `security dump-keychain | grep credential-m365-app-`, the `"shared"` account makes it obvious these entries are fleet-wide, not per-agent. Functionally, only the `-s` service name matters for read-back.

Example for agent `bridget`:

```bash
security add-generic-password -s "credential-m365-app-client-id"   -a "shared"  -w "a1b2c3d4..."
security add-generic-password -s "credential-m365-app-tenant-id"   -a "shared"  -w "d4e5f6g7..."
security add-generic-password -s "credential-m365-refresh-bridget" -a "bridget" -w "0.AW..."
security add-generic-password -s "credential-m365-access-bridget"  -a "bridget" -w "eyJ0..."
```

Read back credentials in scripts:

```bash
CLIENT_ID=$(security find-generic-password -s "credential-m365-app-client-id"   -w)
TENANT_ID=$(security find-generic-password -s "credential-m365-app-tenant-id"   -w)
REFRESH=$(  security find-generic-password -s "credential-m365-refresh-bridget" -w)
ACCESS=$(   security find-generic-password -s "credential-m365-access-bridget"  -w)
```

Update an existing entry (e.g., after token refresh):

```bash
security add-generic-password -U -s "credential-m365-access-bridget" -a "bridget" -w "<NEW_ACCESS_TOKEN>"
```

### 3.2 Migrating legacy M365 credentials

If you followed an earlier BMO-pattern M365 setup, consolidate existing keychain entries to the unified `credential-m365-*` convention. List yours:

```bash
security dump-keychain | grep credential-
```

Device-code delegated auth REPLACES all client-secret and basic-auth (username/password, app-password) credentials. Delete those only AFTER the new delegated token passes a `mail.read` read-back (see §4.1).

| Legacy entry(ies) | New entry | Action |
|---|---|---|
| `credential-azure-client-id`, `-m365-client-id`, `-outlook-client-id` | `credential-m365-app-client-id` | CONSOLIDATE to the public-client app-reg ID; delete dupes |
| `credential-azure-tenant-id`, `-m365-tenant-id` | `credential-m365-app-tenant-id` | CONSOLIDATE; delete dupe |
| (newly minted) | `credential-m365-refresh-<agent>` | CREATE via device-code per agent (e.g. `-bmo`, `-bridget`) |
| `credential-outlook-personal-access-token` | `credential-m365-access-<agent>` | RE-MINT from new refresh token; do NOT copy old value |
| `credential-azure-secret-id`, `-azure-secret-value` | (delete) | DELETE — client-secret unused by device-code public client |
| `credential-m365-username`, `-m365-password` | (delete) | DELETE — ROPC/basic auth deprecated |
| `credential-outlook-dave-app-password`, `-outlook-personal-app-password` | (delete) | DELETE — app-password basic auth deprecated |
| `credential-{bridget,garth,jonsnow}-teams-{client-id,secret}`, `credential-teams-bot-*` | `credential-m365-refresh/access-<agent>` | MIGRATE to delegated Graph-chat (primary path). KEEP only if implementing Appendix A Bot Framework |
| `credential-graph-user-email`, `credential-outlook-user` | (no slot in v1 convention) | DELETE — identity comes from `/me` endpoint of the delegated token; no separate user-email keychain entry needed |

**NOTES:**
- `<agent>` = short name (bmo, skippy, bridget, ...).
- OUT OF SCOPE, leave untouched: `credential-azure-subscription-id`, `aws-*`, `cf-access-*`, `supabase-*`.
- `credential-outlook-personal-*` is a SEPARATE personal (Smith) mailbox, not the servos M365 target — listed only to show the access/refresh pattern; scope per your install.
- **RULE**: verify the new delegated token with `mail.read` BEFORE deleting ANY legacy credential.

**Identity (no user-email field in v1 convention)**: The 4-field convention deliberately omits a user-email entry. The signed-in identity is always discoverable via Graph's `/me` endpoint using the delegated token — no separate Keychain slot needed. Recipes that previously stored `credential-graph-user-email` for convenience should drop it on migration.

## Migrating from legacy credential names

If you ran an earlier BMO-pattern M365/Outlook setup, your Keychain entries predate the standardized `credential-m365-*` convention used throughout this recipe. Migrate by **adding** the new-convention entries (read your existing secret, write it under the new name); you can remove the legacy entries once verified. Nothing reads the legacy names after migration.

| Legacy BMO-pattern name | New standardized name | Scope | Notes |
|---|---|---|---|
| `outlook-imap-oauth2-access-token` | `credential-m365-access-<agent>` | per-agent | Short-lived; optional to migrate (re-minted from refresh). |
| `outlook-imap-oauth2-refresh-token` | `credential-m365-refresh-<agent>` | per-agent | **Load-bearing** — the long-lived token; migrate this. |
| `credential-outlook-<account>-access-token` | `credential-m365-access-<agent>` | per-agent | Per-account → per-agent; pick the agent that owns the mailbox. |
| `credential-outlook-<account>-refresh-token` | `credential-m365-refresh-<agent>` | per-agent | Load-bearing. |
| app client ID (config/inline or `credential-teams-bot-client-id`) | `credential-m365-app-client-id` | shared/fleet | One app registration per fleet; `-a "shared"`. |
| app tenant ID (config/inline) | `credential-m365-app-tenant-id` | shared/fleet | `-a "shared"`. |

**Migration one-liner per token** (read legacy → write new; example for a refresh token):

```bash
AGENT="bridget"
REFRESH=$(security find-generic-password -s "outlook-imap-oauth2-refresh-token" -w)
security add-generic-password -s "credential-m365-refresh-${AGENT}" -a "${AGENT}" -w "${REFRESH}"
# verify, then optionally remove the legacy entry:
security find-generic-password -s "credential-m365-refresh-${AGENT}" -w >/dev/null && echo "migrated ✓"
# security delete-generic-password -s "outlook-imap-oauth2-refresh-token"   # only after confirming everything reads the new name
```

> **Order matters**: migrate `refresh` (and the shared `app-client-id` / `app-tenant-id`) **before** restarting the daemon on the new convention — `access` regenerates from `refresh` automatically, but a missing refresh token forces a full re-auth.

---

## 4. Capabilities

Each capability section follows this structure: **Setup → Test → Validation Checklist → WHAT-GETS-COMMITTED → Rollback Notes**. Work through them in order — each section builds on the previous.

---

### 4.1 mail.read

**Purpose**: Read messages from the signed-in user's mailbox. Pure read — zero side effects. No gate.

#### Setup

Scope needed: `Mail.Read` (added in §1.4). No approval gate for read operations.

Extension config:

```yaml
extensions:
  m365_delegated:
    enabled: true
    provider: graph_delegated
    graph:
      client_id_credential:  credential-m365-app-client-id
      tenant_id_credential:  credential-m365-app-tenant-id
      refresh_credential:    credential-m365-refresh-bridget
      access_credential:     credential-m365-access-bridget   # optional short-lived cache
      poll_interval_minutes: 10
```

<!-- TODO: Confirm the extension config key name (`m365_delegated`) and provider value (`graph_delegated`) once the kithkit M365 delegated extension is implemented on the daemon side -->

#### Test — list most recent message

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)

curl -s 'https://graph.microsoft.com/v1.0/me/messages?$top=1&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,isRead' \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "Content-Type: application/json" | python3 -m json.tool
```

Expected: HTTP 200, JSON with `value` array containing one message object with `subject`, `from.emailAddress.address`, and `receivedDateTime` populated.

#### Polling-pattern sub-test

Exercises the inbox polling loop on the safest capability before you need it for Teams.

1. Run the test above — note the `receivedDateTime` of the most recent message.
2. Wait 5 minutes.
3. Send yourself an email with subject `[recipe-test-DELETE-ME-<datestamp>]` from another account or device.
4. Re-run the test — confirm the new message appears in the response (earlier `receivedDateTime` replaced by the new one, or increase `$top=5` to see multiple).
5. Tick the sub-checkbox below.

#### Validation Checklist

```
[ ] curl returns 200 — if 401, see Pitfall R.1 (token expired); if 403, see Pitfall R.2 (scope not granted)
[ ] Response `value` array contains at least one message
[ ] `from.emailAddress.address` field populated (not null or empty)
[ ] `receivedDateTime` field present and parseable ISO8601 UTC
[ ] Polling-pattern sub-test: new message visible after send-and-wait cycle
[ ] No write operations triggered — inbox unchanged after all curls
```

**Pitfall R.1 — token expired**: Run the refresh flow (§2 Refresh flow). If refresh fails, re-trigger the full device-code flow from §2 Step 1.

**Pitfall R.2 — Mail.Read scope not granted**: In Azure portal, go to **API permissions** and confirm `Mail.Read` shows "Granted for [Tenant]". If not, run admin consent grant (§1.4).

#### WHAT-GETS-COMMITTED

None. mail.read is read-only. No approval gate, no side effects, no cleanup required for the read test itself.

#### Rollback Notes

The polling-pattern sub-test sends a real email from your own account to yourself. Delete `[recipe-test-DELETE-ME-<datestamp>]` from your inbox and Sent Items when done with this section.

---

### 4.2 mail.send

> **HARD PREREQUISITE**: This section requires `approval-workflow.md` to be **fully implemented** and the approval gate **wired into the channel-router outbound path**. Do NOT proceed until the approval gate is functional and the Telegram card render has been verified independently. [→ approval-workflow.md]

**Purpose**: Send email as the signed-in user. First outbound capability — exercises the full approval workflow integration.

#### Setup

Scope needed: `Mail.Send` (added in §1.4).

**Adapter required**: Tests below assume you have registered an `m365-mail` adapter with the channel-router. The adapter wraps Graph's `/me/sendMail` and is the path the approval gate intercepts. See `approval-workflow.md §Step 2 — Wire gate into channel-router outbound paths` for the canonical adapter+middleware wiring pattern.

> **Why an adapter, not a direct Graph curl?** The approval gate is middleware on the channel-router's outbound path (`adapter.send → gate → transport`). A direct `curl https://graph.microsoft.com/v1.0/me/sendMail` bypasses the router entirely — no gate fires, no card appears, no audit entry written. A capability that is supposed to be gated MUST route through its channel-router adapter, or the gate is a fiction. Direct Graph curls are appropriate only for read capabilities (e.g., `mail.read`, §4.1) where no gate is wired.

Add approval policy to `kithkit.config.yaml`:

```yaml
approval_policies:
  mail_send:
    require_approval_for: all   # start conservative; tune after baseline established
    timeout_minutes: 10
  external_email_send:
    require_approval_for: external_only
    timeout_minutes: 30         # extra time for recipients outside the tenant domain
```

<!-- TODO: Confirm `approval_policies` config key path matches the approval-workflow.md implementation when built -->

Reload config:

```bash
curl -s -X POST 'http://localhost:3847/api/config/reload' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)"
```

#### Test A — send and approve (routed through channel-router)

```bash
DATESTAMP=$(date +%Y%m%d-%H%M%S)
SUBJECT="[recipe-test-DELETE-ME-${DATESTAMP}]"
YOUR_EMAIL="you@yourdomain.com"

curl -s -X POST 'http://localhost:3847/api/send' \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)" \
  -d "{
    \"channel\": \"m365-mail\",
    \"to\": \"${YOUR_EMAIL}\",
    \"subject\": \"${SUBJECT}\",
    \"message\": \"recipe test — approve me\"
  }"
```

> **NOTE — adapter-defined params**: `/api/send` accepts `{message, channel}` as its base shape. The additional fields `to` and `subject` are **adapter-defined** — your `m365-mail` adapter implementation declares these as its required params and consumes them when building the Graph `/me/sendMail` payload. If you choose different param names (e.g., `recipient`, `subject_line`), this example's curl shape changes accordingly. The `/api/send` router passes the full body through to the adapter.

Expected sequence:
1. Channel-router receives request, dispatches to `m365-mail` adapter
2. Adapter calls the approval gate middleware (per approval-workflow.md §Wiring Sequence)
3. Approval card appears on Telegram (~5s) with message preview, recipient, and Approve/Reject buttons
4. Tap **Approve**
5. Gate releases; adapter calls Graph `/me/sendMail` under the hood
6. `/api/send` returns 200 with `{"results":{"m365-mail":true}}`
7. Message arrives in inbox with matching subject

#### Test B — reject path

Repeat Test A with a new `DATESTAMP`. When the card appears, tap **Reject**.

Expected:
- Gate aborts; adapter never calls Graph; no message sent — inbox unchanged
- `/api/send` returns 200 with `{"results":{"m365-mail":false}}` (or adapter-defined rejection shape)
- Audit log entry: `decision=rejected, sender_agent=bridget`

#### Validation Checklist

```
[ ] Approval card appears on Telegram within ~5s of curl — if not, see Pitfall S.1 (gate not wired)
[ ] Card shows correct recipient address, subject preview, and sender agent name
[ ] Approve path: email arrives in inbox with exact matching subject
[ ] Reject path: no email in inbox; abort confirmed; audit log entry present
[ ] /api/send returns 200 with adapter-success result on approve path — if 403 from Graph (visible in daemon log), see Pitfall S.2 (Mail.Send scope); if 400, see Pitfall S.3 (payload or attachment limit)
[ ] Audit log entry for Test A and Test B both present with `decision`, `content_hash`, `recipient_set_hash`, `sender_agent`
```

**Pitfall S.1 — gate not wired**: Confirm `approval-workflow.md` is implemented and the middleware is registered in the channel-router outbound path. Check daemon logs for gate invocation.

**Pitfall S.2 — 403 Forbidden on sendMail**: Confirm `Mail.Send` delegated permission shows "Granted for [Tenant]" in Azure portal. Re-run admin consent if needed.

**Pitfall S.3 — attachment size limits**: Graph API enforces ~3 MB raw / 4 MB base64-encoded for inline attachments. Larger files require the upload session API (`POST /me/messages/{id}/attachments`). Recipe tests use no attachments — if adding attachments, use the upload session path.

<!-- TODO: Add link to Graph attachment upload session documentation once the canonical Microsoft Docs URL is confirmed -->

#### WHAT-GETS-COMMITTED

> **Approving Test A sends a real email to your inbox.** The subject pattern `[recipe-test-DELETE-ME-<datestamp>]` marks it for cleanup. Delete from inbox and Sent Items when done.

#### Rollback Notes

Search and delete test artifacts by subject pattern:

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)

# Find test messages — returns IDs for manual deletion or scripted cleanup
curl -s "https://graph.microsoft.com/v1.0/me/messages?\$filter=contains(subject,'recipe-test-DELETE-ME')&\$select=id,subject,receivedDateTime" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Delete by ID:

```bash
MSG_ID="<id-from-above>"
curl -s -X DELETE "https://graph.microsoft.com/v1.0/me/messages/${MSG_ID}" \
  -H "Authorization: Bearer ${ACCESS}"
# Expected: HTTP 204 No Content
```

Also check **Sent Items** — Graph sendMail leaves a copy there.

---

### 4.3 calendar

#### 4.3.1 calendar.read

**Purpose**: List upcoming calendar events. Read-only — no gate.

##### Setup

Scope needed: `Calendars.Read` (or `Calendars.ReadWrite` if calendar.write will also be used — grant the broader scope once rather than twice).

##### Test — list next 5 events

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)
NOW=$(python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")

curl -s -G 'https://graph.microsoft.com/v1.0/me/calendarView' \
  --data-urlencode "startDateTime=${NOW}" \
  --data-urlencode "endDateTime=2099-01-01T00:00:00Z" \
  -d '$top=5' \
  -d '$orderby=start/dateTime' \
  -d '$select=id,subject,start,end,attendees,isAllDay' \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Expected: HTTP 200, `value` array with up to 5 event objects, each with `start.dateTime` in UTC.

##### Validation Checklist

```
[ ] curl returns 200 — if 401, see §2 Refresh flow; if 403, see Pitfall C.2 (Calendars.Read scope)
[ ] Events include `start.dateTime` with UTC suffix (`Z`) — see Pitfall C.3 (timezone)
[ ] `isAllDay` field present on each event — see Pitfall C.4 (all-day event quirk)
[ ] No write operations triggered
```

**Pitfall C.2 — 403 on calendarView**: Confirm `Calendars.Read` or `Calendars.ReadWrite` is granted in Azure portal.

**Pitfall C.3 — timezone**: Graph returns all `dateTime` values in UTC. Outlook displays them in the user's configured local timezone. When creating events (§4.3.2), always supply UTC with a `Z` suffix, or include a `timeZone` property (e.g., `"timeZone": "America/New_York"`). Never assume local time from the machine clock.

**Pitfall C.4 — all-day events**: All-day events use `date` format (`"2026-06-01"`) in `start`/`end`, not `dateTime`. Attempting to read `start.dateTime` on an all-day event returns `null` — the value is in `start.date`. Check `isAllDay` before accessing `dateTime`.

##### WHAT-GETS-COMMITTED

None. calendar.read is read-only.

##### Rollback Notes

No rollback required.

---

#### 4.3.2 calendar.write

> **Gate active**: Creating an event with attendees sends real calendar invitations. This triggers the approval workflow.

**Purpose**: Create, update, and delete calendar events.

##### Setup

Scope needed: `Calendars.ReadWrite` (superset of `Calendars.Read`; add if not already present from §1.4).

Add approval policy:

```yaml
approval_policies:
  calendar_write:
    require_approval_for: all
    timeout_minutes: 10
```

Reload config:

```bash
curl -s -X POST 'http://localhost:3847/api/config/reload' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)"
```

##### Test — create, approve, verify, delete

**Step 1** — Create a test event with yourself as attendee:

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)
DATESTAMP=$(date +%Y%m%d-%H%M%S)
YOUR_EMAIL="you@yourdomain.com"

CREATE_RESPONSE=$(curl -s -X POST \
  'https://graph.microsoft.com/v1.0/me/events' \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "Content-Type: application/json" \
  -d "{
    \"subject\": \"[recipe-test-DELETE-ME-${DATESTAMP}]\",
    \"start\": {\"dateTime\": \"2099-01-01T10:00:00\", \"timeZone\": \"UTC\"},
    \"end\":   {\"dateTime\": \"2099-01-01T10:30:00\", \"timeZone\": \"UTC\"},
    \"attendees\": [{
      \"emailAddress\": {\"address\": \"${YOUR_EMAIL}\", \"name\": \"Recipe Test\"},
      \"type\": \"required\"
    }]
  }")
EVENT_ID=$(echo "${CREATE_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Event ID: ${EVENT_ID}"
```

**Step 2** — Approve the card on Telegram.

**Step 3** — Verify the event is on the calendar:

```bash
curl -s "https://graph.microsoft.com/v1.0/me/events/${EVENT_ID}?\$select=id,subject,start,attendees" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

**Step 4** — Delete the test event:

```bash
curl -s -X DELETE \
  "https://graph.microsoft.com/v1.0/me/events/${EVENT_ID}" \
  -H "Authorization: Bearer ${ACCESS}"
# Expected: HTTP 204 No Content
```

##### Validation Checklist

```
[ ] Approval card appears on Telegram before event is created — if not, see Pitfall C.5 (gate position)
[ ] Step 3 returns event with correct subject and UTC start/end — if 400 on create, see Pitfall C.3 or C.4
[ ] Calendar invite email received (you are listed as attendee) — confirms Graph outbound invite path is live
[ ] Step 4 returns 204 — event removed from calendar
[ ] Audit log entry present for the create-event approval decision
```

**Pitfall C.5 — gate not triggering on event create**: The approval gate must intercept `calendar_write` sends in the channel-router middleware. Confirm `approval_policies.calendar_write` is configured and the gate is registered for calendar outbound paths.

##### WHAT-GETS-COMMITTED

> **Approving the test sends a real calendar invite to the attendee email and creates a real event.** The event is set in 2099 to avoid calendar clutter. Subject pattern marks it for cleanup. Delete in Step 4 of the test.

##### Rollback Notes

The test sequence deletes the event in Step 4. If the test was aborted before Step 4, clean up with:

```bash
# Delete by known ID
curl -s -X DELETE "https://graph.microsoft.com/v1.0/me/events/${EVENT_ID}" \
  -H "Authorization: Bearer ${ACCESS}"

# Or find by subject pattern
curl -s "https://graph.microsoft.com/v1.0/me/events?\$filter=contains(subject,'recipe-test-DELETE-ME')&\$select=id,subject" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

---

### 4.4 contacts

**Purpose**: Read personal contacts. Read-only; contacts.write is deferred to a future capability.

#### Setup

Scope needed: `Contacts.Read` (added in §1.4). No gate for read-only operations.

> **Contacts surface clarification** — three distinct Graph endpoints, different semantics:
>
> | Endpoint | Scope | What it returns |
> |----------|-------|----------------|
> | `/me/contacts` | `Contacts.Read` | User's personal contacts folder (Outlook Contacts) |
> | `/me/people` | `People.Read` | Inferred relationships from email/meeting history |
> | `/users` | `User.Read.All` + admin consent | Full organization directory |
>
> **This section covers `/me/contacts` only.** Using the wrong endpoint for your use case is the single most common contacts pitfall (Pitfall CN.1).

#### Test A — list top 10 contacts

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)

curl -s 'https://graph.microsoft.com/v1.0/me/contacts?$top=10&$select=id,displayName,emailAddresses,mobilePhone' \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Expected: HTTP 200, `value` array with up to 10 contact objects.

#### Test B — search by display name substring

```bash
SEARCH_NAME="Smith"   # Replace with a name present in your contacts

curl -s "https://graph.microsoft.com/v1.0/me/contacts?\$filter=startswith(displayName,'${SEARCH_NAME}')&\$select=id,displayName,emailAddresses" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Expected: filtered list matching the prefix.

#### Validation Checklist

```
[ ] Test A returns 200 — if 401, see §2 Refresh flow; if 403, see Pitfall CN.2 (scope)
[ ] `emailAddresses` array populated on at least one contact
[ ] Test B returns filtered results matching the search prefix
[ ] URL used is `/me/contacts` (not `/me/people` or `/users`) — see Pitfall CN.1
```

**Pitfall CN.1 — wrong endpoint**: `/me/people` returns people Graph infers from your communication patterns — not your Contacts folder. `/users` requires `User.Read.All` (admin-granted Application permission). Use `/me/contacts` for personal address book.

**Pitfall CN.2 — 403 on /me/contacts**: Confirm `Contacts.Read` delegated permission is granted in Azure portal.

#### WHAT-GETS-COMMITTED

None. contacts is read-only.

#### Rollback Notes

No rollback required.

---

### 4.5 teams.chat

> **Primary approach**: Microsoft Graph API with the same delegated OAuth token from §2. No Bot Framework service registration, no Teams admin manifest, no separate app registration. One OAuth surface covers all five capabilities.
>
> For adaptive cards, channel @mentions, or external-user proactive messaging, see [Appendix A — Bot Framework](#appendix-a-bot-framework-optional).

**Purpose**: Read and send Teams chat messages (1:1 and group chats); poll for inbound messages using the delta endpoint.

#### Setup

Scopes needed: `Chat.ReadWrite`, `ChannelMessage.Send`, `Chat.Create` (added in §1.4).

Add approval policy:

```yaml
approval_policies:
  teams_chat_send:
    require_approval_for: all
    timeout_minutes: 10
```

Polling config:

```yaml
extensions:
  m365_delegated:
    teams:
      poll_interval_minutes: 10   # 5-15 min is the safe range; 10 is a balanced default
```

<!-- TODO: Confirm teams polling config key path (`extensions.m365_delegated.teams.poll_interval_minutes`) once daemon extension is implemented -->

Reload config:

```bash
curl -s -X POST 'http://localhost:3847/api/config/reload' \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)"
```

#### Test A — list recent chats

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)

curl -s 'https://graph.microsoft.com/v1.0/me/chats?$top=5&$select=id,topic,chatType,lastUpdatedDateTime' \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Expected: HTTP 200, `value` array with up to 5 chat objects. Each has an `id` and `chatType` (`oneOnOne`, `group`, or `meeting`). Note the `id` of your self-chat for Test C.

#### Test B — read latest messages in a chat

```bash
CHAT_ID="<chat-id-from-Test-A>"

curl -s "https://graph.microsoft.com/v1.0/me/chats/${CHAT_ID}/messages?\$top=5&\$orderby=createdDateTime%20desc" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

#### Test C — send to self-chat (gate applies)

> **Pitfall T.1 — self-chat must pre-exist**: The self-chat is a 1:1 conversation between the user and themselves. It only appears in `/me/chats` if you have previously opened it in the Teams client. Open Teams, search your own name, click Chat, send a message to yourself to create it — then re-run Test A to get its ID.

```bash
SELF_CHAT_ID="<self-chat-id-from-Test-A>"
DATESTAMP=$(date +%Y%m%d-%H%M%S)

curl -s -X POST \
  "https://graph.microsoft.com/v1.0/me/chats/${SELF_CHAT_ID}/messages" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "Content-Type: application/json" \
  -d "{
    \"body\": {
      \"contentType\": \"text\",
      \"content\": \"[recipe-test-DELETE-ME-${DATESTAMP}] kithkit recipe validation\"
    }
  }"
```

Expected sequence:
1. Approval card appears on Telegram
2. Tap **Approve**
3. Message appears in Teams self-chat

#### Test D — validate polling picks up inbound reply

After Test C, reply to the self-chat from the Teams app or another device. Then use the delta endpoint to confirm the polling loop picks it up.

```bash
# First delta call — initializes the delta state and returns a deltaLink
DELTA_RESPONSE=$(curl -s \
  "https://graph.microsoft.com/v1.0/me/chats/${SELF_CHAT_ID}/messages/delta" \
  -H "Authorization: Bearer ${ACCESS}")
DELTA_LINK=$(echo "${DELTA_RESPONSE}" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('@odata.deltaLink','NOT FOUND'))")
echo "deltaLink: ${DELTA_LINK}"

# After the inbound reply arrives (wait for poll_interval_minutes or trigger manually):
curl -s "${DELTA_LINK}" -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Expected: the inbound reply appears in the delta response within the configured poll cadence (5-15 min).

#### Validation Checklist

```
[ ] Test A returns chat list — if 401, see §2 Refresh flow; if 403, see Pitfall T.2 (Chat.ReadWrite scope)
[ ] Self-chat ID identified from Test A (chatType: oneOnOne with yourself)
[ ] Test B reads messages from a selected chat
[ ] Test C: approval card appears on Telegram; message sent to self-chat after Approve — if 403, see Pitfall T.3
[ ] Test D: inbound reply detected via delta endpoint within poll cadence
[ ] Channel messages note: posting to a Teams channel (not a chat) requires channel ID from /teams/{teamId}/channels — see Pitfall T.4
```

**Pitfall T.2 — 403 on /me/chats**: Confirm `Chat.ReadWrite` delegated permission is granted with admin consent in Azure portal.

**Pitfall T.3 — 403 on message send**: `Chat.ReadWrite` covers 1:1 and group chats. For Teams channel posts, `ChannelMessage.Send` is also needed. Confirm both are granted.

**Pitfall T.4 — channel messages vs chat messages**: `/me/chats` surfaces only 1:1 and group chats. Teams channel posts use `/teams/{teamId}/channels/{channelId}/messages` and require the channel ID (available from **Teams admin portal** or `GET /me/joinedTeams` → `GET /teams/{id}/channels`).

#### WHAT-GETS-COMMITTED

> **Approving Test C sends a real message to your Teams self-chat.** The message body contains the recipe-test pattern. Delete it from Teams when done.

#### Rollback Notes

Delete the test message from the Teams self-chat using the Teams client (tap message > More options > Delete). No Graph API delete path exists for chat messages under delegated scope without elevated permissions.

<!-- TODO: Verify whether DELETE /me/chats/{id}/messages/{messageId} is available under Chat.ReadWrite delegated scope in Graph v1.0, or if it requires tenant admin permissions. Update rollback notes accordingly. -->

---

## 5. End-to-End Acceptance Gate

Run this gate **last** — after all five capability sections above are fully green-checked. This is the integration test that proves all capabilities work together as a system.

### Steps

**Step 1** — Send self-email via mail.send routed through the channel-router (triggers approval-gate card):

```bash
DATESTAMP=$(date +%Y%m%d-%H%M%S)
YOUR_EMAIL="you@yourdomain.com"
SUBJECT="[recipe-test-DELETE-ME-${DATESTAMP}]"

curl -s -X POST 'http://localhost:3847/api/send' \
  -H "Content-Type: application/json" \
  -H "X-Agent-Token: $(cat .kithkit/.comms-token)" \
  -d "{
    \"channel\": \"m365-mail\",
    \"to\": \"${YOUR_EMAIL}\",
    \"subject\": \"${SUBJECT}\",
    \"message\": \"end-to-end acceptance gate\"
  }"
```

(Same adapter-defined-params shape as §4.2 — `to` and `subject` are consumed by your `m365-mail` adapter.)

**Step 2** — Approve the card from Telegram. Tap **Approve** within the configured timeout (default 10 min).

**Step 3** — Wait for the poll cycle. Allow 5-15 minutes per your `poll_interval_minutes` setting from §4.1.

**Step 4** — Read inbox and confirm the message is present:

```bash
ACCESS=$(security find-generic-password -s "credential-m365-access-bridget" -w)
curl -s "https://graph.microsoft.com/v1.0/me/messages?\$filter=contains(subject,'recipe-test-DELETE-ME')&\$select=id,subject,receivedDateTime" \
  -H "Authorization: Bearer ${ACCESS}" | python3 -m json.tool
```

Confirm: message with matching subject is in the response, with a `receivedDateTime` after Step 1.

**Step 5** — Query the audit-log sink and confirm the approval decision entry:

The `approval_decisions` table (schema in `approval-workflow.md §Audit log schema`) is written by the instrumentation step every time the gate resolves. The Step-2 approval is therefore a COMPLETED row in this table, NOT a pending entry. Query the sink directly:

```bash
# Adjust DB path to your install's kithkit.db location — common locations:
#   ~/Library/Application Support/kithkit/kithkit.db   (default per-user install)
#   ./kithkit.db                                        (project-local install)
# Check `db_path` in `curl -s http://localhost:3847/health | python3 -m json.tool`.
DB="$HOME/Library/Application Support/kithkit/kithkit.db"

sqlite3 "$DB" \
  "SELECT approval_id, decision, decider, sender_agent, channel,
          content_hash, recipient_set_hash, decided_at
   FROM approval_decisions
   WHERE channel = 'm365-mail'
   ORDER BY decided_at DESC LIMIT 1;"
```

Confirm the row contains: `decision='approved'`, `decider='human'`, `sender_agent` matches your agent name, `content_hash` and `recipient_set_hash` are non-null SHA-256 hex strings.

<!-- TODO: Add a Reader-follow-up entry: implement GET /api/approval/decisions historical endpoint to replace this direct-DB query. v1 deliberately accepts the SQL-on-sink approach to avoid scope-creeping a new daemon endpoint into the recipe. Tracked in §7.3 Recipe-meta open. -->

> **Why not `/api/approval/pending`?** The `pending` endpoint is in-flight-only by design — the moment Step 2 records the Approve decision, the row moves out of the in-flight set and into the audit sink. Querying `/pending` here would return an empty result and falsely suggest the test failed.

**Step 6** — Cleanup:

```bash
# Note MSG_ID from Step 4 output, then delete:
MSG_ID="<message-id>"
curl -s -X DELETE "https://graph.microsoft.com/v1.0/me/messages/${MSG_ID}" \
  -H "Authorization: Bearer ${ACCESS}"
# Expected: HTTP 204 No Content

# Audit log row: retain if your audit/compliance policy requires it (2 CFR 200 frequently does).
# Optional deletion: directly via SQL — DELETE FROM approval_decisions WHERE approval_id = '<id>';
```

### Acceptance Checklist

```
[ ] Step 1: sendMail call succeeds (no 4xx errors from Graph)
[ ] Step 2: approval card received on Telegram within ~5s of Step 1
[ ] Step 3: full poll cycle elapsed before Step 4
[ ] Step 4: message found in inbox with exact matching subject and datestamp
[ ] Step 5: audit log entry confirmed — decision, content_hash, recipient_set_hash, sender_agent all present
[ ] Step 6: test message deleted from inbox; audit row retained or removed per policy
```

---

## 6. Cross-Pointer Table

| Acceptance gate step | Owning section | What it validates |
|---------------------|----------------|-------------------|
| 1. Send self-email | §4.2 mail.send | Outbound send path + gate activation |
| 2. Approve from Telegram | approval-workflow.md § Card, § Approval-API | Card rendering + inline button callback |
| 3. Wait poll cycle | §4.1 mail.read (polling-pattern sub-test) | Polling cadence config correctness |
| 4. Read inbox, confirm message | §4.1 mail.read | Read access + message presence in inbox |
| 5. Query audit log | approval-workflow.md § Instrumentation | Decision logging + hash field presence |
| 6. Delete test message | §4.2 mail.send Rollback Notes | Cleanup procedure works end-to-end |

---

## 7. Open Items

### 7.1 Deferred to v2

- Dynamic policy store (DB-backed rules, modifiable without redeploy or Git commit)
- `contacts.write` capability (`PATCH`/`POST /me/contacts` — personal address book mutations)
- Presence and meetings scopes (`Presence.Read.All`, `OnlineMeetings.ReadWrite`)
- Bot Framework appendix completion (Appendix A is a placeholder — complete only if demand is confirmed)

### 7.2 Reader follow-ups

- **Tenant policy verification**: confirm your tenant allows the delegated scopes you added (some tenants block `Chat.ReadWrite` or `Mail.Send` at the Conditional Access or app policy layer, not just the consent layer)
- **Cert renewal calendar entry**: if you activated Appendix B (change-notification subscriptions), create a calendar reminder ~80 days after cert issuance to renew before the 90-day Let's Encrypt expiry
- **Legacy-keychain migration**: if pre-standard Keychain entries are present (§3.2), plan migration at the next natural reauth event

### 7.3 Recipe-meta open items

- **Recipe versioning**: no formal version field in this document. v1 = this file as shipped. How v2 changes are communicated to fleet members who already followed v1 is not yet defined.
- **v1 → v2 upgrade path**: when the dynamic policy store ships, readers who configured static `approval_policies:` YAML will need a migration guide. TBD at that point.

---

## Appendix A — Bot Framework (Optional)

> **Gate**: Most personal-data agents do NOT need Bot Framework. Consider it only if you require:
> - Adaptive cards with interactive form elements, rich layout, or action buttons beyond Approve/Reject
> - Channel @mentions in Teams channels (Graph `ChannelMessage.Send` sends plain messages only)
> - Proactive messaging to **external users** (outside your tenant)
>
> If none of these apply, stop here. The main recipe's Graph-API-only approach is the right model for personal-data agents.

References (for when you need this path):
- [Bot Framework overview](https://learn.microsoft.com/en-us/azure/bot-service/bot-builder-overview)
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema)

<!-- TODO: Complete Appendix A if reader demand confirms need. Key items to document: separate Bot Framework app registration (distinct from the delegated M365 app), Bot Service channel registration in Azure, Teams app manifest creation and sideloading, proactive messaging pattern (conversation reference storage), adaptive card schema basics, and how Bot Framework auth coexists with the delegated OAuth in this recipe. -->

---

## Appendix B — Change-Notification Subscriptions (Optional)

> **Gate**: Consider change-notification subscriptions only if your agent must react to inbound Teams messages or new email **within seconds**. For most personal-data agents, polling (§4.5 Test D, §4.1 polling-pattern sub-test) at 5-15 minute cadence is sufficient and requires no inbound infrastructure.

Change-notification subscriptions have Microsoft push Graph events to an HTTPS endpoint you host.

**Requirements**:
- HTTPS endpoint reachable from Microsoft's notification service (Cloudflare Tunnel or similar; laptop NAT traversal is not sufficient without a tunneling layer)
- Valid TLS certificate — Let's Encrypt 90-day certs are common; **plan renewal** (see §7.2 Reader follow-ups)
- Webhook validation handshake: when Microsoft first calls your endpoint, it sends a `validationToken` query parameter — your endpoint must echo it as plain text within 10 seconds

**Subscription lifecycle**:
- Subscriptions expire (max 4230 minutes for mail/calendar; shorter for Teams resources)
- Renew before expiry via `PATCH /v1.0/subscriptions/{id}`
- Missed renewal = missed events until subscription is re-created; a delta catch-up pass is required

<!-- TODO: Document full subscription creation, renewal, and teardown procedure if Appendix B is activated. Include delta token handling for catch-up after missed events, and a renewal scheduler pattern using the kithkit scheduler API. -->
