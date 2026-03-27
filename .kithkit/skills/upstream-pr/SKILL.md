# Upstream PR — Safe Public Repo Contribution

Use this skill when creating a PR on the public kithkit repo (RockaRhymeLLC/kithkit) from a private instance repo (KKit-BMO, KKit-Skippy, KKit-R2).

## Why This Exists

Private instance repos diverge significantly from the public repo — they contain instance-specific config, skills, personal data, orchestrator artifacts, and other files that must NEVER reach the public repo. A branch based on a private instance's `main` will carry all that divergence. This skill enforces a safe workflow.

## Mandatory Workflow

### 1. Start from a clean public baseline

**NEVER** branch off your private instance's `main`. Always start from the public repo's state.

Option A — Fresh clone (safest):
```bash
cd /tmp
git clone https://github.com/RockaRhymeLLC/kithkit.git kithkit-upstream-pr
cd kithkit-upstream-pr
git checkout -b fix/your-branch-name
```

Option B — Worktree from upstream remote:
```bash
cd ~/your-instance-repo
git fetch upstream
git worktree add .claude/worktrees/your-branch upstream/main
cd .claude/worktrees/your-branch
git checkout -b fix/your-branch-name
```

### 2. Apply changes to ONLY the target files

Copy or manually apply your changes. **Never use `git checkout` from your private branch** to pull files — it may bring untracked state.

```bash
# Example: copy specific files from your instance
cp ~/KKit-BMO/daemon/src/path/to/file.ts daemon/src/path/to/file.ts
```

### 3. Stage ONLY the intended files by name

```bash
# ALWAYS explicit filenames — NEVER use these:
#   git add -A        (FORBIDDEN)
#   git add .         (FORBIDDEN)
#   git add -u        (FORBIDDEN)

git add daemon/src/specific/file1.ts daemon/src/specific/file2.ts
```

### 4. Verify before committing

```bash
# Check file count and line changes — flag anything unexpected
git diff --stat --cached

# Review the actual diff
git diff --cached
```

**Red flags — STOP and investigate if you see:**
- More than ~2x your expected file count
- Files outside the directories you intended to change
- Any of these paths: `.claude/`, `projects/`, `data/`, `scripts/`, `logs/`, `*.pdf`, `*.plist`, identity files, config files, worktree artifacts
- Addition count in the thousands when you expected tens

### 5. Commit and push

```bash
git commit -m "fix: description of changes"
git push origin fix/your-branch-name
```

### 6. Create the PR

```bash
gh pr create --repo RockaRhymeLLC/kithkit \
  --title "fix: short description" \
  --body "$(cat <<'EOF'
## Summary
- What changed and why

## Test plan
- [ ] Build passes
- [ ] Specific functionality verified
EOF
)"
```

### 7. Request review

Always assign a reviewer. R2 is the default reviewer for upstream PRs.

```bash
gh pr edit <number> --repo RockaRhymeLLC/kithkit --add-reviewer r2d2-hurley
```

## Prohibited Paths

These files/directories must NEVER appear in an upstream PR. If any are present in your diff, abort and start over:

| Path Pattern | Reason |
|---|---|
| `.claude/state/` | Instance session state |
| `.claude/skills/` (instance-specific) | Private skills |
| `.claude/worktrees/` | Worktree artifacts |
| `projects/` | Instance specs/plans |
| `data/` | Instance data |
| `logs/` | Daemon logs |
| `scripts/*.js`, `scripts/*.d.ts` | Compiled artifacts |
| `*.pdf`, `*.plist` | Personal/system files |
| `identity.md` | Instance identity |
| `kithkit.config.yaml` | Instance config |
| `kithkit.db*` | Instance database |
| `tsconfig.test.json` | Instance test config |

## Checklist (verify before opening PR)

- [ ] Branch is based on `upstream/main` or a fresh clone of the public repo
- [ ] Only intended files are staged (`git diff --stat --cached`)
- [ ] No prohibited paths in the changeset
- [ ] File count and line count are reasonable for the change
- [ ] Build passes (`npm run build` in relevant workspace)
- [ ] PR has a reviewer assigned
