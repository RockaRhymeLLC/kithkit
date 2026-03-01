# Team Collaboration Playbook

How BMO, Skippy, and R2 work together on shared tasks. Based on patterns from the first multi-agent collaboration session (2026-03-01), where 3 agents merged 18 PRs, closed 20+ issues, and cleared the board in a single night.

## Standing Roles

Per Dave's directive (2026-03-01):

| Agent | Role | Responsibilities |
|-------|------|-----------------|
| **BMO** | Coordinator + Coder | Files GitHub issues, assigns work, delegates tasks, codes features/fixes, merges PRs |
| **Skippy** | Coder | Implements assigned issues, submits PRs. Does not coordinate or assign work |
| **R2** | Reviewer | Reviews PRs and code quality. Does not code features |

BMO is the coordination point. Dave talks to BMO; BMO coordinates with R2 and Skippy via A2A.

## Communication

**A2A is the only channel for peer agent communication.** No SSH, no direct API calls to peer machines.

### Coordination Messages

BMO sends task assignments via A2A:

```
To: skippy
"Take issue #65 — fix relay forwarding failures. Branch from main, PR when ready."
```

BMO requests reviews via A2A:

```
To: r2
"PR #76 is ready for review — branch-guard hook. Low risk, config-only change."
```

### Status Updates

Agents post status updates when:
- Starting work on an issue
- PR is ready for review
- Review is complete (approved / changes requested)
- PR is merged

Keep messages short and actionable. No small talk during work sessions.

## Workflow

### 1. BMO Triages and Assigns

BMO owns the issue board. For a work session:

1. Review open issues — prioritize by severity and dependencies
2. File new issues for anything discovered during triage
3. Assign issues: coding tasks to Skippy (or self), review tasks to R2
4. Send assignments via A2A with issue number and brief context

### 2. Coders Work in Parallel

BMO and Skippy work on separate issues simultaneously:

- Each coder works in an **isolated git worktree** (never switch branches in the main repo)
- Branch naming: `fix/<issue-number>-<short-description>` or `feature/<description>`
- One issue per branch, one PR per issue
- Reference the issue in the PR title: `Fix #25: graceful handling of relay forwarding failures`

### 3. R2 Reviews

R2 reviews PRs based on the risk tier (see below). Reviews happen on GitHub — comments on the PR, approve or request changes.

### 4. BMO Merges

BMO merges approved PRs. For low-risk PRs that don't require R2's review, BMO can self-merge after a sanity check.

## PR Risk Tiers

Not every PR needs the same review depth. Use these tiers to match review effort to risk:

### Tier 1: Low Risk — Self-Merge OK

- Config-only changes (yaml, json)
- Documentation updates
- Typo fixes, comment updates
- Adding logs or debug output
- Test-only changes

**Review**: Author does a self-review. No R2 review required. BMO merges directly.

### Tier 2: Medium Risk — Quick Review

- Bug fixes to non-critical paths
- Small feature additions (< 100 lines changed)
- Refactors that don't change behavior
- Hook or script changes

**Review**: R2 does a focused review — check the logic, verify no regressions. Turnaround: minutes, not hours.

### Tier 3: High Risk — Full Review

- Changes to core daemon (main.ts, database, migrations)
- Security-sensitive code (auth, credentials, access control)
- Architectural changes (new extension points, API changes)
- Changes that affect all agents (shared config, protocol changes)
- Large PRs (> 300 lines changed)

**Review**: R2 does a thorough review — architecture, edge cases, error handling, test coverage. May require multiple rounds.

## Pipeline Pattern

The key throughput multiplier: **prep the next PR while the current one is in review.**

```
Timeline:
  BMO:    [code PR-A] [code PR-C] [merge PR-A] [code PR-E] [merge PR-C]
  Skippy: [code PR-B] [code PR-D] [merge PR-B] [code PR-F] [merge PR-D]
  R2:              [review PR-A] [review PR-B] [review PR-C] [review PR-D]
```

Rules for pipelining:
- Never let a coder idle while waiting for review — pick up the next issue
- R2 reviews in submission order unless BMO flags a priority
- If R2 requests changes, the original author addresses them (don't context-switch to someone else's PR)
- Independent issues can be worked in any order; dependent issues must respect the dependency chain

## GitHub as Shared Workspace

GitHub is the single source of truth for work state:

| Artifact | Purpose |
|----------|---------|
| **Issues** | Work items — every task gets an issue before work starts |
| **PRs** | Code delivery — linked to issues via `Fix #N` in title |
| **PR Reviews** | Quality gate — R2's reviews live on the PR |
| **PR Comments** | Discussion — technical questions, clarifications |
| **Merge** | Completion — merged PR = done, issue auto-closes |

### Issue Discipline

- BMO files all issues (coders don't self-file unless BMO is unavailable)
- Issues include: problem description, expected behavior, and affected code area
- Labels for priority when needed, but during a focused session, verbal priority via A2A is faster
- Close issues via PR merge (`Fix #N` in PR title auto-closes)

## Session Cadence

For a focused multi-agent work session:

1. **Kickoff**: BMO reviews the board, triages priorities, sends assignments via A2A
2. **Execution**: Coders work in parallel, R2 reviews as PRs land, BMO merges approved PRs
3. **Continuous triage**: BMO files new issues as they're discovered during work, assigns immediately
4. **Wrap-up**: Verify all PRs merged, all issues closed, no orphaned branches

## What Worked (Session Retrospective)

From the 2026-03-01 session — 18 PRs merged, 20+ issues closed:

- **Role clarity eliminated coordination overhead.** No negotiation about who does what. BMO assigns, Skippy codes, R2 reviews. Simple.
- **Pipelining kept all three agents productive.** Zero idle time — while one PR was in review, coders were already on the next issue.
- **Risk tiers prevented review bottlenecks.** Low-risk config/doc PRs got self-merged immediately instead of waiting in R2's queue.
- **GitHub as single source of truth** meant no one had to ask "what's the status?" — it's all visible on the board.
- **A2A messaging kept coordination lightweight.** Short messages, no meetings, no standups. Just "take this issue" and "PR ready for review."
- **Small, focused PRs** (one issue = one PR) made reviews fast and merges clean. No mega-PRs blocking the pipeline.

## Anti-Patterns to Avoid

- **BMO doing everything**: The coordinator's job is to delegate, not to be the sole coder. Use Skippy.
- **Skipping issues**: Don't start coding without a filed issue. Issues are the audit trail.
- **Review bottlenecks**: If R2's queue grows past 3 PRs, BMO should self-merge Tier 1 items to keep flow moving.
- **Branch switching on main**: Coders use worktrees. Never checkout a feature branch in the main repo. BMO and the orchestrator stay on main always.
- **Large PRs**: If a PR touches > 10 files, consider splitting it. Large PRs slow reviews and increase merge conflict risk.
- **Direct comms bypass**: All agent-to-agent communication goes through A2A. No SSH commands to peer machines for coordination.
