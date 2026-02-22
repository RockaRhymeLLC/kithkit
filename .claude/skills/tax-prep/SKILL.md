---
name: tax-prep
description: Prepare 2025 federal (1040) and Maryland state (502) tax returns from uploaded W-2s and tax documents. Married Filing Jointly, standard deduction.
argument-hint: [start|calculate|federal|state|summary]
---

# Tax Return Preparation — 2025

Prepare federal Form 1040 and Maryland Form 502 for tax year 2025 (filed in 2026). Designed for Married Filing Jointly with standard deduction, homeowners, two minor children.

**IMPORTANT DISCLAIMER**: This is a tax preparation *aid*, not professional tax advice. Always verify results against official IRS and Maryland Comptroller instructions. The user should compare BMO's output against their own preparation or a professional.

## Commands

- `start` — Begin the tax prep workflow. Prompt user to upload/provide W-2s and other documents.
- `calculate` — Run calculations on all provided documents and produce line-by-line output.
- `federal` — Show only the federal Form 1040 calculation.
- `state` — Show only the Maryland Form 502 calculation.
- `summary` — Show a high-level summary (income, deductions, tax, credits, refund/owed).

## Workflow

### Step 1: Gather Documents

Ask the user to provide (via photo, text, or file upload):

1. **W-2(s)** — All wage and tax statements for both spouses
2. **1099-INT** — Interest income (if any)
3. **1099-DIV** — Dividend income (if any)
4. **1099-G** — Government payments / state tax refunds (if any)
5. **1099-R** — Retirement distributions (if any)
6. **1098** — Mortgage interest statement (useful for itemize-vs-standard comparison)
7. **Property tax bills** — For SALT comparison
8. **Childcare expenses** — For dependent care credit
9. **Any other tax documents** — 1099-NEC, 1099-MISC, etc.

For each document, extract all relevant box values and record them.

### Step 2: Record Filing Profile

Confirm with user:
- Filing status: **Married Filing Jointly**
- Standard deduction: **$31,500** (2025 MFJ)
- Number of dependents: children's names, SSNs (user provides), ages, relationship
- Maryland county of residence (needed for local tax rate)
- Any special situations: self-employment, rental income, etc.

### Step 3: Calculate Federal Return (Form 1040)

Follow the line-by-line calculation below.

### Step 4: Calculate Maryland Return (Form 502)

Follow the line-by-line calculation below.

### Step 5: Present Results

Output a clear, formatted summary showing:
- Both forms line by line
- Total federal tax / refund
- Total MD state tax / refund
- Itemized vs. standard deduction comparison
- Any credits claimed

## Federal Form 1040 — Line-by-Line Reference

### 2025 Key Numbers (Post-OBBBA)

| Item | Amount |
|------|--------|
| Standard Deduction (MFJ) | $31,500 |
| Child Tax Credit (per child under 17) | $2,200 |
| Additional Child Tax Credit (refundable, per child) | up to $1,700 |
| CTC Phase-out threshold (MFJ) | $400,000 MAGI |
| SALT Cap (MFJ, MAGI < $500K) | $40,000 |
| EITC max (MFJ, 2 children) | $7,152 (AGI < $64,430) |

### 2025 Tax Brackets (MFJ)

| Rate | Taxable Income Range |
|------|---------------------|
| 10% | $0 – $23,850 |
| 12% | $23,851 – $96,950 |
| 22% | $96,951 – $206,700 |
| 24% | $206,701 – $394,600 |
| 32% | $394,601 – $501,050 |
| 35% | $501,051 – $751,600 |
| 37% | Over $751,600 |

### Income (Lines 1–9)

| Line | Description | Source |
|------|-------------|--------|
| 1a | Wages, salaries, tips | Sum of all W-2 Box 1 |
| 1b–1h | Other earned income | As applicable |
| 1z | Total wages | Sum of 1a through 1h |
| 2a | Tax-exempt interest | 1099-INT Box 8 |
| 2b | Taxable interest | 1099-INT Box 1 |
| 3a | Qualified dividends | 1099-DIV Box 1b |
| 3b | Ordinary dividends | 1099-DIV Box 1a |
| 4a/4b | IRA distributions | 1099-R (as applicable) |
| 5a/5b | Pensions and annuities | 1099-R (as applicable) |
| 6a/6b | Social Security benefits | SSA-1099 |
| 7a | Capital gain or loss | Schedule D or 1099-DIV Box 2a |
| 8 | Additional income | Schedule 1, Line 10 |
| **9** | **Total income** | Sum of 1z, 2b, 3b, 4b, 5b, 6b, 7a, 8 |

### Adjustments & Deductions (Lines 10–15)

| Line | Description | Notes |
|------|-------------|-------|
| 10 | Adjustments to income | Schedule 1, Line 26 (educator expenses, HSA, IRA, student loan interest, etc.) |
| 11a | Adjusted Gross Income (AGI) | Line 9 – Line 10 |
| 12e | Standard deduction | **$31,500** for MFJ (or itemized from Schedule A if higher) |
| 13a | Qualified business income deduction | Form 8995 (if applicable) |
| 13b | Additional deductions (Schedule 1-A) | NEW for 2025: tips, overtime, car loan interest, senior deductions |
| 14 | Total deductions | 12e + 13a + 13b |
| **15** | **Taxable income** | Line 11a – Line 14 (min $0) |

### Schedule 1-A Deductions (NEW for 2025)

| Deduction | Max (MFJ) | Phase-out Starts | Notes |
|-----------|-----------|-----------------|-------|
| Tips | $25,000 | $300,000 MAGI | Cash and reported tips |
| Overtime | $25,000 | $300,000 MAGI | Overtime wages |
| Car loan interest | $10,000 | $200,000 MAGI | Interest on auto loans |
| Senior (65+) | $12,000 ($6K each) | $150,000 MAGI | Additional for age 65+ |

These are **in addition to** the standard deduction.

### Tax Calculation (Line 16)

Apply the 2025 MFJ brackets to Line 15 (taxable income):

```
Tax = ($23,850 × 10%) + (min(taxable - $23,850, $73,100) × 12%) + ...
```

For qualified dividends and long-term capital gains, use the preferential rates:
- 0% if taxable income ≤ $96,700 (MFJ)
- 15% if taxable income ≤ $600,050
- 20% above $600,050

### Credits (Lines 17–24)

| Line | Description | Notes |
|------|-------------|-------|
| 19 | Child tax credit | $2,200 per qualifying child (Schedule 8812). Non-refundable portion reduces tax to $0. |
| 21 | Other credits (Schedule 3) | Foreign tax credit, education credits, etc. |
| 22 | Total credits | Sum of 19–21 |
| 23 | Tax minus credits | Line 16 – Line 22 (min $0) |
| 24 | Total tax | Line 23 + other taxes (Schedule 2) |

### Payments (Lines 25–34)

| Line | Description | Source |
|------|-------------|--------|
| 25a | Federal tax withheld (W-2s) | Sum of all W-2 Box 2 |
| 25b | Tax withheld from 1099s | 1099 Box showing federal withholding |
| 25d | Total federal tax withheld | 25a + 25b + 25c |
| 27 | Earned income credit | If AGI < $64,430 (MFJ, 2 children) |
| 28 | Additional child tax credit | Refundable portion from Schedule 8812 (up to $1,700/child) |
| 33 | Other payments | Estimated tax payments, etc. |
| **34** | **Total payments** | Sum of lines 25d through 33 |

### Result (Lines 35–37)

| Line | Description | Calculation |
|------|-------------|-------------|
| **35** | **Overpayment (refund)** | Line 34 – Line 24 (if positive) |
| **37** | **Amount you owe** | Line 24 – Line 34 (if positive) |

### Schedule 8812 — Child Tax Credit

1. Number of qualifying children (under 17): ____
2. Multiply by $2,200 = potential credit
3. Check MAGI against $400,000 phase-out (MFJ) — reduce by $50 per $1,000 over
4. Non-refundable portion: reduces tax liability (Line 16) to $0
5. Refundable ACTC: 15% of earned income over $2,500, up to $1,700 per child
6. Line 19 gets the non-refundable portion; Line 28 gets the refundable ACTC

### Itemized vs. Standard Comparison

Even though filing with standard deduction, always run the comparison:

| Itemized Component | Source | Amount |
|-------------------|--------|--------|
| Mortgage interest | 1098 Box 1 | $ |
| State/local income tax | W-2 Box 17 + property taxes | $ |
| SALT cap (2025) | min(above, $40,000) | $ |
| Charitable contributions | Receipts | $ |
| **Total itemized** | | $ |
| **Standard deduction** | | **$31,500** |
| **Better option** | | (higher amount wins) |

## Maryland Form 502 — Line-by-Line Reference

### 2025 Key Numbers

| Item | Amount |
|------|--------|
| Standard Deduction (MFJ) | **$6,700** (flat, new for 2025) |
| Personal Exemption | $3,200 per exemption |
| Dependent Exemption | $3,200 per dependent |
| Capital Gains Surtax | 2% on net gains if FAGI > $350,000 |
| Itemized Deduction Phaseout | 7.5% of AGI over $200,000 |

### 2025 MD Tax Brackets (MFJ / HoH / QSS)

| Rate | Taxable Income Range | Cumulative Tax |
|------|---------------------|----------------|
| 2.00% | $0 – $1,000 | $20 |
| 3.00% | $1,001 – $2,000 | $50 |
| 4.00% | $2,001 – $3,000 | $90 |
| 4.75% | $3,001 – $150,000 | $7,072.50 |
| 5.00% | $150,001 – $175,000 | $8,322.50 |
| 5.25% | $175,001 – $225,000 | $10,947.50 |
| 5.50% | $225,001 – $300,000 | $15,072.50 |
| 5.75% | $300,001 – $600,000 | $32,322.50 |
| 6.25% | $600,001 – $1,200,000 | $69,822.50 |
| 6.50% | Over $1,200,000 | — |

*Note: 6.25% and 6.50% brackets are NEW for 2025.*

### Local (County) Tax Rates (2025)

The county "piggyback" tax is applied to MD taxable income. Max rate increased to 3.3% for 2025.

County rates for 2025 (verify against resident booklet):

| County | Rate | Notes |
|--------|------|-------|
| Allegany | 3.03% | |
| Anne Arundel | 2.70–3.20% | **Graduated** (see below) |
| Baltimore City | 3.20% | |
| Baltimore County | 3.20% | |
| Calvert | 3.20% | |
| Caroline | 3.20% | |
| Carroll | 3.03% | |
| Cecil | 2.74% | |
| Charles | 3.03% | |
| Dorchester | **3.30%** | Highest — uses new 2025 max |
| Frederick | 2.25–3.20% | **Graduated** (see below) |
| Garrett | 2.65% | |
| Harford | 3.06% | |
| Howard | 3.20% | |
| Kent | 3.20% | |
| Montgomery | 3.20% | |
| Prince George's | 3.20% | |
| Queen Anne's | 3.20% | |
| St. Mary's | 3.20% | |
| Somerset | 3.20% | |
| Talbot | 2.40% | |
| Washington | 2.95% | |
| Wicomico | 3.20% | |
| Worcester | 2.25% | Lowest |

**Anne Arundel graduated rates (MFJ)**: 2.70% up to $75K, 2.94% $75K–$480K, 3.20% over $480K
**Frederick graduated rates (MFJ)**: 2.25% up to $25K, 2.75% $25K–$100K, 2.96% $100K–$250K, 3.20% over $250K

### Form 502 Line Mapping

| Line | Description | Source |
|------|-------------|--------|
| 1 | Federal AGI | Form 1040, Line 11a |
| 2 | Wages (Maryland) | W-2 Box 16 (or Box 1 if no state wages listed) |
| **Additions (Lines 3-6)** | | |
| 3-6 | State additions to income | (e.g., state tax refund deducted federally, etc.) |
| **Subtractions (Lines 7-13)** | | |
| 7-13 | State subtractions | (e.g., Social Security income, military pay, etc.) |
| **Deduction & Exemptions** | | |
| 17 | Standard deduction | **$6,700** (MFJ, flat for 2025) |
| 18 | Net income | After deductions |
| 19 | Exemption amount | $3,200 × number of exemptions |
| 20 | Taxable income | Line 18 – Line 19 |
| **Tax** | | |
| 21 | Maryland state tax | Apply MD brackets to Line 20 |
| 22 | Local (county) tax | Line 20 × county rate |
| **Credits** | | |
| 28-34 | Tax credits | From Form 502CR (see below) |
| **Payments** | | |
| 40 | MD tax withheld | Sum of W-2 Box 17 |
| 43 | Total payments | |
| **Result** | | |
| 46 | Overpayment (refund) | If payments > tax |
| 50 | Balance due | If tax > payments |

### Form 502B — Dependents

List all dependents with:
- Name, SSN, relationship, date of birth
- Number of months lived in Maryland
- Health coverage information

### Form 502CR — Credits

Relevant credits for this profile:
- **Part A**: Income tax paid to other states (if applicable)
- **Part M**: Child Tax Credit ($500/child) — only if FAGI ≤ $24,000 (phase-down from $15,000)
- **Part AA**: Total credits → carries to Form 502

### Exemptions

For MFJ with 2 children:
- You: 1 exemption ($3,200)
- Spouse: 1 exemption ($3,200)
- Child 1: 1 exemption ($3,200)
- Child 2: 1 exemption ($3,200)
- **Total: 4 exemptions × $3,200 = $12,800**

**Exemption phaseout (based on Federal AGI, MFJ):**

| Federal AGI (MFJ) | Exemption per Person |
|-------------------|---------------------|
| Up to $150,000 | $3,200 (full) |
| $150,001 – $175,000 | $1,600 |
| $175,001 – $200,000 | $800 |
| Over $200,000 | $0 |

Additional $1,000 exemption per spouse age 65+ or blind.

### Maryland EITC

- **50% of federal EITC** for filers with dependents
- **100% of federal EITC** for single filers without dependents
- Refundable
- ITIN filers eligible for MD EITC even if ineligible for federal

## Output Format

### Summary View
```
═══════════════════════════════════════════════════
  2025 TAX RETURN SUMMARY — Married Filing Jointly
═══════════════════════════════════════════════════

INCOME
  Wages (W-2s)               $XXX,XXX
  Interest                   $X,XXX
  Dividends                  $X,XXX
  Other income               $X,XXX
  ─────────────────────────────────────
  Total Income               $XXX,XXX
  Adjustments                ($X,XXX)
  ADJUSTED GROSS INCOME      $XXX,XXX

FEDERAL (Form 1040)
  Standard Deduction          ($31,500)
  Additional Deductions       ($X,XXX)
  Taxable Income              $XXX,XXX
  Federal Tax                 $XX,XXX
  Child Tax Credit            ($4,400)
  Other Credits               ($X,XXX)
  ─────────────────────────────────────
  Total Federal Tax           $XX,XXX
  Federal Withheld            $XX,XXX
  ACTC (refundable)           $X,XXX
  ═════════════════════════════════════
  FEDERAL REFUND / OWED       $X,XXX

MARYLAND (Form 502)
  MD Taxable Income           $XXX,XXX
  State Tax                   $X,XXX
  Local Tax (XX County)       $X,XXX
  Credits                     ($XXX)
  ─────────────────────────────────────
  Total MD Tax                $X,XXX
  MD Withheld                 $X,XXX
  ═════════════════════════════════════
  MD REFUND / OWED            $X,XXX

DEDUCTION COMPARISON
  Standard Deduction:         $31,500
  Itemized would be:          $XX,XXX
  → Standard deduction is better / Itemized is better

═══════════════════════════════════════════════════
```

### Detailed View

Show every line number with its value and source document reference. Use the same format as the official forms so the user can directly transfer values.

## W-2 Quick Reference

| W-2 Box | Description | Federal Line | MD Line |
|---------|-------------|-------------|---------|
| 1 | Wages | 1040 Line 1a | 502 Line 1 (via FAGI) |
| 2 | Federal tax withheld | 1040 Line 25a | — |
| 3 | Social Security wages | (SS tax calc) | — |
| 4 | Social Security tax withheld | (if excess, Sch 3) | — |
| 5 | Medicare wages | (Medicare calc) | — |
| 6 | Medicare tax withheld | (if excess, Sch 3) | — |
| 12 | Codes (401k, HSA, etc.) | Various | — |
| 16 | State wages | — | 502 Line 2 |
| 17 | State tax withheld | Sch A Line 5a | 502 Line 40 |
| 18 | Local wages | — | (local tax calc) |
| 19 | Local tax withheld | — | 502 Line 40 |

## Reference Documents

Downloaded forms are in `.claude/skills/tax-prep/forms/`:
- `f1040.pdf` — Federal Form 1040
- `f1040-instructions.pdf` — Form 1040 Instructions
- `schedule-8812.pdf` — Child Tax Credit (Schedule 8812)
- `md-502.pdf` — Maryland Form 502
- `md-502b.pdf` — Maryland Form 502B (Dependents)
- `md-502cr.pdf` — Maryland Form 502CR (Credits)
- `md-resident-booklet.pdf` — MD Resident Tax Booklet (Instructions)

## Important Notes

1. **This is not tax advice.** BMO is preparing a draft for comparison purposes only.
2. **Verify all numbers** against official IRS and MD Comptroller instructions.
3. **Standard vs. itemized**: Always run the comparison even if user says standard deduction.
4. **2025 changes are significant** — OBBBA changed standard deduction, CTC, SALT cap, and added Schedule 1-A. Maryland also changed to flat standard deduction, added capital gains surtax, and raised county tax cap.
5. **Round to whole dollars** on all forms (drop cents).
6. **When in doubt**, reference the downloaded instructions PDFs.

## Sources

- IRS Form 1040 Instructions (2025)
- IRS Schedule 8812 Instructions (2025)
- Maryland Comptroller 2025 Resident Booklet
- One, Big, Beautiful Bill Act (OBBBA) provisions
- Maryland HB 352 (2025 legislative session)
