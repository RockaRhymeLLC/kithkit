---
name: azure-tos
description: Azure Terms of Service compliance — rate limits, quotas, cost protection, and auto-delete rules for Container Apps and ACR. Use before Azure deployments or infrastructure changes.
user-invocable: false
---

# Azure TOS Compliance

Reference skill for operating within Azure's Terms of Service. Loaded automatically when performing Azure deployments or infrastructure changes.

**Why this exists**: We run a 30-service API gateway on Azure Container Apps with scale-to-zero. These rules prevent accidental cost spikes, quota violations, or account suspension.

## Hard Rules (Violations = Suspension)

1. **No cryptocurrency mining** without prior written approval from Microsoft
2. **No circumventing billing meters** — designed metering mechanisms cannot be bypassed
3. **No reselling Azure services** — Subscription Agreement Section 1.g(i)
4. **No high-risk use** where service failure could cause death/serious injury (without provisions)
5. **No reverse engineering** or working around technical limitations
6. **No evading Metaprompt restrictions** on AI services
7. **No spam, malware, or unauthorized access** — standard AUP

## Suspension & Termination

- Microsoft "suspends only to the extent reasonably necessary" with "reasonable notice" unless immediate action required
- **60-day rule**: After 60 days of unresolved suspension, Microsoft may terminate and **delete all Customer Data** (Section 3.c)
- Common triggers: crypto mining, payment failure, DDoS originating from your resources, AUP violations

## Rate Limits & Quotas

### ARM API Throttling (Token Bucket)

| Scope | Operation | Bucket Size | Refill/sec |
|-------|-----------|-------------|------------|
| Per service principal | Reads | 250 | 25 |
| Per service principal | Writes | 200 | 10 |
| Per service principal | Deletes | 200 | 10 |

Global subscription limits = 15x per-SP limits. Exceeding returns **HTTP 429** with `Retry-After` header.

Track via: `x-ms-ratelimit-remaining-subscription-reads` (and `-writes`, `-deletes`).

### ACR Basic Tier

| Resource | Limit |
|----------|-------|
| Included storage | 10 GiB |
| Max storage | 40 TiB |
| Max image layer | 200 GiB |
| Webhooks | 2 |
| Cost | ~$5/month |

### Container Apps Free Grants (per subscription/month)

| Resource | Free Amount | Our Equivalent |
|----------|-------------|----------------|
| vCPU-seconds | 180,000 | ~200 hrs at 0.25 vCPU |
| GiB-seconds | 360,000 | ~200 hrs at 0.5 GiB |
| HTTP requests | 2,000,000 | Plenty for our usage |

### 90-Day Auto-Delete Rule

Container Apps environments are **automatically deleted** if idle for 90+ days. "Idle" means no active container apps or jobs running. **Keep at least one app deployed** to avoid this.

## Our Setup

- **Container Apps**: Your Container Apps environment in your resource group, 0.25 vCPU / 0.5 GiB, scale-to-zero
- **ACR**: Your ACR instance (Basic tier)
- **Cost**: ~$5/mo idle (ACR), ~$24/mo if always-on
- **Scale-to-zero is explicitly supported** — not abuse. Zero replicas = zero compute cost.

## Cost Protection

- **No spending limit** on pay-as-you-go subscriptions (only free/trial accounts have one)
- **Set budget alerts** — Azure Budgets can email/webhook at 50/75/90/100% thresholds
- Alerts trigger within 1 hour of threshold breach
- Can auto-trigger action groups (scale-down, delete resources)

### Recommended Budget

```bash
az consumption budget create \
  --amount 10 \
  --budget-name "assistant-monthly" \
  --category Cost \
  --time-grain Monthly \
  --resource-group your-resource-group
```

## Best Practices

1. **Use a dedicated service principal** with Contributor role scoped to your resource group only
2. **Implement exponential backoff** on all `az` CLI and API calls for 429 responses
3. **Keep at least one container app deployed** to avoid 90-day environment auto-delete
4. **Clean up old ACR images** periodically — Basic tier includes only 10 GiB
5. **Never store Azure credentials in code** — use GitHub Actions secrets
6. **Monitor ARM API usage** via response headers during CI/CD

## AI Agent Management

**No prohibition** on AI agents managing Azure resources. Service principals and automated deployment are core Azure features. The account holder bears responsibility for all actions (Section 1.c).

## Key TOS References

| Section | Topic |
|---------|-------|
| Subscription Agreement 1.b | No circumventing billing, no reverse engineering |
| Subscription Agreement 1.c | Account holder responsible for end user compliance |
| Subscription Agreement 1.g(i) | No reselling |
| Subscription Agreement 3.c | 60-day suspension → termination + data deletion |
| Acceptable Use Policy | Crypto mining ban, spam, unauthorized access |
