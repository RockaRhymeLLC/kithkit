# Sync Runbook: Public Kithkit ↔ Personal Instances

**Audience:** BMO (coordinator), R2 (reviewer), Dave (approver)
**Last updated:** 2026-03-03

---

## 1. Overview

### Architecture

```
                     ┌─────────────────────┐
                     │  kithkit (public)    │
                     │  RockaRhymeLLC/kithkit│
                     │  upstream/main       │
                     └──────┬──────────────┘
                            │  downstream (automated PR)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ KKit-BMO │ │ KKit-R2  │ │KKit-Skip │
        │  private │ │  private │ │  private │
        └──────────┘ └──────────┘ └──────────┘
              │
              │  upstream contribution (manual, curated)
              ▼
        ┌─────────────────────┐
        │  kithkit (public)   │
        │  PR → review → merge│
        └─────────────────────┘
```

### Flow Directions

| Direction | Frequency | Method | Who reviews |
|-----------|-----------|--------|-------------|
| **Downstream** (public → personal) | On every push to upstream/main; weekly fallback | Automated PR via GitHub Actions | BMO (agent) + Dave |
| **Upstream** (personal → public) | On demand, curated only | Manual branch + PR + leak check | R2 reviews, Dave approves |

### Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/upstream-sync.yml` | Downstream sync workflow (runs in KKit-BMO) |
| `.kithkit-private` | List of paths that must never sync upstream |
| `scripts/divergence-check.sh` | Reports framework vs. instance file classification |
| `scripts/divergence-check.ts` | TypeScript companion for divergence analysis |

---

## 2. Downstream Sync (Public → Personal)

### How It Triggers

1. **Primary:** A push to `main` on `RockaRhymeLLC/kithkit` fires a `repository_dispatch` event (`upstream-sync` type) to each registered personal repo via the public repo's `notify-instances.yml` workflow.
2. **Weekly fallback:** Monday 8:00 AM UTC cron — runs regardless of whether a dispatch was received.
3. **Manual:** `workflow_dispatch` via GitHub UI (`Actions` → `Upstream Sync` → `Run workflow`).

### What the Workflow Does

File: `.github/workflows/upstream-sync.yml`

1. **Checkout** — full history (`fetch-depth: 0`) using `SYNC_TOKEN`.
2. **Add upstream remote** — `https://github.com/RockaRhymeLLC/kithkit.git`.
3. **Check delta** — counts commits behind/ahead. Exits early if already up to date.
4. **Install + build scripts** — compiles `scripts/divergence-check.ts`.
5. **Run divergence check** — classifies changed files as `framework` or `instance`.
6. **Generate sync manifest** — captures SHA, commit counts, file lists for PR body.
7. **Create sync branch** — `sync/upstream-YYYYMMDD-HHMM`, merges upstream (`--no-commit --no-ff`), commits, pushes.
8. **Open PR** — titled `chore: sync upstream @ <SHA>` against `main`, body includes divergence JSON and file table.

If already up to date, the workflow exits cleanly with no PR.

### Weekly Cron Backup

Fires at `0 8 * * 1` (Monday 8:00 AM UTC) via the `schedule` trigger. Runs the same logic — if no new commits, exits early. Ensures sync happens even if a dispatch was missed.

### Manual Trigger

```bash
# Via GitHub CLI
gh workflow run upstream-sync.yml --repo RockaRhymeLLC/KKit-BMO
```

Or: GitHub UI → Actions → Upstream Sync → Run workflow → Run.

### How to Review a Sync PR

1. Open the PR. Read the **Divergence Check** JSON in the body.
2. Expand the **Changed Files** table — two columns: `Framework (upstream)` and `Instance (review required)`.
3. For **framework files**: spot-check the diff. Upstream wins by policy — accept unless there's a clear breakage.
4. For **instance files** listed in the PR body: these should NOT be modified by the merge. If they appear in the diff, resolve them manually before merging (see conflict resolution below).
5. Run `npm test` locally or verify CI passes.
6. Merge with **"Create a merge commit"** (not squash — preserves upstream history).

### Conflict Resolution Rules

| File / Pattern | Rule |
|----------------|------|
| Framework files (not in `.kithkit-private`) | **Upstream wins.** Accept their version. |
| Instance files (listed in `.kithkit-private`) | **Skip / keep ours.** `git checkout HEAD -- <file>` |
| `daemon/src/extensions/index.ts` | Keep our version — instance loading is dynamic, upstream change shouldn't affect the instance block. |
| `package.json` / `package-lock.json` | Merge both dependency sets. Run `npm install` after resolving. |
| `.claude/CLAUDE.md` | Keep our additions; accept upstream structural changes. Use `git mergetool`. |
| `.claude/settings.json` | **Section-aware merge:** keep our `mcpServers`, `permissions.allow`, and `env` blocks; accept upstream `model`, `apiKeyHelper`, and other framework settings. |

**To resolve instance files that got touched:**
```bash
git checkout HEAD -- <instance-file>
git add <instance-file>
```

---

## 3. Upstream Contributions (Personal → Public)

Only curated, framework-quality changes go upstream. Instance-specific code, personal config, and BMO-specific tasks never go upstream.

### Workflow

1. **Identify promotable work** — a bug fix, new feature, or doc improvement that belongs in the framework (not BMO-specific).

2. **Create a clean branch from upstream in a worktree** (worker agent runs this):
   ```bash
   git fetch upstream main
   git worktree add /tmp/upstream-contrib upstream/main
   cd /tmp/upstream-contrib
   git checkout -b contrib/my-feature
   ```

3. **Cherry-pick or re-implement** the changes onto the clean branch:
   ```bash
   git cherry-pick <commit-sha>
   # or re-implement cleanly if the original commit has instance-specific context
   ```

4. **Run local leak check:**
   ```bash
   bash scripts/upstream-leak-check.sh
   ```
   This checks staged content against the blocked patterns list (see §3.3).

5. **Push to a fork or the public repo directly:**
   ```bash
   git push upstream contrib/my-feature
   ```

6. **Open PR on the public repo:**
   ```bash
   gh pr create --repo RockaRhymeLLC/kithkit \
     --title "fix: <description>" \
     --body "$(cat .github/PULL_REQUEST_TEMPLATE.md)"
   ```

7. **Review gate:** R2 reviews the PR. Dave approves and merges.

8. **Downstream flow:** After merge to public `main`, the dispatch fires → personal repos get sync PRs automatically.

### Who Does What

| Step | Owner |
|------|-------|
| Identify + branch + cherry-pick | BMO (or Skippy on assignment) |
| Leak check | BMO (pre-push hook + CI) |
| Code review | R2 |
| Final approval + merge | Dave |

### Leak Prevention

**Blocked patterns** (defined in `.kithkit-private` and checked by CI):

```
BMO, R2D2, Skippy          # Agent names
bmobot                     # Domain
daveh@, kp.hurley          # Personal identifiers
7629737488                 # Telegram user ID
192.168.12                 # LAN IPs
credential-                # Keychain references
com.assistant.bmo, com.bmo # launchd service names
lindee                     # Personal reference
```

The CI `leak-guard` job in the public repo's `ci.yml` blocks PRs containing these patterns in `*.ts`, `*.js`, `*.yaml`, `*.json`, `*.md`, `*.sh` files (excluding `node_modules`, README, templates).

**Pre-push hook** (install on the public repo): `.claude/hooks/upstream-leak-check.sh` — blocks `git push` if any staged file matches blocked patterns.

### PR Template Checklist

When opening a PR on the public repo, confirm:
- [ ] No agent names (BMO, R2, Skippy) in code or comments
- [ ] No personal emails, phone numbers, or Telegram IDs
- [ ] No LAN IP addresses
- [ ] No `credential-*` keychain references
- [ ] No `com.assistant.bmo` or `com.bmo.*` service names
- [ ] No `.kithkit-private` paths modified
- [ ] `npm test` passes locally against the public repo
- [ ] Change is framework-quality (useful to all instances, not BMO-specific)

---

## 4. Post-Merge Health Check

### What It Checks

After a sync PR is merged to `main`, the `post-merge-health.yml` workflow (if configured) runs:

1. **`tsc --noEmit`** — TypeScript type check (daemon)
2. **`npm test`** — full test suite
3. **Daemon smoke test** — `bash scripts/daemon-smoke-test.sh` (starts daemon, hits `/health`, shuts down)

### What Happens on Failure

If any check fails:
1. An auto-revert PR is opened: `revert: sync upstream @ <SHA>` targeting `main`.
2. A notification is sent to comms (BMO) via the daemon's channel router.
3. BMO notifies Dave via Telegram.

### How to Review a Revert PR

1. Open the auto-revert PR.
2. Check the failed workflow run — identify which check failed (tsc / test / smoke).
3. Options:
   - **Merge the revert** to restore main to working state, then fix forward.
   - **Push a fix commit** to the sync branch (if the revert PR hasn't been merged yet).
4. After merging the revert, open a new issue tracking the failure before re-syncing.

---

## 5. Migration Numbering Convention

SQLite migrations in `daemon/src/core/migrations/` use a three-digit prefix.

| Range | Owner | Example |
|-------|-------|---------|
| `001`–`899` | Public kithkit | `001-init.sql`, `012-vector-search.sql` |
| `900`–`949` | KKit-BMO | `900-bmo-cowork.sql`, `913-task-work-notes.sql` |
| `950`–`974` | KKit-R2 | `950-r2-metrics.sql` |
| `975`–`999` | KKit-Skippy | `975-skippy-tasks.sql` |

**Rationale:** Prevents numbering collisions when multiple instances develop migrations independently.

### Promotion to Upstream

When a personal migration is promoted to the public repo:

1. Renumber it to the next sequential number in the `001`–`899` range.
2. Remove the personal-range copy from the instance repo.
3. On next downstream sync, the renumbered migration will arrive in all instances.
4. Ensure the migration is idempotent — use `CREATE TABLE IF NOT EXISTS` and `IF NOT EXISTS` checks.

**Example:**
- BMO has `913-task-work-notes.sql`
- Promoted to public as `013-task-work-notes.sql`
- BMO removes `913-task-work-notes.sql` on next sync PR

---

## 6. Troubleshooting

### Sync PR has conflicts

**Symptom:** The sync branch has merge conflicts; the PR shows conflict markers.

**Fix:**
```bash
git fetch origin
git checkout sync/upstream-YYYYMMDD-HHMM
git fetch upstream main
git merge upstream/main   # will re-conflict; resolve manually
# For instance files: git checkout HEAD -- <file>
# For framework files: accept upstream version
git add .
git commit
git push origin sync/upstream-YYYYMMDD-HHMM
```
The open PR updates automatically.

### CI fails on sync PR

**Symptom:** `npm test` or `tsc` fails on the sync branch.

**Steps:**
1. Check the failing test output in the Actions log.
2. If the failure is in a framework file: open a PR on the public repo fixing the test (upstream bug).
3. If the failure is in an instance file: fix locally, push to the sync branch.
4. If the failure is a pre-existing flake: re-run the workflow.

### Health check fails after merge

**Symptom:** Post-merge health check fails; auto-revert PR appears.

**Steps:**
1. Read the workflow log to identify the exact failure.
2. Merge the auto-revert PR to restore main.
3. File an issue with the failure details.
4. Fix the issue (either in public repo or instance), then trigger a new sync.

### Dispatch not firing (check INSTANCE_SYNC_TOKEN)

**Symptom:** Push to public `kithkit/main` doesn't trigger a sync PR on KKit-BMO within ~5 minutes.

**Checks:**
1. Verify the `notify-instances.yml` workflow ran in the public repo: `gh run list --repo RockaRhymeLLC/kithkit`.
2. Check the run log — look for HTTP 4xx errors on the dispatch call.
3. If 401/403: `INSTANCE_SYNC_TOKEN` has expired or lacks `repo` scope on the private repo.
4. Rotate the PAT: GitHub Settings → Developer settings → Fine-grained tokens → Regenerate.
5. Update the secret: `gh secret set INSTANCE_SYNC_TOKEN --repo RockaRhymeLLC/kithkit`.

### Divergence report shows unexpected files

**Symptom:** `scripts/divergence-check.sh` reports framework files you expect to be instance-only (or vice versa).

**Fix:**
1. Add the file path to `.kithkit-private` if it should never sync upstream.
2. Remove from `.kithkit-private` if it should sync.
3. Commit `.kithkit-private` and push — the next sync PR will classify correctly.

```bash
echo "path/to/file.ts" >> .kithkit-private
git add .kithkit-private && git commit -m "fix: classify file as instance-private"
```

---

## 7. Emergency Procedures

### Manually revert a bad sync

If a sync merge broke main and there's no auto-revert PR:

```bash
# Find the commit before the bad merge
git log --oneline -10

# Create a revert commit (safe — does not rewrite history)
git revert <bad-merge-sha> --mainline 1 -m "emergency: revert bad sync"
git push origin main
```

Then open an issue tracking what went wrong before re-syncing.

### Skip a sync cycle

To let a weekly cron run without creating a PR (e.g., you know there are conflicts and aren't ready to deal with them):

```bash
# Temporarily disable the schedule trigger by editing the workflow
# Do NOT commit this change — revert after the cycle passes
git stash  # or just don't push
```

Or: cancel the running workflow in GitHub Actions before it reaches the "Create sync branch" step.

### Force re-sync from upstream

If main has diverged and you want to reset to upstream state (destructive — use only if instance-specific changes are backed up):

```bash
git fetch upstream main
git checkout main
git reset --hard upstream/main
git push origin main --force-with-lease
```

**Warning:** This discards all instance commits since the last sync. Verify you have backups of instance-specific files before running. Coordinate with Dave before executing.

### Re-trigger sync after fixing INSTANCE_SYNC_TOKEN

```bash
# Manual dispatch from the public repo side
gh workflow run notify-instances.yml --repo RockaRhymeLLC/kithkit

# Or trigger directly on the personal repo
gh workflow run upstream-sync.yml --repo RockaRhymeLLC/KKit-BMO
```
