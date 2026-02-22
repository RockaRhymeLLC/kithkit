---
name: business-formation
description: LLC formation reference for Maryland — filing steps, costs, registered agents, liability protection, tax implications. Use when helping with business registration tasks.
user-invocable: false
---

# Business Formation — Maryland LLC

Reference guide for LLC formation in Maryland, distilled from comprehensive research. See the full research at `.claude/state/research/llc-registration-guide.md`.

## Quick Decision: Maryland Is the Right State

For a solo tech consultant operating from home in Maryland: **file in Maryland.** Delaware/Wyoming/Nevada would require registering as a foreign LLC in Maryland anyway ($300/year extra), plus the out-of-state filing fees. Net cost: roughly double for no benefit.

Only consider out-of-state if: holding company with no physical operations, non-US resident, or venture-funded startup needing Delaware case law.

## Filing Steps

### 1. Confirm Name Availability
- Search: [SDAT Business Entity Search](https://egov.maryland.gov/BusinessExpress/EntitySearch)
- Name must include "LLC", "L.L.C.", or "Limited Liability Company"
- Must be distinguishable from ALL existing Maryland entities
- Optional: reserve for 30 days ($25)

### 2. Choose Registered Agent
- **Be your own** (free) — but home address becomes public record on SDAT
- **Hire a service** ($49-125/year) — keeps address private
  - Budget: MarylandRegisteredAgent.com ($49/yr)
  - Recommended: Northwest ($125/yr) or Harbor Compliance ($99/yr)
- Recommendation: use a service unless address privacy truly doesn't matter

### 3. File Articles of Organization
- Online: [Maryland Business Express](https://egov.maryland.gov/businessexpress)
- Cost: **~$155** ($100 + $50 expedited + ~3% convenience fee)
- Processing: ~7 business days
- Need: LLC name, principal office address, registered agent info, business purpose, organizer signature

### 4. Get EIN
- Online: [IRS EIN Application](https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number)
- Free, instant
- Do this as soon as Articles are approved

### 5. Draft Operating Agreement
- Internal document, not filed with state
- Template is fine for single-member LLCs
- Banks will ask for this when opening an account

### 6. Open Business Bank Account
- Bring: Articles of Organization, EIN confirmation, operating agreement, personal ID
- **This is the most important post-formation step** — separate finances = LLC protection

### 7. Register for Maryland Taxes
- [Maryland Combined Registration](https://interactive.marylandtaxes.gov/webapps/comptrollercra/Entrance.aspx)
- Registers for Sales & Use Tax (needed for 3% tech tax) and withholding

### 8. Set Up Bookkeeping
- At minimum: spreadsheet tracking income, expenses, owner draws
- Track every business expense with a receipt

## Key Costs

| Item | Year 1 | Ongoing |
|------|--------|---------|
| Articles of Organization | ~$155 | — |
| Registered agent service | $49-125 | $49-125/yr |
| SDAT Annual Report | — | $300/yr |
| EIN | $0 | — |
| E&O insurance (optional) | $600-1,200 | $600-1,200/yr |
| **Total (minimum)** | **~$200-280** | **~$350-425/yr** |

## Maryland-Specific Gotchas

1. **$300/year even if dormant** — annual report fee due whether LLC earns money or not
2. **April 15 convergence** — annual report, federal taxes, state taxes all due same day
3. **Charter forfeiture** — miss annual report and SDAT can forfeit your charter ($600+ to reinstate)
4. **3% tech services tax** (effective July 2025) — applies to consulting, API development, code review under NAICS 5415. Collect from MD clients, remit quarterly.
5. **No general business license needed** — for most consulting/professional services

## Tax Treatment (Single-Member LLC)

- Pass-through to personal Form 1040, Schedule C
- Self-employment tax: 15.3% on net profit (12.4% SS + 2.9% Medicare)
- Maryland state: 2-5.75% + ~3.2% county income tax
- Quarterly estimated payments required if expecting to owe $1,000+
- Consider S-Corp election once net profit exceeds ~$40-50K/year (consult CPA)

## Liability Protection Essentials

**The #1 veil-piercing risk: commingling funds.** Keep business and personal finances completely separate.

Must-do:
- Dedicated business bank account (all revenue in, all expenses out)
- Document every personal↔business transfer
- Sign contracts as "Name, Member, Company LLC" — never just your name
- Keep a written operating agreement
- File all state reports on time

## Key Dates

| Date | What's Due |
|------|-----------|
| April 15 | SDAT Annual Report ($300) + Federal/MD tax returns + Q1 estimated taxes |
| June 15 | Q2 estimated taxes + Q2 Sales & Use Tax |
| Sept 15 | Q3 estimated taxes + Q3 Sales & Use Tax |
| Dec 15 | Q4 Sales & Use Tax |
| Jan 15 | Q4 estimated taxes |

## RockaRhyme LLC Status

- Name: available on SDAT (checked 2026-02-11) and USPTO (zero federal trademark results)
- MD Business Express account created (credentials in keychain: `credential-md-business-express-*`)
- Filing started: completed Steps 1-2 of 6 (Business Name passed, Business Info partially filled)
- Paused: Dave reviewing LLC research before continuing
- Site knowledge: see memory `20260211-2200-egov-maryland-business-express.md`

## References

- [`.claude/state/research/llc-registration-guide.md`](../../state/research/llc-registration-guide.md) — Full research: insurance comparisons, registered agent reviews, veil-piercing case studies, Delaware vs Maryland cost breakdown
