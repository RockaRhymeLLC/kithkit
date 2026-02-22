---
name: npm-tos
description: npm Terms of Service compliance — publishing rules, rate limits, token management, unpublish policy. Use before npm publish operations or package management.
user-invocable: false
---

# npm TOS Compliance

Reference skill for operating within npm's Terms of Service. Loaded automatically when publishing packages, managing tokens, or performing npm registry operations.

**Why this exists**: When publishing CC4Me packages to npm, these rules ensure packages don't get removed and accounts don't get banned.

## Hard Rules (Violations = Package Deletion or Ban)

### Prohibited Content (package deleted immediately)
1. **Malware**: No viruses, worms, rootkits, backdoors, spyware
2. **Spam packages**: No blank/placeholder packages
3. **Ad packages**: No packages displaying ads at runtime, install, or other stages
4. **IP violations**: No code infringing copyright, trademarks, or violating public licenses
5. **Non-functional packages**: No standalone image/video/text files as packages
6. **Name squatting**: Publishing packages solely to reserve names

### Prohibited Behavior (account banned)
1. **Name trading**: Buying/selling usernames or package names — **permanent ban**
2. **Impersonation**: Cannot impersonate npm or other entities
3. **Website scraping**: Cannot crawl npmjs.com (but Public API/registry replication IS permitted)
4. **Code of Conduct violations**: Harassment, trolling, hate speech — immediate expulsion

### The 5 Million Request Limit
- **Hard ceiling**: 5 million requests/month per individual/org/affiliated group
- Exceeding = "excessive, unacceptable use" per Open Source Terms
- npm contacts you first to help reduce usage; if unresolved, rate limiting applied

## Token Management (Post-2025 Security Changes)

All classic tokens were **permanently revoked** December 9, 2025. Only granular tokens exist now.

| Rule | Detail |
|------|--------|
| Token type | Granular access tokens only |
| Write token lifetime | **90-day maximum** — must rotate |
| 2FA | Enforced by default on all write-permission tokens |
| CI/CD bypass | "Bypass 2FA" checkbox available for CI tokens |
| Recommended approach | **Trusted Publishing (OIDC)** — no tokens needed |

### Trusted Publishing (Recommended)
- OIDC-based: GitHub Actions generates short-lived identity token per publish
- No npm tokens stored in secrets — eliminates token leak risk
- Requires: npm CLI v11.5.1+, `id-token: write` permission on GH Actions job
- `repository.url` in package.json must match the GitHub repo

## Publishing Rules

### Package Names
- Must publish with real functionality — no reserving names
- Unscoped packages (no `@org/` prefix) are simpler for small projects

### Unpublish Policy
- **Within 72 hours**: Can unpublish if no dependents
- **After 72 hours**: ALL three conditions required:
  1. No dependents
  2. < 300 downloads in past week
  3. Single owner
- **Version numbers are permanent** — cannot reuse after unpublish
- **Prefer `npm deprecate`** over unpublish for bad releases

### Size Limits
- No official max tarball size (practical limit ~200-300 MB)
- `package.json` limited to 384 KB
- Unlimited public packages, versions, and downloads on free tier

## Pre-Publish Checklist

1. **Check files**: `npm pack --dry-run` — ensure no secrets, .env, or unnecessary files
2. **License field**: Include `license` in package.json (e.g., `"MIT"`)
3. **Repository URL**: Must match GitHub repo for Trusted Publishing
4. **Scoped packages**: Pass `--access public` on first publish (defaults to private)
5. **Version numbers**: Start with `0.1.0` or `1.0.0-beta.1` if expecting breaking changes

## AI Agent Publishing

**No prohibition** on AI-authored code being published. The account holder (human) bears responsibility. Automated publishing via CI/CD is explicitly supported and encouraged via Trusted Publishing.

## Commercial Content in Packages

### Allowed
- Attribution and sponsorship info in README
- Donation/payment details for development
- Related paid products and support services

### Prohibited
- Advertisements in README or package.json
- Packages that display ads at runtime or install
- Packages functioning primarily as advertisements

## Key TOS References

| Policy | Key Sections |
|--------|-------------|
| Open-Source Terms | Acceptable Use, Acceptable Content, Commercial Content |
| Code of Conduct | Unacceptable Behavior, Enforcement |
| Unpublish Policy | 72-hour rule, late unpublish conditions |
| Dispute Policy | Name squatting definition, dispute process |
| Trusted Publishing | OIDC setup, GitHub Actions integration |
