---
name: m365-tos
description: Microsoft 365 / Graph API Terms of Service compliance — API rate limits, throttling patterns, email sending limits, app registration rules. Use before Graph API operations or email automation.
user-invocable: false
---

# Microsoft 365 / Graph API TOS Compliance

Reference skill for operating within Microsoft 365's Terms of Service. Loaded automatically when performing Graph API operations, email sending, or M365 management.

**Why this exists**: When using Graph API for email via Exchange Online, the API has aggressive per-mailbox throttling that differs from typical API rate limits.

## Hard Rules (Violations = App Suspension)

1. **No excessive API calls** — Microsoft will throttle, then potentially suspend your app registration
2. **No spam email** — Exchange Online has strict sending limits and monitors for spam patterns
3. **No credential sharing** — each app registration must use its own client ID/secret
4. **No bulk data extraction** — scraping mailbox data for purposes unrelated to the app's stated function
5. **No circumventing throttling** — don't retry aggressively when receiving 429s

## Graph API Rate Limits

### Per-App, Per-Mailbox Throttling

Graph API uses a **per-app, per-resource** throttling model. Limits are NOT globally documented — they adapt dynamically based on load and resource type.

| Scope | Approximate Limit | Notes |
|-------|-------------------|-------|
| Per-app, per-mailbox | ~10,000 requests / 10 minutes | For mail operations |
| Per-app, per-tenant | Varies by workload | Higher than per-mailbox |
| Concurrent requests | ~4 per app per mailbox | Simultaneous in-flight |

### Throttling Response

When throttled, Graph API returns **HTTP 429** with:
- `Retry-After` header (seconds to wait)
- Response body with `error.code: "TooManyRequests"` or `"ApplicationThrottled"`

### Best Practices for API Calls
1. **Exponential backoff**: On 429, wait the `Retry-After` value, then double on each retry
2. **Batch requests**: Use `$batch` endpoint to combine up to 20 requests in one call
3. **Delta queries**: Use `$delta` for change tracking instead of polling full collections
4. **Select fields**: Use `$select` to request only needed properties
5. **Pagination**: Respect `@odata.nextLink` — don't try to fetch all data in one request

## Email Sending Limits (Exchange Online)

| Limit | Value | Notes |
|-------|-------|-------|
| Recipients per message | 500 | To + CC + BCC combined |
| Messages per day | 10,000 | Per mailbox |
| Recipients per day | 10,000 | Total across all messages |
| Message size | 150 MB | Including attachments (Base64 encoded) |
| Attachment size (Graph API) | 150 MB (with upload session) | 4 MB without upload session |

### Anti-Spam Monitoring
- Exchange Online monitors sending patterns
- Sudden spikes in volume can trigger temporary sending blocks
- NDR (Non-Delivery Report) flood protection may block automated sends
- **Our usage** (~10-20 emails/day) is well below all limits

## App Registration Rules

### Requirements
- Each application needs its own app registration in Azure AD
- **Client secret expiry**: Maximum 2 years, cannot create non-expiring secrets
- **Certificate auth** preferred over client secrets for production
- Delegated permissions require user consent; Application permissions require admin consent

### Our Setup
- App registration for your agent's email access
- Uses `Mail.Read` and `Mail.Send` Application permissions
- Client secret stored in Keychain as `credential-azure-m365-*`
- **Must rotate client secret before expiry** — check expiry date periodically

### Permission Scoping
- Request **minimum necessary permissions**
- `Mail.Read` + `Mail.Send` is appropriate for our email use case
- Don't request `Mail.ReadWrite` unless you need to modify/delete messages
- Application permissions apply to ALL mailboxes in the tenant — use with care

## Shared Mailbox / Multi-Account

- Single app registration can access multiple mailboxes with Application permissions
- Each mailbox has its own throttling bucket
- Peer agents can reuse the same app registration for their mailbox (same tenant)
- Rate limits are per-app-per-mailbox, so separate mailboxes don't interfere

## What Gets You Throttled

1. **Polling too frequently**: Checking mail every few seconds instead of using webhooks/delta
2. **Full sync on every check**: Fetching all messages instead of delta changes
3. **Too many concurrent requests**: More than ~4 simultaneous calls per mailbox
4. **Large result sets**: Requesting thousands of messages without pagination
5. **Retry storms**: Hammering the API after getting 429s

### Our email-check Task
The daemon checks email every 15 minutes — this is very conservative and well within limits. Uses delta queries where possible.

## Key TOS References

| Document | Topic |
|----------|-------|
| Microsoft Services Agreement | General terms for M365 services |
| Graph API Throttling Guidance | Per-resource throttling model |
| Exchange Online Limits | Sending limits, mailbox size, recipient limits |
| Azure AD App Registration | Permission model, consent, secret management |
| Microsoft Graph Best Practices | Batching, delta queries, error handling |
