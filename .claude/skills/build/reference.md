# Build Workflow Reference

Detailed instructions for story-driven implementation and build management.

## Full Build Workflow

### Step 1: Pre-Build Setup

Before starting, create the flag file so the pre-build hook knows a build is active:

```
echo "<plan-file-path>" > /tmp/kithkit-build-active
```

The hook will then verify the plan file and spec file exist. Without the flag file the hook exits immediately, so this step is required.

### Step 2: Load Plan Context

Use the Read tool to load:
- The plan.md file (for technical approach, story table, and notes)
- All story JSON files from `plans/stories/` referenced by the plan
- All test JSON files from `plans/tests/` referenced by the plan

Understand the full picture before touching any code: what the feature does, how the stories are ordered, and what each test verifies.

### Step 3: Verify User Perspective

From the plan, identify WHO uses this feature:
- Human — implementation handles CLI or UI input
- Claude Code — implementation handles skill invocation
- External System — implementation handles API requests
- Hybrid — multiple interaction patterns apply

Tests are written from this perspective. The implementation must satisfy the tests as written, not reinterpret them from a different vantage point.

### Step 4: Verify Test Integrity

Before writing any code, confirm that test JSON files have not been modified since the plan phase. Check git history or file timestamps if there is any doubt. Tests are the contract — if they have been changed during build that is a critical failure requiring an immediate stop.

### Step 5: Work Through Stories in Priority Order

For each story (lowest priority number first):

#### 5.1 — Initial Test (Red State)

Load the story from `plans/stories/s-{id}.json`. Identify which tests it references via the `tests` array. Load each referenced test from `plans/tests/t-{id}.json` and work through its `steps` array in order:
- Perform each `action`
- Check whether the `expected` result occurs

At this point the feature is not yet implemented, so the test steps should fail. Confirm that failure before proceeding. This validates that the tests are actually exercising something real.

#### 5.2 — Mark In Progress

Edit the story JSON file to update:
- `status`: `"pending"` → `"in-progress"`
- `updated`: current timestamp

#### 5.3 — Implement

Read the story's `acceptanceCriteria` array. Implement the smallest change that satisfies every criterion. Add notes to the story's `notes` array as you go — these provide context if the session breaks mid-build.

You can update these story fields during build:
- `status`
- `updated`
- `notes` (add entries, never remove)
- `files` (list files you created or modified)

You cannot update:
- `acceptanceCriteria`
- `tests`
- Any test definition

#### 5.4 — Verify Test Passes (Green State)

Run the story's tests again, step by step. All steps must pass. If a step fails, fix the implementation — never the test.

#### 5.5 — Regression Check

Pick 2 tests at random from OTHER already-completed stories. Work through each one step by step. Both must pass. If fewer than 2 completed stories exist, run whatever is available.

If a regression test fails: stop, fix the regression, re-run both the current story's tests and the regression tests before marking anything complete.

#### 5.6 — Mark Complete

Edit the story JSON:
- `status`: `"in-progress"` → `"completed"`
- `updated`: current timestamp

Move to the next pending story and repeat.

### Step 6: Handle Blockers

If you cannot complete a story:
- Update `status` to `"blocked"`
- Add a note in the `notes` array explaining the blocker clearly
- Check whether another story is unblocked and can be worked instead
- If truly stuck, ask the user before abandoning progress

### Step 7: Post-Build

After all stories are complete:
- Run `/validate` to verify completeness and spec alignment
- Offer to create a git commit (see commit format below)
- Update the parent to-do if the plan references one via `todoRef`

### Step 8: Display Summary

```
Build Complete!

Stories: 5/5 completed
Tests: all passing
Files created: 7
Files modified: 2

Next steps:
  1. Review implementation
  2. Test manually
  3. Deploy or integrate
```

---

## Story JSON Format

Story files live at `plans/stories/s-{id}.json`. Fields:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | e.g. `"s-a1b"` — 3 alphanumeric chars after prefix |
| `title` | string | Short description of the work unit |
| `description` | string | Longer explanation |
| `planRef` | string | Path to the parent plan.md |
| `todoRef` | string | Parent to-do ID if applicable |
| `status` | string | `pending` / `in-progress` / `completed` / `blocked` |
| `priority` | number | Lower number = higher priority |
| `tests` | array | List of test IDs that verify this story |
| `blockedBy` | array | Story IDs that must complete first |
| `created` | string | ISO timestamp |
| `updated` | string | ISO timestamp — update on every change |
| `notes` | array | Progress notes: `{ "timestamp": "...", "content": "..." }` |
| `files` | array | Files created or modified during implementation |
| `acceptanceCriteria` | array | Strings defining what "done" means — immutable |

---

## Test JSON Format

Test files live at `plans/tests/t-{id}.json`. Fields:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | e.g. `"t-001"` — 3-digit number after prefix |
| `title` | string | Short description of what is being verified |
| `description` | string | Longer explanation |
| `storyRefs` | array | Story IDs this test verifies |
| `planRef` | string | Path to the parent plan.md |
| `type` | string | `"story"` or `"regression"` |
| `status` | string | `pending` / `passed` / `failed` |
| `steps` | array | Ordered steps — **immutable** |
| `created` | string | ISO timestamp |
| `executedAt` | string | ISO timestamp — set when test is run |
| `result` | string or null | Pass/fail detail after execution |

Each step in the `steps` array contains:
- `order` — integer, run in ascending order
- `action` — what to do
- `expected` — what the result should be

Updatable during build: `status`, `executedAt`, `result`.
Never modify: `steps`, `title`, `description`, `id`.

---

## TDD Cycle

The core build loop:

```
1. RED:      Work through test steps — they fail (not implemented yet)
   ↓
2. GREEN:    Implement the minimum code to make all steps pass
   ↓
3. VERIFY:   Walk through steps again, confirm all pass
   ↓
4. REGRESS:  Run 2 tests from other completed stories
   ↓
   Repeat for next story
```

Never modify test steps during build. They define what "correct" means.

---

## Common Scenarios

### Tests Keep Failing

Do:
1. Read the failing step carefully — what action was performed and what was expected?
2. Compare the expected result with what the implementation actually produces
3. Fix the implementation to match the expectation
4. Add debugging or logging if the root cause is unclear
5. Ask for help if genuinely stuck after a good-faith attempt

Do not:
- Modify test steps to make them pass
- Skip failing steps
- Treat a partial pass as a full pass
- Change what the test expects

### Tests Seem Wrong

Stop — the test might genuinely be wrong.

1. Re-read the test against the spec requirements
2. Check whether the test reflects the actual user perspective described in the plan
3. If the test is genuinely wrong:
   - Stop the build immediately
   - Explain what is wrong and why
   - Request user approval to modify
   - Return to `/plan` to fix the test JSON
   - Re-run `/validate` after the fix
   - Restart build with the corrected test

Tests are immutable during build, but if they are wrong the correct action is to stop and fix them in the plan phase — not to work around them.

### Need to Change API or Interface

If implementation reveals the API should be different from what the tests expect:

1. Check whether the existing test steps cover the new API shape
2. If yes — implement to match what the steps expect (they define the contract)
3. If no — the tests are incomplete
   - Stop the build
   - Return to `/plan` to add test steps for the new API
   - Restart build with the updated tests

---

## Error Handling

### Build Errors

- Syntax or type errors: Fix the error in the implementation file
- Missing dependencies: Install the required package, then continue
- Permission errors: Check file and directory permissions before retrying

### Test Integrity Violations

If test step content was modified after the plan phase:
1. Report a critical violation immediately
2. Show what changed (use git diff or compare with plan documentation)
3. Explain the TDD contract and why this matters
4. Stop the build
5. Require the user to confirm before any further work

### Validation Failures (post-build)

- Report which check failed
- Provide specific guidance on what to fix
- Block marking the build complete until resolved
- Re-run `/validate` after the fix

---

## Commit Format

When offering to create a git commit after a successful build:

```
Add [feature name]

Implements [brief description]:
- [Key change 1]
- [Key change 2]
- [Key change 3]

Stories: X completed
Spec: specs/YYYYMMDD-feature-name.spec.md
```

---

## Integration

- **Stories**: `plans/stories/s-{id}.json` — work units tracked through build
- **Tests**: `plans/tests/t-{id}.json` — verification criteria, immutable during build
- **Validation**: `/validate` runs automatically post-build
- **To-Dos**: Parent to-do gets updated when a plan completes (via `todoRef`)
- **Git**: Commit offered after successful validation

---

## Best Practices

1. **Read tests before coding** — understand what success looks like first
2. **Confirm the red state** — run tests before implementing to prove they actually test something
3. **Small steps** — implement the minimum to satisfy each step, then refactor when green
4. **Update notes as you go** — notes in stories create an audit trail and aid context recovery
5. **Keep focused** — implement only what the tests and acceptance criteria require
6. **Never modify tests** — they are immutable during build; fix them in planning if wrong
7. **Complete one story at a time** — finish, pass regression, mark complete before moving on
8. **Validate often** — catch integration issues before they compound

## Remember

**Tests define the contract.** Your job during build is to satisfy that contract, not reinterpret or change it. If the contract is wrong, stop and fix it in the planning phase.
