---
name: plan
description: Create implementation plans with stories and tests using the spec-driven workflow. Use after completing a spec, ready for technical planning.
argument-hint: [spec-file or story description]
---

# /plan - Planning with Stories & Tests

Create implementation plans that break work into stories with testable acceptance criteria.

## Purpose

Define HOW to build features by creating:
1. **Plan document** (plan.md) - Technical approach and overview
2. **Stories** (JSON) - Work units with acceptance criteria
3. **Tests** (JSON) - Step-by-step verification criteria

## Usage

### Create New Plan
```bash
/plan <spec-file-path>
```
Examples:
- `/plan specs/20260127-telegram-integration.spec.md`
- `/plan specs/20260127-auth-system.spec.md`

### Add Story to Existing Plan
```bash
/plan add <story description>
```
Examples:
- `/plan add implement login form validation`
- `/plan add create session management module`

## Workflow: Create Plan

1. **Read spec file** - Understand requirements and constraints
2. **Design technical approach** - Architecture, patterns, decisions
3. **Create plan.md** - Document the approach in `plans/YYYYMMDD-feature.plan.md`
4. **Create stories** - One JSON per work unit in `plans/stories/`
5. **Create tests** - One JSON per test in `plans/tests/`
6. **Link to to-do** - If this plan was spawned from a to-do, add references
7. **Run /validate** - Verify completeness
8. **Run /review** - Sanity-check before building (Bob + optional R2 peer review)
9. **Peer review gate** - If this plan involves shared work (skills, daemon, upstream, agent-comms), request R2 peer review before building. See `/review` Peer Review Protocol
10. **Suggest /build** - Ready for implementation

## Output Structure

```
plans/
├── 20260128-auth-system.plan.md
├── stories/
│   ├── s-a1b.json    # "Implement login form"
│   ├── s-c2d.json    # "Create session management"
│   └── s-e3f.json    # "Add logout functionality"
└── tests/
    ├── t-001.json    # "Login with valid credentials"
    ├── t-002.json    # "Session persists on refresh"
    └── t-003.json    # "Logout clears session"
```

## Story Creation

For each story, create `plans/stories/s-{id}.json`:

```json
{
  "id": "s-a1b",
  "title": "Implement login form",
  "description": "Build the login UI with email/password fields",
  "planRef": "plans/20260128-auth-system.plan.md",
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

## Test Creation

For each test, create `plans/tests/t-{id}.json`:

```json
{
  "id": "t-001",
  "title": "Login with valid credentials",
  "description": "Verify successful login flow",
  "storyRefs": ["s-a1b"],
  "planRef": "plans/20260128-auth-system.plan.md",
  "type": "story",
  "status": "pending",
  "steps": [
    {
      "order": 1,
      "action": "Open login page",
      "expected": "Login form is visible"
    },
    {
      "order": 2,
      "action": "Enter valid email and password",
      "expected": "Fields accept input"
    },
    {
      "order": 3,
      "action": "Click login button",
      "expected": "User redirected to dashboard"
    }
  ],
  "created": "2026-01-28T10:00:00Z",
  "executedAt": null,
  "result": null
}
```

## ID Generation

- **Stories**: `s-` prefix + 3 alphanumeric chars (e.g., `s-a1b`)
- **Tests**: `t-` prefix + 3-digit number (e.g., `t-001`)

Check existing IDs to avoid collisions.

## Key Principles

**Tests are immutable during build:**
- Write comprehensive tests during /plan
- Tests define the contract
- Cannot modify test steps during /build
- Implementation must satisfy tests, not vice versa

**Stories are updatable:**
- Status changes as work progresses
- Notes added during implementation
- Files list may grow

**Every requirement needs coverage:**
- Each must-have requirement → at least one story
- Each story → at least one test
- Feature-level tests for integration

## Plan.md Template

```markdown
# Plan: [Feature Name]

**Spec**: specs/YYYYMMDD-feature.spec.md
**To-Do**: [id] (if applicable)
**Created**: YYYY-MM-DD

## Technical Approach

[Describe the architecture, patterns, and key decisions]

## Stories

| ID | Title | Priority | Tests |
|----|-------|----------|-------|
| s-a1b | Implement login form | 1 | t-001 |
| s-c2d | Create session management | 2 | t-002 |

## Dependencies

[Story dependency graph if complex]

## Files

[List of files to create/modify]

## Notes

[Any additional context]
```

## Integration

- **To-Do system**: Plans can reference parent to-do via `todoRef`
- **Validation**: /validate checks story-test coverage
- **Review**: /review runs Bob (devil's advocate) + optional R2 peer review before /build
- **Peer review**: Plans for shared work must go through R2 before building (see `/review` Peer Review Protocol)
- **Build**: /build works through stories in priority order

See `reference.md` for detailed schemas.
