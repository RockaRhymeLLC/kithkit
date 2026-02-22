---
name: supabase-tos
description: Supabase Terms of Service compliance — free tier limits, pausing rules, RLS requirements, rate limits. Use before Supabase operations or database changes.
user-invocable: false
---

# Supabase TOS Compliance

Reference skill for operating within Supabase's Terms of Service. Loaded automatically when performing Supabase database operations, migrations, or management.

**Why this exists**: PlayPlan runs on Supabase Free Tier. Free projects pause after 7 days of inactivity and auto-delete after 90 days paused. These rules keep the project alive and compliant.

## Hard Rules (Violations = Suspension)

1. **No reverse engineering** or creating derivative works of the service (TOS 2(c))
2. **No competitive analysis** — cannot use Supabase to develop competing services
3. **No bypassing security** — no unauthorized access or credential bypassing
4. **No CSAM, fraud, malware, spam, or IP infringement** (AUP)
5. **No DDoS, flooding, or deliberate overloading** of systems
6. **No open proxies, mail relays, or recursive DNS** on Supabase infrastructure
7. **RLS is effectively mandatory** — tables without it are fully accessible via the public anon key

## Critical: 7-Day Pause Rule (Free Tier)

Free projects **pause after 7 days of inactivity**. "Activity" = actual database requests (REST API, direct connections). Dashboard visits don't count.

- **When paused**: Project inaccessible, data preserved
- **After 90 days paused**: Cannot restore from dashboard — data effectively gone
- **Prevention**: Schedule a lightweight query (`SELECT 1`) at least twice per week

## Free Tier Quotas (Hard Caps — No Overages)

| Resource | Limit |
|----------|-------|
| Projects | 2 |
| Database size | 500 MB (data + indexes) |
| File storage | 1 GB |
| Database egress | 5 GB/month |
| Storage egress | 2 GB/month |
| Auth MAU | 50,000 |
| Edge Function invocations | 500,000/month |
| Realtime connections | 200 concurrent |
| DB connections (direct) | 60 |
| Connection pooler clients | 200 |

**When 500 MB hit**: Database goes **read-only** (INSERTs blocked). Indexes count toward the limit.

## Rate Limits

### Auth API

| Endpoint | Limit |
|----------|-------|
| Email sending (signup/recover) | 2/hour without custom SMTP |
| OTP generation | 30/hour |
| Token refresh | 1,800/hour per IP |
| Verification | 360/hour per IP |
| Anonymous sign-ins | 30/hour per IP |

### Management API

- **120 requests/minute** baseline
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### REST API (PostgREST)

- No hard rate limits at PostgREST level
- ~1,200 reads/sec, ~1,000 inserts/sec capacity on free tier
- Must implement own rate limiting if needed

## Our Setup (PlayPlan)

- **Project**: Your Supabase project ref (in Keychain)
- **Account**: Your Supabase account email
- **Plan**: Free tier
- **DB**: PostgreSQL with RLS enabled
- **Credentials**: In Keychain as `credential-supabase-*`
- **Direct DB**: `/opt/homebrew/opt/libpq/bin/psql` with connection string

## Pro Upgrade Triggers

Upgrade to Pro ($25/month) when any of these hit:
- Database approaching 400 MB (80% of limit)
- More than a handful of concurrent users
- Need more than 2 auth emails/hour
- Need reliability (no pausing)
- Need automated backups

## Best Practices

1. **Set up keep-alive cron** immediately — prevents 7-day pause
2. **Use anon key** for client-side operations (RLS protects data)
3. **Use service role key** only server-side (never in clients)
4. **Use connection pooler** (port 6543) from apps, not direct connections
5. **Monitor database size** including indexes
6. **Set up custom SMTP** to lift 2 email/hour auth limit
7. **Run VACUUM** periodically to reclaim space from deleted rows
8. **Parameterized queries always** — prevent SQL injection

## Data Portability

- TOS Section 8(b): "Customer may export the Customer Data at any time"
- `supabase db dump` for schema and data
- Standard PostgreSQL — no vendor lock-in
- Auth users need separate export (in `auth` schema)

## Key TOS References

| Section | Topic |
|---------|-------|
| TOS 2(a) | Non-exclusive, non-transferable license |
| TOS 2(c) | No reverse engineering, competitive use, bypassing security |
| TOS 2(e) | Suspension rights (threats, fraud, disruption) |
| TOS 3(a) | Account holder liable for all uses including automated |
| TOS 8(b) | Data ownership + right to export |
| TOS 12(b) | Termination: 10 days for non-payment, 30 days for breach |
| AUP | All prohibited uses, content restrictions |
