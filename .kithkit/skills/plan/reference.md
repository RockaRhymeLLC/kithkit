# Plan Workflow Reference

Detailed step-by-step instructions for creating plans and managing stories and tests.

## Creation Workflow

### Step 1: Validate Input

Confirm a spec file path was provided. Use the Read tool to load the spec file and confirm it exists. If the spec is missing or the path is wrong, report the error and stop — a plan cannot be created without a spec.

### Step 2: Analyze the Specification

Parse the spec to extract:
- **Must Have requirements** — core features that define the minimum viable outcome
- **Should Have requirements** — valuable additions, lower priority than must-haves
- **Won't Have** — explicitly out-of-scope items to avoid scope creep
- **Constraints** — security, performance, and compatibility requirements
- **Success criteria** — measurable outcomes that define "done"
- **User stories** — usage scenarios that inform how tests should be written
- **Open questions** — unresolved decisions; note these, as they may block planning

### Step 3: Identify User Perspective

Determine who will use this feature, because tests are written from that perspective:

| User Type | Examples | Test Approach |
|-----------|----------|---------------|
| Human | CLI commands, web UI, API calls | Verify command output, UI behavior, API responses |
| Claude Code | Skills, workflows, internal tools | Verify skill invocation results, file outputs, tool behavior |
| External System | APIs, webhooks, integrations | Verify HTTP request/response formats, data shapes |
| Hybrid | Multiple user types | Test all interaction patterns separately |

Document this in the plan.md under a "User Perspective" section so the build phase knows what the tests are simulating.

### Step 4: Technical Planning

#### Architecture Decisions

Consider:
- What libraries or frameworks are needed?
- What design patterns fit?
- What are the integration points with existing code?
- What are the performance implications?
- What security considerations apply?

Document the architecture under "Technical Approach" in the plan.md. Explain key decisions — "Why X instead of Y?" — so future readers understand the reasoning.

#### File Planning

List all files that will be created or modified. For each, note its purpose. This helps the build phase know what surface area is in play.

Example:
```
### New Files
- src/module/feature.ts — Core feature logic
- src/module/feature-types.ts — Shared type definitions

### Modified Files
- src/index.ts — Export new module
- cc4me.config.yaml — New config section for this feature
```

### Step 5: Task Breakdown — Create Stories

Break the work into discrete stories. Each story is a logical unit of implementation that can be completed independently (or after its dependencies are done). For each story, create `projects/<feature-name>/stories/s-{id}.json`.

Story ID format: `s-` prefix + 3 alphanumeric characters (e.g., `s-a1b`). Check existing story files to avoid ID collisions.

Story JSON structure:

```json
{
  "id": "s-a1b",
  "title": "Implement login form",
  "description": "Build the login UI with email and password fields",
  "planRef": "projects/auth-system/20260128-auth-system.plan.md",
  "todoRef": "xyz",
  "status": "pending",
  "priority": 1,
  "tests": ["t-001"],
  "blockedBy": [],
  "created": "2026-01-28T10:00:00Z",
  "updated": "2026-01-28T10:00:00Z",
  "notes": [],
  "files": ["src/components/LoginForm.tsx"],
  "acceptanceCriteria": [
    "Form displays email and password fields",
    "Submit button triggers authentication",
    "Error messages display on failure"
  ]
}
```

Key fields to set carefully during planning:
- `priority` — lower number = higher priority; determines build order
- `blockedBy` — list story IDs that must complete before this one can start
- `acceptanceCriteria` — these are immutable after planning; write them precisely
- `tests` — list the test IDs that verify this story

#### Story Sizing Guidelines

Use these as rough guides:
- **Small (S)** — less than 1 hour: single file change, documentation update, simple bug fix, configuration change
- **Medium (M)** — 1 to 4 hours: new module under 200 lines, test suite, feature implementation, single-module refactor
- **Large (L)** — more than 4 hours: architectural change, major refactor, complex feature, system integration, breaking change

If a story is Large, consider whether it can be split into two Medium stories with a dependency between them.

### Step 6: Write Tests (Critical)

Tests written during planning are IMMUTABLE during build. Write them with care — they define the contract that the implementation must satisfy.

For each test, create `projects/<feature-name>/tests/t-{id}.json`.

Test ID format: `t-` prefix + 3-digit zero-padded number (e.g., `t-001`). Check existing test files to avoid ID collisions.

Test JSON structure:

```json
{
  "id": "t-001",
  "title": "Login with valid credentials",
  "description": "Verify the successful login flow end to end",
  "storyRefs": ["s-a1b"],
  "planRef": "projects/auth-system/20260128-auth-system.plan.md",
  "type": "story",
  "status": "pending",
  "steps": [
    {
      "order": 1,
      "action": "Open login page",
      "expected": "Login form is visible with email and password fields"
    },
    {
      "order": 2,
      "action": "Enter a valid email and password",
      "expected": "Fields accept input without error"
    },
    {
      "order": 3,
      "action": "Click the login button",
      "expected": "User is redirected to the dashboard"
    }
  ],
  "created": "2026-01-28T10:00:00Z",
  "executedAt": null,
  "result": null
}
```

#### Writing Good Test Steps

Each step has two parts — `action` (what to do) and `expected` (what should happen). Write both from the user's perspective as identified in Step 3:

- **Human user**: Steps describe what the human does and what they observe
- **Claude Code user**: Steps describe what skill or tool is invoked and what files or outputs result
- **External system**: Steps describe HTTP requests sent and responses received

Make `expected` values specific and observable. Avoid vague criteria like "it works" — instead write "Response status is 200 and body contains `{ id: string }`."

#### Coverage Requirements

- Every must-have requirement in the spec → at least one story
- Every story → at least one test
- Each test must have at least 2 steps (action + verification)
- Consider adding integration-level tests that span multiple stories

#### Confirm Red State

Before declaring planning complete, mentally walk through each test's steps against the current codebase. The steps should fail — the feature does not exist yet. If a test would already pass without any implementation, that test is not testing anything useful and needs to be revised.

Document in the plan.md: "Tests: X tests written, all expected to fail before implementation (red state confirmed)."

### Step 7: Create Plan.md

Use this structure:

```markdown
# Plan: [Feature Name]

**Spec**: projects/<feature-name>/YYYYMMDD-feature.spec.md
**To-Do**: [id] (if applicable)
**Created**: YYYY-MM-DD

## Technical Approach

[Architecture decisions, key patterns, design rationale]

## User Perspective

**Primary User**: [Human | Claude Code | External System | Hybrid]
**How They Interact**: [Describe actual usage]
**Test Approach**: Tests simulate the user's actual interaction pattern

## Stories

| ID | Title | Priority | Size | Tests |
|----|-------|----------|------|-------|
| s-a1b | Implement login form | 1 | M | t-001 |
| s-c2d | Create session management | 2 | M | t-002 |

## Dependencies

[Story dependency graph if the order is non-obvious]

## Files to Create/Modify

[List with purposes]

## Notes

[Any additional context the build phase will need]
```

### Step 8: Link to To-Do

If this plan was created from a to-do, add the to-do ID to each story's `todoRef` field and note the linkage in the plan.md header. This allows the build phase to update the parent to-do when the plan completes.

### Step 9: Run Validation

Run `/validate` to check:
- All must-have spec requirements are covered by at least one story
- All stories have at least one test
- No unresolved open questions are blocking progress
- Plan.md is complete and well-formed

### Step 10: Run Review

Run `/review` to sanity-check the plan with Bob (devil's advocate sub-agent). For plans involving shared work (skills, daemon features, agent-comms), also request peer review before building. See the `/review` Peer Review Protocol for when this is required.

### Step 11: Confirm and Suggest Next Steps

```
Created plan: projects/feature-name/20260128-feature-name.plan.md
Stories: 5 created (projects/feature-name/stories/)
Tests: 8 created (projects/feature-name/tests/)
Validation: PASSED

Next steps:
  1. Review plan for completeness
  2. Run /build projects/feature-name/20260128-feature-name.plan.md to start implementation
```

---

## Update Workflow (Adding Stories to an Existing Plan)

### Step 1: Parse the Description

Extract the intent from the command:

```
/plan add implement login form validation
→ description = "implement login form validation"
```

### Step 2: Determine Target Plan

First, check the current conversation for references to a plan file. If the plan context is clear, use that file. If it is ambiguous, list the files in `projects/` and ask the user to confirm which plan to update.

### Step 3: Extract Story Details

From the description, determine:
- **Title**: The main action in title case ("Implement Login Form Validation")
- **Size**: Estimate S/M/L based on the scope
- **Dependencies**: Does this story depend on any existing stories?
- **Acceptance criteria**: What specific behaviors define completion?

### Step 4: Create the Story JSON

Generate a new story ID (check existing files to avoid collisions). Create `projects/<feature-name>/stories/s-{id}.json` with status `"pending"` and the details extracted above.

### Step 5: Create Any New Tests

If the new story introduces new behavior that is not covered by existing tests, create the test JSON files in `projects/<feature-name>/tests/`. Follow the same standards as the creation workflow — steps must be specific and observable.

### Step 6: Update Plan.md

Use the Edit tool to add the new story to the Stories table in plan.md. Do not remove or reorder existing rows.

### Step 7: Confirm

```
Added story s-x9z: "Implement login form validation" (Size: M)
  Plan: projects/auth-system/20260128-auth-system.plan.md
  Tests: t-012 created
```

---

## Task Sizing Guidelines

**Small (S)** — less than 1 hour:
- Single file changes
- Documentation updates
- Simple bug fixes
- Adding logging or comments
- Configuration changes

**Medium (M)** — 1 to 4 hours:
- New modules (under 200 lines)
- Test suites
- Feature implementations
- Refactoring a single module
- Integration with an existing system

**Large (L)** — more than 4 hours:
- Architectural changes
- Major refactoring across many files
- Complex features with many moving parts
- System-level integrations
- Breaking changes requiring migration

If a story is Large, consider splitting it. Smaller stories are easier to track, easier to regress, and less likely to get stuck.

---

## Story Dependency Rules

Set `blockedBy` on a story when:
- It needs the output of another story to function
- It modifies code that the blocking story is creating
- Its tests depend on functionality delivered by the blocking story
- The implementation order matters for correctness

Keep the dependency graph as shallow as possible. Long dependency chains slow down build progress and create bottlenecks.

---

## Error Handling

### Creation Workflow

- **Spec file missing**: Report the error and stop — cannot plan without a spec
- **Spec has unresolved open questions**: Warn the user; consider resolving questions before committing to the plan
- **ID collision on story or test**: Increment until a unique ID is found
- **Plan directory missing**: Create `projects/<feature-name>/stories/` and `projects/<feature-name>/tests/` if they do not exist

### Update Workflow

- **Plan not found**: Ask the user to specify the correct plan file or create a new one
- **Story JSON write fails**: Report the error clearly; do not update plan.md until the story file is saved successfully
- **Edit to plan.md fails**: Report the error and suggest manually adding the story row

---

## Integration

- **Stories** (`projects/<feature-name>/stories/s-{id}.json`): Core work units consumed by `/build`
- **Tests** (`projects/<feature-name>/tests/t-{id}.json`): Verification criteria, immutable during build
- **Validation** (`/validate`): Checks coverage and completeness before build begins
- **Review** (`/review`): Bob sub-agent challenges the plan; peer review for shared work
- **Build** (`/build`): Works through stories in priority order, verifying tests at each step
- **To-Dos**: Plans reference parent to-dos via `todoRef`; build updates them on completion
