---
name: lemon-squeezy-tos
description: Lemon Squeezy Terms of Service compliance — product rules, prohibited content, fees, payout rules, store approval requirements. Use before listing products or managing the store.
user-invocable: false
---

# Lemon Squeezy TOS Compliance

Reference skill for operating within Lemon Squeezy's Terms of Service. Loaded automatically when managing products, pricing, or store operations.

**Why this exists**: Our application was previously denied. We need to understand exactly what's required for approval and ongoing compliance to avoid store suspension or frozen payouts.

## Hard Rules (Violations = Immediate Suspension)

### Prohibited Products (TOS 3.4(a) + Appendix A)
1. **Sexually-oriented or pornographic content** (including NSFW chatbots)
2. **Illegal/age-restricted products** (drugs, alcohol, tobacco, vaping)
3. **Counterfeit goods / unlicensed content**
4. **PLR (Private Label Rights) products**
5. **MRR (Master Resell Rights) products**
6. **NFT and crypto-related products**
7. **Spyware or parental control apps**
8. **Physical goods of any kind**
9. **IPTV services**

### Prohibited Business Models
1. **Services** (marketing, design, consulting, support hours) — can only sell digital products
2. **Marketplaces** reselling others' products
3. **MLM / pyramid schemes / get-rich-quick**
4. **Donations/charity** where no product exists
5. **Business-in-a-box** schemes

### Instant Ban Triggers
1. **Obscuring product nature** — being deceptive about what you're selling
2. **Fraud evidence** — triggers payout freeze + refunds without warning
3. **Selling anything on Stripe's restricted list** (LS is built on Stripe)

## Store Approval Requirements

Our previous denial cited **lacking a website and social media presence**. For reapplication:

1. **Active website** (your domain) with clear product descriptions
2. **Social media presence** (legitimacy signals)
3. **Products must be digital goods** fulfillable by LS (code, templates, tools)
4. **Clear product descriptions** — don't obscure what you're selling
5. **Valid domain ownership** — LS verifies this
6. **Government ID** for KYC (the account holder handles this)
7. **Timeline**: Usually 2-3 business days for review

## Fees

### Transaction Fees
| Component | Fee |
|-----------|-----|
| Base | 5% + $0.50 per transaction |
| International buyer | +1.5% |
| PayPal payment | +1.5% |
| Subscriptions | +0.5% |
| Abandoned cart recovery | +5% on recovered sales |

### Impact on Our Price Range
| Price | Platform Fee | Net |
|-------|-------------|-----|
| $9 | $0.95 (10.6%) | $8.05 |
| $19 | $1.45 (7.6%) | $17.55 |
| $29 | $1.95 (6.7%) | $27.05 |

### Payout Rules
- Created: **1st and 15th** of each month
- Distributed: **14th and 28th**
- **13-day hold** on all sales before payout eligibility
- **$50 minimum payout** — below this, balance rolls forward
- US bank payouts: free; PayPal: $0.50 flat fee
- **W-9 required** — payouts disabled without it

## API Rate Limits

| API | Limit |
|-----|-------|
| Main API | 300 requests/minute |
| License API | 60 requests/minute |
| Exceeded | HTTP 429 |

Monitor via `X-Ratelimit-Limit` and `X-Ratelimit-Remaining` headers.

### Webhooks
- Retry: 3 times with exponential backoff (5s, 25s, 125s), then marked failed
- Security: `X-Signature` HMAC header, `X-Event-Name` header
- Test: Can simulate events from dashboard

## Account Requirements

- **Administrative User**: One primary human (not AI) with full access, up to two backups
- **Identity verification**: Government ID, may require periodic re-verification
- **Re-verification failure**: Pauses payouts AND pay-ins, disables account
- **W-9** (US) or W-8 (international) — mandatory for payouts
- **Audit rights**: LS can audit with 24 hours written notice (TOS 3.4)

## AI Agent Store Management

**No explicit prohibition** on AI agents managing the store via API. LS supports automation through API, Pipedream, Make.com, and official SDKs. The account holder must be human, but API operations by automated systems are an intended use case.

## Our Products

- **Type**: Claude Code skills bundles ($9-$29) — digital products, explicitly supported
- **IP**: Original code created by the assistant — no PLR/MRR issues
- **Never bundle services** (setup help, consulting, support hours) — prohibited

## Chargebacks

- **$15 dispute fee** per chargeback, plus the refunded amount
- Excessive chargebacks trigger account suspension
- **Recommendation**: Offer generous refund policy to avoid chargebacks (cheaper than fighting them)

## Key TOS References

| Section | Topic |
|---------|-------|
| TOS 1.3-1.5 | Administrative User requirements |
| TOS 3.4(a) + Appendix A | Prohibited products |
| TOS 3.4 | Audit rights (24hr notice) |
| TOS 6.1 | Merchant obligations |
| TOS 6.1(j) | No scraping/reverse engineering |
| TOS 7.1 | Fees (non-refundable) |
| TOS 7.4 | Non-payment suspension (10-day grace) |
| TOS 9.1(f) | IP rights warranty |
| TOS 11.3 | Termination for cause (15-day cure, 5-day for confidentiality) |
