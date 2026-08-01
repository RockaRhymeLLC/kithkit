# Recipe: Anthropic Enterprise Analytics (Usage & Cost Reporting)

Pull org-level, per-user usage and cost rollups from the Anthropic Enterprise Analytics API. Read-only — this recipe queries token counts, request counts, and cost by user/model/day, useful for spend dashboards, per-team usage digests, or an "am I about to blow the budget" check.

This is a separate API base from the standard Messages API, with its own auth conventions. Getting the base URL, header, and required params exactly right is most of the work — the endpoints themselves are simple GETs.

---

## Prerequisites

- An Anthropic Enterprise/organization account with Analytics access enabled
- A standard `sk-ant-api...` organization API key (not a personal key, not an `sk-ant-admin...` key — see Gotchas for the difference)
- Node.js 22+ (daemon runtime) or just `curl` for ad-hoc pulls
- The Kithkit daemon configured and running, if wiring this into a scheduled task

---

## Setup Steps

### Step 1 — Get an organization API key

1. Sign in to the [Anthropic Console](https://console.anthropic.com) with an account that has organization admin access
2. Generate (or locate) a standard organization API key (`sk-ant-api...`)
3. Confirm Analytics is enabled for your org — if the `user_usage_report` call in Step 3 below returns `authentication_error` or 404, Analytics may not be provisioned

### Step 2 — Store the key in Keychain

```bash
security add-generic-password \
  -s credential-anthropic-analytics-key \
  -a assistant \
  -w "YOUR_ORG_API_KEY_HERE"
```

Verify it stored correctly:

```bash
security find-generic-password -s credential-anthropic-analytics-key -w
```

Read the key at runtime only — never write its value into a file, log line, or commit.

### Step 3 — Verify with a live pull

```bash
KEY=$(security find-generic-password -s credential-anthropic-analytics-key -w)
curl -s "https://api.anthropic.com/v1/organizations/analytics/user_usage_report?starting_at=2026-01-01T00:00:00Z&limit=5" \
  -H "x-api-key: $KEY"
```

A working response has an envelope shape of `{ organization_id, data: [...], has_more, next_page, data_refreshed_at }`. If you get `authentication_error`, double-check the base URL has the `/analytics/` segment and that you are **not** sending an `anthropic-version` header (see Gotchas).

### Step 4 — Wire into a scheduled task (optional)

If you want a recurring digest rather than ad-hoc pulls, register a scheduler task that calls the endpoints below and posts a summary (see the `email-check-task` recipe for the general pattern of a scheduled task that runs a fetch-and-summarize cycle).

---

## Config Snippet

```yaml
integrations:
  anthropic_analytics:
    enabled: true
    keychain_key: "credential-anthropic-analytics-key"
    base_url: "https://api.anthropic.com/v1/organizations/analytics"

scheduler:
  tasks:
    - name: anthropic-usage-digest
      cron: "0 8 * * 1"   # weekly, Monday 8am
      enabled: true
```

---

## Reference Code

### Auth — the three things people get wrong

```typescript
const ANALYTICS_BASE = "https://api.anthropic.com/v1/organizations/analytics";
// 1. The `/analytics/` segment is mandatory — omitting it hits a different, admin-only base.

async function getKey(): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("security", [
    "find-generic-password", "-s", "credential-anthropic-analytics-key", "-w",
  ]).toString().trim();
}

async function analyticsRequest(endpoint: string, params: Record<string, string>): Promise<any> {
  const key = await getKey();
  const qs = new URLSearchParams(params);
  const res = await fetch(`${ANALYTICS_BASE}/${endpoint}?${qs}`, {
    headers: {
      "x-api-key": key,
      // 2. Do NOT send `anthropic-version` here — that header belongs to the Messages
      //    API and this base does not expect it. Including it does not help and is
      //    not required.
    },
  });
  // 3. `starting_at` (below) must be ISO-8601 WITH a timezone offset — a bare date
  //    like "2026-01-01" is rejected by the *_report endpoints.
  if (!res.ok) throw new Error(`Analytics request failed: ${res.status} ${await res.text()}`);
  return res.json();
}
```

### Usage report — per-user, per-model, per-day

```typescript
interface UsageReportRow {
  product: string;         // e.g. "claude_code", "chat", "cowork", "claude_in_chrome"
  model: string;
  context_window: string;
  inference_geo: string;
  speed: string;
  starting_at: string;
  ending_at: string;
  actor: { type: string; email?: string; name?: string };
  uncached_input_tokens: number;
  cache_creation: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  requests: number;
}

async function getUsageReport(startingAt: string, opts: { groupBy?: string[]; bucketWidth?: '1m' | '1h' | '1d'; endingAt?: string } = {}) {
  const params: Record<string, string> = { starting_at: startingAt, limit: "1000" };
  if (opts.bucketWidth) {
    if (!opts.endingAt) throw new Error("ending_at is required when bucket_width is set");
    params.bucket_width = opts.bucketWidth;
    params.ending_at = opts.endingAt;
  }
  if (opts.groupBy) {
    // group_by is repeatable — build it manually since URLSearchParams dedupes on set()
    const qs = new URLSearchParams({ ...params });
    for (const field of opts.groupBy) qs.append("group_by[]", field);
    return analyticsRequestRaw(`user_usage_report?${qs}`);
  }
  return analyticsRequest("user_usage_report", params);
}
```

**Supported `group_by` fields**: `product`, `model`, `context_window`, `inference_geo`, `speed`, `rbac_group_id`, `claude_project_id`, `cost_type`, `token_type`. `actor` is not valid as a `group_by` — every row is already keyed by actor implicitly.

**The app/surface breakdown** (chat vs. Claude Code vs. cowork, etc.) is `group_by[]=product` — there is no standalone `apps` endpoint (see Gotchas).

### Cost report — same envelope, different fields

```typescript
interface CostReportRow {
  product: string;
  model: string;
  starting_at: string;
  ending_at: string;
  actor: { type: string; email?: string; name?: string };
  currency: string;
  amount: number;
  list_amount: number;
  cost_type: string;
  token_type: string;
  requests: number;
}

async function getCostReport(startingAt: string) {
  return analyticsRequest("user_cost_report", { starting_at: startingAt, limit: "1000" });
}
```

### Pagination

```typescript
async function pullAllPages(endpoint: string, startingAt: string): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { starting_at: startingAt, limit: "1000" };
    if (cursor) params.page = cursor;
    const page = await analyticsRequest(endpoint, params);
    rows.push(...page.data);
    cursor = page.has_more ? page.next_page : undefined;
  } while (cursor);

  return rows;
}
```

### Rolling ≤31-day windows into wider ranges

`bucket_width=1d` caps the queryable span at 31 days per request. For an 8-week digest, chunk into ≤31-day sub-windows and concatenate — there is no native weekly or monthly bucket, so weekly rollups are computed client-side from daily buckets.

```typescript
function chunkDateRange(start: Date, end: Date, maxDays = 31): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let cur = new Date(start);
  while (cur < end) {
    const chunkEnd = new Date(Math.min(cur.getTime() + maxDays * 86_400_000, end.getTime()));
    chunks.push({ start: new Date(cur), end: chunkEnd });
    cur = chunkEnd;
  }
  return chunks;
}
```

---

## Troubleshooting

**`authentication_error` on every request**

- Confirm the base URL includes `/analytics/` — `https://api.anthropic.com/v1/organizations/analytics/user_usage_report`, not `.../organizations/user_usage_report`
- Confirm you're sending `x-api-key`, not `Authorization: Bearer`
- Confirm you are **not** sending `anthropic-version` — some client wrappers add it by default for the Messages API; strip it for this base

**`400` complaining about `starting_at`**

- `starting_at` must be full ISO-8601 with a timezone offset (`2026-01-01T00:00:00Z`), not a bare date

**`400` on `bucket_width` requests**

- `ending_at` is required whenever `bucket_width` is set
- Valid `bucket_width` values are only `1m`, `1h`, `1d` — there is no weekly/monthly option
- `1d` bucketing caps the total range at 31 days per request — chunk wider ranges (see Reference Code)

**`users` or `skills` endpoints return an "not enabled for this organization" error**

- These need a date-range analytics feature that may not be turned on for every org — this is an org-level provisioning gate, not a bug in your request. Check with your Anthropic account team if you need it.

**`apps`, `chat`, `projects` return 404**

- These are not real endpoints at the Analytics base. The per-surface split (chat / Claude Code / cowork / etc.) is available via `group_by[]=product` on `user_usage_report` — use that instead of guessing at an `apps` endpoint.

**Today's numbers look incomplete**

- `data_refreshed_at` in the response envelope reflects data freshness — Analytics lags real time by roughly an hour, so the current partial day is expected to be undercounted until it catches up.

**This key doesn't work against Claude Code session-level analytics (commits, PRs, tool accept/reject rates)**

- That's a different, admin-only endpoint (`/v1/organizations/usage_report/claude_code`) that requires an `sk-ant-admin...` key, not the standard `sk-ant-api...` key this recipe uses. The two key types are not interchangeable — a standard org key will not reach admin-only usage/cost report endpoints, even though the URLs look similar.
