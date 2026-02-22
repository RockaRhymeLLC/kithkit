---
name: cloudflare-tos
description: Cloudflare Terms of Service compliance — API rate limits, DNS quotas, tunnel rules, CDN content restrictions. Use before Cloudflare DNS or tunnel changes.
user-invocable: false
---

# Cloudflare TOS Compliance

Reference skill for operating within Cloudflare's Terms of Service. Loaded automatically when performing DNS changes, tunnel management, or API operations.

**Why this exists**: When using Cloudflare for DNS, Tunnel, and SSL for your domain, these rules prevent service disruption.

## Hard Rules (Violations = Suspension)

1. **No VPN/proxy service**: Cannot use Cloudflare to provide a VPN or similar proxy service to third parties (Section 2.2.1(j))
2. **No CDN abuse**: Free/Pro plans cannot serve "disproportionate" video/audio/large files from external origins — API/HTML traffic only
3. **No credit card processing on Free plan** (Section 2.2.1(h))
4. **No multiple accounts via automation** (Section 2.2.1(e))
5. **No traffic manipulation** or undue burden on Cloudflare networks
6. **No CSAM, malware, phishing, spam, illegal content** (Section 2.7)
7. **Cloudflare can terminate at any time for any reason** (Section 8)

## Rate Limits

### API

| Limit | Value |
|-------|-------|
| Global rate limit | 1,200 requests / 5 minutes |
| Per-IP limit | 200 requests / second |
| Exceeded response | HTTP 429 (blocks all calls for remaining window) |

Rate limit headers: `Ratelimit`, `Ratelimit-Policy`, `retry-after` (on 429 only).

### DNS (Free Plan)

| Resource | Limit |
|----------|-------|
| Records per zone | 200 (zones after 2024-09-01) or 1,000 (older zones) |
| Our current records | 33 |
| Propagation | ~5 minutes globally |

### Tunnel (Free Zero Trust Plan)

| Resource | Limit |
|----------|-------|
| Tunnels per account | 1,000 |
| Replicas per tunnel | 25 |
| Bandwidth | No documented limit |
| Connections | No limit |

### Other Free Plan Limits

| Resource | Limit |
|----------|-------|
| API tokens per user | 50 |
| API tokens per account | 500 |
| Page Rules | 3 |
| Universal SSL | Covers `*.yourdomain.com` (one level only) |
| Custom cert upload | Not available (requires Business, $200/mo) |

## Our Setup

- **Zone**: Your domain (zone ID in Keychain or environment)
- **DNS**: CNAME records — some to Azure, some to Tunnel
- **Tunnel**: Your tunnel ID (stored in config/environment)
- **SSL**: Universal SSL on edge, origin cert on Azure
- **API auth**: Bearer token (`credential-cloudflare-api-token` in Keychain)

## CDN Content Rules

Our proxied subdomains serve API responses and web pages — this is compliant. If any service starts serving bulk media:

- **Safe**: API responses, HTML, JSON, small images in web pages
- **Risky**: Video streaming, large file downloads, audio streaming, bulk image galleries
- **Fix**: For media-heavy services, use Cloudflare R2 or set DNS to DNS-only (no proxy)

## Best Practices

1. **Use scoped API tokens** (not Global API Key) — we already do this
2. **Least privilege**: Token should have only `Zone:DNS:Edit` for your domain
3. **Batch DNS changes** when possible to reduce API calls
4. **Implement 429 backoff** with `retry-after` header respect
5. **Keep cloudflared updated** for tunnel compatibility
6. **DKIM CNAMEs must be DNS-only** (unproxied) or email auth breaks

## Key TOS References

| Section | Topic |
|---------|-------|
| 2.2.1(b) | No traffic manipulation or undue burden |
| 2.2.1(e) | No automated account creation or scraping |
| 2.2.1(h) | No credit card processing on Free tier |
| 2.2.1(j) | No VPN/proxy service for others |
| 2.3 | You're responsible for all API token activity |
| 2.7 | Prohibited content (CSAM, malware, phishing, spam) |
| 8 | Cloudflare can terminate at any time |
| SST: CDN | No disproportionate large files from external origins |
