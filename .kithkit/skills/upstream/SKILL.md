---
name: upstream
description: Upstream local enhancements back to the original CC4Me repo. Use when contributing fork improvements to the shared upstream project.
argument-hint: [audit | genericize | analyze | pr | status | sync]
disable-model-invocation: true
---

# Upstream Enhancements

Contribute enhancements from your local fork back to the original CC4Me repository via the `cc4me-dev` middleman repo. This is a multi-phase workflow that syncs, audits, genericizes, and prepares clean PRs.

## Usage

- `/upstream` or `/upstream status` - Show current upstream progress
- `/upstream sync` - Sync cc4me-dev with fork's latest changes
- `/upstream audit` - Run the full audit + genericize + analyze pipeline
- `/upstream genericize <pr-group>` - Genericize files for a specific PR group
- `/upstream analyze` - Generate or update the analysis document
- `/upstream pr <pr-group>` - Create a PR for a specific group (after review/approval)

## Overview

```
Fork (your repo)         cc4me-dev (middleman)        Upstream (CC4Me)
+--------------+        +------------------+         +--------------+
| Fork-specific|  sync  | PII-scrubbed     |   PR    |   Generic    |
|  code with   | -----> | genericized code | ------> |  code ready  |
| enhancements |        |                  |         |  for anyone  |
+--------------+        +------------------+         +--------------+
                              |
                              | Remotes:
                              |   origin -> fork (CC4Me-YourFork)
                              |   upstream -> CC4Me
```

## Key Directories

| Path | Purpose |
|------|---------|
| `~/CC4Me-YourFork/` | Your fork -- live assistant code. **NEVER modify for upstream work.** |
| `~/cc4me-dev/` | Middleman working copy. All genericization and PRs happen here. Has `origin` (fork) and `upstream` (CC4Me) remotes. |
| `.claude/state/research/upstream-analysis.md` | Analysis document (tech debt, findings, recommendations) |

## Phase 1: Sync cc4me-dev

```bash
cd ~/cc4me-dev
git checkout main
git pull origin main      # Pull latest from fork
git fetch upstream        # Fetch upstream state
```

Verify the working tree is clean before starting any upstream work.

## Phase 2: Audit & Genericize

### PR Groups

Work through these groups in order. Each becomes a branch off `upstream/main` and eventually a PR to the upstream CC4Me repo.

#### Group 1: Session Persistence & Lifecycle Hooks
**Branch**: `feature/session-persistence`
**Files to copy from fork**:
- `scripts/start-tmux.sh`
- `scripts/attach.sh`
- `scripts/restart.sh`
- `scripts/restart-watcher.sh`
- `.claude/hooks/session-start.sh`
- `.claude/hooks/pre-compact.sh`
- `.claude/hooks/set-channel.sh`
- `.claude/settings.json` (hook configuration only)
- `.claude/skills/restart/SKILL.md`
- `scripts/start.sh` (updates)

#### Group 2: Email Integration
**Branch**: `feature/email-integration`
**Files to copy from fork**:
- `.claude/skills/email/SKILL.md`
- `.claude/skills/email-compose/SKILL.md`
- `scripts/email/jmap.js` (Fastmail)
- `scripts/email/graph.js` (M365)
- `scripts/email-reminder.sh`
- `.claude/skills/email/fastmail-reference.md`
- `.claude/skills/email/graph-reference.md`
- `.claude/skills/keychain/reference.md`

#### Group 3: Telegram Integration
**Branch**: `feature/telegram-integration`
**Files to copy from fork**:
- `.claude/skills/telegram/SKILL.md`
- `scripts/telegram-send.sh`
- `scripts/transcript-watcher.sh`
- `scripts/telegram-setup/*` (entire directory)
- `.claude/skills/telegram/setup.md`

#### Group 4: Scheduled Jobs & Monitoring
**Branch**: `feature/scheduled-jobs`
**Files to copy from fork**:
- `scripts/todo-reminder.sh`
- `scripts/context-watchdog.sh`
- `scripts/context-monitor-statusline.sh`
- `launchd/` (updated templates)

#### Group 5: Documentation & Setup Updates
**Branch**: `feature/documentation-update`
**Files to copy from fork**:
- `.claude/CLAUDE.md` (rewritten for generic assistant)
- `README.md` (comprehensive update)
- `SETUP.md` (updated with integration steps)
- `.claude/skills/setup/SKILL.md` (updated wizard)
- `scripts/init.sh` (updated with new prereqs)

#### Group 6: Skills
**Branch**: `feature/skills-update`
**Files to copy from fork** (all skills not yet upstream):
- `.claude/skills/review/SKILL.md`
- `.claude/skills/email-compose/SKILL.md`
- Updated versions of existing skills (todo, memory, calendar, etc.)

**Genericization for skills is especially important:**
- Strip any agent-specific personality references (names, pronouns)
- Replace hardcoded agent names with config references or `{{NAME}}`
- Remove references to specific Telegram chat IDs, email addresses, or hostnames
- Keep the functional logic intact — just remove identity assumptions

### Genericization Rules

When copying files from the fork to upstream, apply these transformations:

1. **Remove personal data**: Strip all references to specific people, emails, phone numbers, chat IDs
   - Search for personal names, usernames, phone numbers, domain names
   - Replace with template variables, Keychain lookups, or remove entirely

2. **Remove hardcoded paths**: Replace absolute user paths with relative paths or `$PROJECT_DIR`
   - `start.sh`: Replace hardcoded claude path with `command -v claude` fallback
   - All scripts: Use `$BASE_DIR` or `$(dirname "$0")/..` patterns

3. **Parameterize credentials**: Ensure all secrets come from Keychain lookups, never hardcoded
   - Verify `security find-generic-password` calls use generic credential names
   - Document required Keychain entries in each skill/script

4. **Remove branded content**: App bundles, custom names, personality references
   - Keep templates generic (e.g., `{{NAME}}` not a specific name)

5. **Preserve functionality**: The genericized code must work identically -- just without fork-specific assumptions

### Audit Checklist (Per File)

For each file being copied upstream, evaluate and document:

- [ ] **Hardcoded values**: Any personal data, paths, or credentials?
- [ ] **Code quality**: Clean, readable, well-structured?
- [ ] **Error handling**: Appropriate error handling for the context?
- [ ] **Dependencies**: Are all dependencies documented? Any unnecessary ones?
- [ ] **Security**: Any credential leaks, injection risks, or unsafe patterns?
- [ ] **Portability**: Will this work on a fresh macOS install with different username?
- [ ] **Documentation**: Are comments adequate? Is usage clear?
- [ ] **Tech debt**: Anything that works but should be improved?
- [ ] **Dead code**: Unused variables, unreachable branches, commented-out code?
- [ ] **Consistency**: Does it follow the same patterns as other scripts/skills?

## Phase 3: Analysis Document

Generate `upstream-analysis.md` in `.claude/state/research/` with this structure:

```markdown
# CC4Me Upstream Analysis

## Summary
[Overall assessment, total files reviewed, key findings count]

## Findings by Severity

### Critical (Must Fix Before PR)
[Security issues, broken functionality, data leaks]

### Important (Should Fix)
[Tech debt, poor patterns, missing error handling]

### Minor (Nice to Have)
[Style issues, documentation gaps, minor improvements]

### Notes (Informational)
[Observations, architectural notes, future considerations]

## Findings by PR Group

### Group 1: Session Persistence
[Findings specific to these files]

### Group 2: Email Integration
[Findings specific to these files]

... (repeat for each group)

## Recommendations
[Prioritized list of what to address before vs. after PRs]
```

### What to Look For

- **Tech debt**: Patterns that work but are fragile, hacky, or hard to maintain
- **Old code**: Approaches that made sense early on but should be updated now
- **Bad patterns**: Anti-patterns, security risks, race conditions
- **Missing features**: Error handling, logging, or validation that should exist
- **Inconsistencies**: Different patterns used for the same thing across files
- **Dependencies**: Unnecessary or outdated dependencies
- **Portability issues**: Anything that assumes a specific environment

## Phase 4: Review with Owner

**STOP here and present findings before proceeding.**

1. Save analysis to `.claude/state/research/upstream-analysis.md`
2. Share the analysis with the owner for review
3. Discuss findings -- owner decides what to fix now vs. later
4. Get explicit approval before creating any commits or PRs

## Phase 5: Create PRs (After Approval)

PRs go from cc4me-dev to the upstream CC4Me repo.

For each approved PR group:

```bash
cd ~/cc4me-dev

# Create branch off upstream/main (not origin/main!)
git fetch upstream
git checkout -b feature/<branch-name> upstream/main

# Copy genericized files from origin/main
# (files were already audited and cleaned in Phase 2)
git checkout origin/main -- <file1> <file2> ...

# Review the diff — ensure no PII, no fork-specific content
git diff --cached

# Commit
git add <files>
git commit -m "Add <feature description>"

# Push to origin (fork) and create PR targeting upstream
git push -u origin feature/<branch-name>
gh pr create --repo RockaRhymeLLC/CC4Me \
  --title "<PR title>" \
  --body "<description>"
```

### PR Standards
- One logical group per PR
- Clean commit messages describing the "why"
- PR description includes: summary, files changed, testing notes
- No personal data in any committed file
- PRs target the **upstream** repo (CC4Me), not the fork

## Phase 6: Merge & Verify

After owner reviews each PR:

1. Merge on GitHub (or via `gh pr merge`)
2. Sync cc4me-dev: `git fetch upstream && git checkout main && git merge upstream/main`
3. Verify: Clone fresh to a temp directory, run `init.sh` and `/setup`, confirm everything works
4. Move to next PR group

## Status Tracking

Track progress in the analysis document's summary section:

```markdown
## Progress
| Group | Audit | Genericize | Analysis | Review | PR | Merged |
|-------|-------|------------|----------|--------|----|--------|
| 1. Session Persistence | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| 2. Email Integration   | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| 3. Telegram Integration| [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| 4. Scheduled Jobs      | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| 5. Documentation       | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
| 6. Skills              | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |
```

## Notes

- **Never modify the fork** during upstream work
- **Always work in** `~/cc4me-dev` (the middleman repo)
- **Branches for PRs** should be based on `upstream/main`, not `origin/main`
- **Analysis doc is the source of truth** for what needs attention
- **Owner approval required** before any commits or PRs
- **Skills need extra scrutiny** — they often contain agent-specific personality, names, or config references that must be genericized
- This skill is reusable -- any fork can use `/upstream` to contribute enhancements back
