---
name: github-tos
description: GitHub Terms of Service compliance checklist and SOP. Use before performing bulk GitHub operations like submitting multiple PRs, issues, starring repos, or any automated GitHub API activity.
user-invocable: false
---

# GitHub TOS Compliance

Reference skill for operating within GitHub's Terms of Service. Loaded automatically when performing GitHub operations that could trigger abuse detection.

**Why this exists**: Our PR blitz (11 PRs + 15 issues in minutes) got a GitHub account TOS'd. These rules prevent that from happening again.

## Hard Rules (Violations = Account Ban)

1. **No bulk automated activity**: Never submit more than **3 PRs or issues per hour** to external repos
2. **No fake/inauthentic engagement**: No automated starring, following, or rank manipulation
3. **No spam**: Don't post identical or near-identical content across multiple repos/issues
4. **No empty/frivolous submissions**: Every PR and issue must have substantive, unique content
5. **One free account per person**: Don't create multiple free accounts for the same person
6. **No shared logins**: Each account is used by exactly one person/agent
7. **No excessive API calls**: Respect rate limits (5,000 requests/hour authenticated, 60 unauthenticated)
8. **No advertising in issues**: Don't post promotional content in other people's repos

## Account Separation Policy

- **Your GitHub account**: Use for all work originated by this agent
- **Never mix accounts**: Don't use someone else's credentials for bot/automated activity
- **One `gh auth` active at a time**: Before any GitHub operation, verify the active account with `gh auth status`
- **Remove unused credentials**: If a second account is configured in `gh auth`, log it out unless actively needed

## Automated Rate Ledger

A PreToolUse hook (`github-rate-check.py`) automatically enforces the 3/hour external write limit:

- **Gates**: `gh pr create` and `gh issue create` commands targeting external repos
- **Ledger**: `.claude/state/github-rate-ledger.json` (rolling 1-hour window, 24hr auto-prune)
- **Our orgs** (RockaRhymeLLC, RockaRhyme) are exempt — no limit on our own repos
- **Peer sync**: Writes broadcast to peer agents via agent-comms so all agents share one budget
- **Override**: Set `GITHUB_RATE_OVERRIDE=1` env var to bypass (use with caution)
- **Fail-closed**: If repo ownership can't be determined, treated as external

The hook warns when approaching the limit and blocks with a `deny` decision when at capacity.

## Pre-Flight Checklist (Before Bulk GitHub Operations)

Run through this checklist before submitting multiple PRs, issues, or performing any batch GitHub activity:

- [ ] **Account check**: Run `gh auth status` — confirm the correct account is active
- [ ] **Rate check**: Will this create more than 3 PRs/issues in an hour? If yes, **space them out** (minimum 20 minutes between submissions)
- [ ] **Content quality**: Is each PR/issue substantive and unique? (Not copy-paste with minor variations)
- [ ] **Target diversity**: Are you hitting the same repo repeatedly? If yes, batch smaller and space wider
- [ ] **API budget**: Check remaining rate limit with `gh api /rate_limit` before starting
- [ ] **Human review**: For 5+ external submissions, flag the user before starting

## Pacing Guidelines

| Operation | Max Rate | Spacing |
|-----------|----------|---------|
| PRs to external repos | 3/hour | 20+ min apart |
| Issues on external repos | 3/hour | 20+ min apart |
| PRs to our own repos | 10/hour | No strict limit, but don't flood |
| API calls | 5,000/hour | Monitor with `/rate_limit` |
| Starring/following | 10/hour | Space naturally |
| Comments on external PRs/issues | 5/hour | 15+ min apart |

## SOP: Submitting External PRs

When submitting PRs to repos we don't own (e.g., API directories, open source projects):

1. **Prepare all PRs locally** — create branches, write descriptions, test
2. **Verify account**: `gh auth status` — must show the correct account
3. **Submit one PR**, wait for any automated checks or bot responses
4. **Wait 20+ minutes** before submitting the next one
5. **Max 3 per hour** — if you have more, spread across multiple days
6. **Unique descriptions** — each PR should have a distinct, thoughtful description (not templated)
7. **Don't submit and disappear** — monitor for maintainer feedback within 24 hours

## SOP: Filing External Issues

1. **Search first** — check if the issue already exists
2. **One issue per problem** — don't batch-file related issues simultaneously
3. **Wait 20+ minutes** between issues on the same repo
4. **Max 3 per hour** across all external repos
5. **Quality over quantity** — detailed reproduction steps, clear title, appropriate labels

## SOP: API Automation

When writing scripts or tools that use the GitHub API:

1. **Check rate limit** before starting: `gh api /rate_limit`
2. **Add delays** between API calls (minimum 1 second for reads, 5 seconds for writes)
3. **Handle 429 responses** — back off exponentially, don't retry immediately
4. **Use conditional requests** (`If-None-Match` / `If-Modified-Since`) to reduce unnecessary calls
5. **Cache responses** when possible
6. **Log API usage** so you can audit if something goes wrong

## What To Do If Flagged

If GitHub sends a warning or suspends an account:

1. **Stop all automated activity immediately**
2. **Don't create a new account** to work around the suspension
3. **Review what triggered it** — check recent API calls, PRs, issues
4. **Appeal through GitHub's process**: https://docs.github.com/en/site-policy/acceptable-use-policies/github-appeal-and-reinstatement
5. **Notify the user** immediately via Telegram
6. **Document the incident** in memory for future reference

## Key TOS Sections Reference

- **Section B.3**: Account requirements (human-created, one free account per person)
- **Section C**: Acceptable use (no spam, no excessive bulk activity)
- **Section H**: API terms (no abuse, GitHub determines what's excessive)
- **Acceptable Use Policy**: Prohibits automated excessive bulk activity, inauthentic interactions
- **Disrupting Other Users**: No bulk starring/following, empty PRs, excessive notifications
