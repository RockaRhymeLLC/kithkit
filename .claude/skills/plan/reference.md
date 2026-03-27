# Plan Workflow Reference

Detailed step-by-step instructions for creating plans and managing tasks.

## Creation Workflow

### Step 1: Validate Input

```typescript
// Check spec file provided
if (!args.includes('specs/')) {
  throw new Error('Spec file path required');
}

// Read and verify spec exists
const specPath = args;
const specContent = await readFile(specPath);
```

### Step 2: Analyze Specification

Parse the spec to extract:
- **Must Have requirements** - Core features (highest priority)
- **Should Have requirements** - Nice-to-haves (medium priority)
- **Constraints** - Security, performance, compatibility
- **Success criteria** - Measurable outcomes
- **User stories** - Usage scenarios
- **Open questions** - Unresolved decisions

### Step 3: Identify User Perspective

**Critical**: Determine WHO will use this feature:

| User Type | Examples | Test Approach |
|-----------|----------|---------------|
| **Human** | CLI commands, web UI, API calls | Test command output, UI behavior, API responses |
| **Claude Code** | Skills, workflows, internal tools | Test skill invocation, file outputs, tool usage |
| **External System** | APIs, webhooks, integrations | Test HTTP requests/responses, data formats |
| **Hybrid** | Multiple user types | Test all interaction patterns |

**Document in plan**:
```markdown
## User Perspective

**Primary User**: [Human | Claude Code | External System | Hybrid]

**How They Interact**:
- [Describe actual usage]

**Test Approach**:
Tests will simulate the user's actual interaction pattern
```

### Step 4: Technical Planning

#### Architecture Decisions
Consider:
- Libraries/frameworks needed
- Design patterns appropriate
- Integration points
- Performance implications
- Security considerations

**Document as**:
```markdown
## Technical Approach

### Architecture Overview
[High-level design]

### Key Components
1. **Component A** - Purpose and responsibilities
2. **Component B** - Purpose and responsibilities

### Design Decisions
**Why X instead of Y?**
- Reason 1
- Reason 2
```

#### File Planning
Identify:
```markdown
## Files to Create/Modify

### New Files
- `src/module/file.ts` - Purpose
- `tests/module.test.ts` - Test coverage

### Modified Files
- `src/existing.ts` - What changes and why
```

### Step 5: Task Breakdown

Break work into discrete tasks using TaskCreate:

```typescript
import { TaskCreate } from '@claude/tasks';

// For each logical unit of work:
TaskCreate({
  subject: "Create context tracker module",
  description: "Build simple TypeScript module to persist active spec/plan...",
  activeForm: "Creating context tracker module"
});
```

**Task Guidelines**:
- **Size**:
  - S (Small): < 1 hour, single file, straightforward
  - M (Medium): 1-4 hours, multiple files, moderate complexity
  - L (Large): > 4 hours, architectural changes, high complexity
- **Granularity**: Each task should be independently completable
- **Dependencies**: Note what must be done first
- **Testing**: Specify which tests must pass

**Set Dependencies**:
```typescript
TaskUpdate({
  taskId: "4",
  addBlockedBy: ["2", "3"] // Task 4 blocked by tasks 2 and 3
});
```

### Step 6: Write Tests (Critical!)

**IMPORTANT**: Tests written during plan phase are IMMUTABLE during build.

#### Test Structure
```typescript
/**
 * Tests for: [Feature Name]
 * Spec: [link to spec]
 * Plan: [link to plan]
 *
 * Tests are written from USER'S perspective.
 * IMMUTABLE during build phase.
 */

describe('[Feature Name]', () => {
  it('should [expected behavior from user perspective]', () => {
    // Arrange: Set up user's context

    // Act: Perform action as user would

    // Assert: Verify outcome user would see
    expect(result).toBe(expected);
  });
});
```

#### Write Tests from User Perspective

**Human User**:
```typescript
it('should respond to Telegram command', async () => {
  // Simulate user sending Telegram message
  await bot.sendMessage(userId, '/help');

  // Verify user receives response
  expect(lastMessageSent).toContain('Available commands');
});
```

**Claude Code User**:
```typescript
it('should update spec via skill', () => {
  // Invoke skill as Claude would
  invokeSkill('spec-update', 'add breakfast feature');

  // Verify file was updated
  const spec = readFile('specs/test.spec.md');
  expect(spec).toContain('Breakfast feature');
});
```

**External System User**:
```typescript
it('should handle API request', async () => {
  // Make API call as external system would
  const response = await fetch('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ task: 'New task' })
  });

  // Verify response format
  expect(response.status).toBe(201);
  expect(response.data).toHaveProperty('id');
});
```

#### Ensure Tests Fail (Red State)
- Tests must fail before implementation exists
- This proves tests are actually testing something
- Run `npm test` to verify red state
- Document in plan: "Tests: X tests written, all failing (red state ✓)"

### Step 7: Create Plan File

Use plan template structure:
```markdown
# Plan: [Feature Name]

**Created**: YYYY-MM-DD
**Spec**: [link to spec]
**Status**: Planning

## Technical Approach
[Architecture decisions]

## User Perspective
**Primary User**: [type]
**How They Interact**: [details]
**Test Approach**: [how tests simulate user]

## Files to Create/Modify
[List with purposes]

## Tasks
- [ ] **Task 1**: [description] (Size: S/M/L)
  - **Dependencies**: [task numbers]
  - **Tests**: [which tests]
  - **Acceptance**: [completion criteria]

## Test Plan
**Location**: tests/feature.test.ts
**IMPORTANT**: Tests written from user's perspective, IMMUTABLE during build

### Test Cases
[List all test cases with setup/action/assert]

## Validation Checklist
[Pre-build validation items]

## Rollback Plan
[How to undo if needed]
```

### Step 8: Update Context and Log

```typescript
import { ContextTracker } from '../../src/context/tracker';
import { HistoryLogger } from '../../src/history/logger';

// Set active plan
const tracker = new ContextTracker('.claude/state/context.json');
tracker.setActivePlan(planPath);

// Also set active spec if not already set
if (!tracker.getActiveSpec()) {
  tracker.setActiveSpec(specPath);
}

// Log creation
const logger = new HistoryLogger('.claude/history/commands.log');
logger.log('/plan', planPath, `Created plan for ${featureName}`);
```

### Step 9: Run Validation

Automatically run `/validate` to check:
- All spec requirements mapped to tasks
- Tests written and failing (red state)
- No unresolved open questions blocking progress
- Plan is complete and ready for build

### Step 10: Confirm and Suggest Next Steps

```
✓ Created plan: plans/20260127-feature-name.plan.md
✓ Tasks created: 5 tasks added to TaskList
✓ Tests written: tests/feature-name.test.ts (RED state ✓)
✓ Validation: PASSED

Next steps:
  1. Review plan for completeness
  2. Run `/build plans/20260127-feature-name.plan.md` to start implementation
```

## Update Workflow

### Step 1: Parse Task Description

Extract from command:
```
/plan add unit tests for breakfast module
→ description = "add unit tests for breakfast module"
```

### Step 2: Determine Target Plan

#### Check Context
```typescript
const tracker = new ContextTracker('.claude/state/context.json');
const activePlan = tracker.getActivePlan();
```

#### Infer if Needed
- Review conversation for plan references
- List files in `plans/` directory
- Match description to plan titles

#### Ask if Ambiguous
```typescript
const plans = listPlanFiles('plans/');
// Use AskUserQuestion to let user select
```

### Step 3: Extract Task Details

Parse the description to determine:

**Subject**: Main action
- "Add unit tests for breakfast module"
- "Implement coffee brewing logic"
- "Refactor context tracker"

**Size**: Estimate complexity
- **S**: "Add logging", "Update documentation"
- **M**: "Add unit tests", "Implement module"
- **L**: "Refactor architecture", "Add integration"

**Active Form**: Present continuous
- "Add unit tests" → "Adding unit tests"
- "Implement coffee" → "Implementing coffee brewing"
- "Refactor tracker" → "Refactoring context tracker"

### Step 4: Add to Plan File

Read plan and add task:
```markdown
## Tasks

- [ ] **Task 1**: Existing task (Size: S)
  - **Dependencies**: None
  - **Tests**: Test suite A
  - **Acceptance**: Feature works

- [ ] **Task 2**: Add unit tests for breakfast module (Size: M)  ← NEW
  - **Dependencies**: None
  - **Tests**: Breakfast test suite
  - **Acceptance**: 90%+ test coverage
```

Use Edit tool to preserve existing content.

### Step 5: Add to TaskList

```typescript
TaskCreate({
  subject: "Add unit tests for breakfast module",
  description: "Write comprehensive unit tests for the breakfast module...",
  activeForm: "Adding unit tests for breakfast module"
});
```

### Step 6: Update Context and Log

```typescript
// Update context
tracker.setActivePlan(planPath);

// Log change
logger.log('/plan', path.basename(planPath), `Added task: ${subject}`);
```

### Step 7: Confirm

```
✓ Added Task #5: "Add unit tests for breakfast module" (Size: M)
  Plan: plans/20260127-breakfast-maker.plan.md
  TaskList: #5
```

## Task Management Best Practices

### Task Sizing

**Small (S)** - < 1 hour:
- Single file changes
- Documentation updates
- Simple bug fixes
- Adding logs/comments
- Configuration changes

**Medium (M)** - 1-4 hours:
- New modules (< 200 lines)
- Test suites
- Feature implementations
- Refactoring single modules
- Integration work

**Large (L)** - > 4 hours:
- Architecture changes
- Major refactoring
- Complex features
- System integrations
- Breaking changes

### Task Dependencies

**Set dependencies when**:
- Task B needs Task A's output
- Task B modifies Task A's code
- Task B tests Task A's functionality
- Order matters for correctness

**Example**:
```typescript
// Task 2 depends on Task 1
TaskUpdate({
  taskId: "2",
  addBlockedBy: ["1"]
});
```

### Task Descriptions

Good descriptions include:
- What to build
- Why it's needed
- Key considerations
- Acceptance criteria

**Example**:
```
Build simple TypeScript module to persist active spec/plan context.
Reads/writes to .claude/state/context.json.
Methods: getActiveSpec(), setActiveSpec(path), getActivePlan(), setActivePlan(path), clear().
Schema: { activeSpec, activePlan, lastCommand, timestamp }.
Module should be in src/context/tracker.ts
```

## Error Handling

### Creation Workflow
- **Spec file missing**: Report error, cannot proceed
- **Spec incomplete**: Warn about open questions, suggest resolving first
- **Template missing**: Use default structure
- **Test file creation fails**: Report error, block build phase

### Update Workflow
- **Plan not found**: Ask user to create plan or select different file
- **TaskCreate fails**: Still update plan file, warn about TaskList sync
- **Edit fails**: Report error, suggest manual edit

## Integration Points

**TaskCreate/TaskUpdate**: Core task management
**ContextTracker**: Remembers active plan
**HistoryLogger**: Audit trail
**Validation**: Ensures readiness for build
**Build Phase**: Consumes plan and executes tasks
