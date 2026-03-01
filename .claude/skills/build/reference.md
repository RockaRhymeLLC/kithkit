# Build Workflow Reference

Detailed instructions for test-driven implementation and build management.

## Full Build Workflow

### Step 1: Pre-Build Validation (Automatic)

Validation hook runs automatically to verify:
- Spec exists and is complete
- Plan exists and is complete
- Tests are written and failing (red state)
- No unresolved open questions
- All requirements mapped to tasks

If validation fails, build is blocked.

### Step 2: Read and Understand

**Read the Spec**:
```typescript
const specPath = plan.spec;
const spec = await readFile(specPath);
```
Understand: goal, requirements, constraints, success criteria

**Read the Plan**:
```typescript
const planContent = await readFile(planPath);
```
Understand: technical approach, user perspective, tasks, dependencies

**Read the Tests**:
```typescript
const testPath = `tests/${featureName}.test.ts`;
const tests = await readFile(testPath);
```
**CRITICAL**: Understand what tests expect. Tests define the contract.

### Step 3: Verify User Perspective

From plan, identify WHO the user is:
- Human → Implementation handles CLI/UI input
- Claude Code → Implementation handles skill invocation
- External System → Implementation handles API requests
- Hybrid → Implementation handles multiple interfaces

**Tests are written from this perspective** - implementation must match.

### Step 4: Test Integrity Check

Verify tests haven't been modified since plan phase:
- Check file timestamps
- Review git history if available
- Compare with plan documentation

**If tests were modified during build → CRITICAL FAILURE**
- Stop immediately
- Return to planning phase
- Fix tests in plan
- Restart build with corrected tests

### Step 5: Implement Tasks

For each task in dependency order:

#### 5.1: Select Next Task
```typescript
const tasks = TaskList();
const nextTask = tasks.find(t =>
  t.status === 'pending' &&
  t.blockedBy.length === 0
);
```

#### 5.2: Mark Task In Progress
```typescript
TaskUpdate({
  taskId: nextTask.id,
  status: 'in_progress'
});
```

#### 5.3: Implement

**Read the tests for this task**:
```typescript
// Find tests related to this task
const taskTests = findTestsForTask(nextTask);
```

**Implement smallest change to make tests pass**:
- Start simple
- Make one test pass at a time
- Refactor only after green
- Keep changes focused

**Run tests frequently**:
```bash
npm test -- feature-name.test.ts
```

**When tests fail**:
- Read error messages carefully
- Fix IMPLEMENTATION, never tests
- Tests are immutable - they define what's correct
- If tests seem wrong, STOP and return to planning

#### 5.4: Mark Task Complete
```typescript
// Only after tests pass
TaskUpdate({
  taskId: nextTask.id,
  status: 'completed'
});
```

#### 5.5: Move to Next Task

Repeat until all tasks completed.

### Step 6: Run Validation

Automatically run `/validate` to verify:
- All tests passing (green state)
- All spec requirements covered
- Tests unchanged since plan (test integrity)
- AI self-review passes
- Ready for manual review

### Step 7: Create Git Commit (Optional)

Offer to create commit:
```
Add [feature name]

Implements [brief description]:
- [Key change 1]
- [Key change 2]
- [Key change 3]

Tests: X added (all passing)
Spec: specs/YYYYMMDD-feature-name.spec.md

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

### Step 8: Display Summary

```
✅ Build Complete!

Tasks: 5/5 completed
Tests: 24/24 passing
Files: 7 created, 2 modified

Next steps:
  1. Review implementation
  2. Test manually
  3. Deploy or integrate
```

## Build Request Workflow

### Step 1: Parse Request

Extract intent from command:
- "implement X" → New implementation
- "fix Y" → Bug fix/correction
- "refactor Z" → Code improvement
- "X first" / "priority X" → Prioritization
- "change X" → Modification

### Step 2: Check Context

```typescript
import { ContextTracker } from '../../src/context/tracker';

const tracker = new ContextTracker('.claude/state/context.json');
const activePlan = tracker.getActivePlan();
const activeSpec = tracker.getActiveSpec();
```

Check TaskList for current work:
```typescript
const tasks = TaskList();
const inProgress = tasks.filter(t => t.status === 'in_progress');
const pending = tasks.filter(t => t.status === 'pending');
```

### Step 3: Determine Action Type

#### New Implementation
If requesting new functionality not in tasks:
- Add task using `/plan` workflow
- Mark as in_progress if starting immediately
- Proceed with implementation

#### Fix/Modification
If requesting change to existing code:
- Identify affected file/module
- Make change directly
- Run tests to verify
- Update task status if applicable

#### Priority Change
If indicating priority ("first", "next"):
- Note the priority
- Switch to that task
- Mark as in_progress
- Start working immediately

#### Refactor
If requesting code improvement:
- Assess scope (S/M/L)
- If significant: add as task
- If minor: do inline
- Ensure tests still pass

### Step 4: Execute or Queue

**Execute Immediately** if:
- Request is clear
- No blockers
- Ready to implement

**Add to Queue** if:
- Needs planning first
- Has dependencies
- User wants to defer

### Step 5: Update State

```typescript
// Update context
tracker.setActivePlan(planPath);

// Log action
const logger = new HistoryLogger('.claude/history/commands.log');
logger.log('/build', activePlan || 'current-work', `Build request: ${description}`);
```

### Step 6: Confirm

```
▶ Working on: Implement coffee brewing module
  Task: #3 (in progress)
```

or

```
⚡ Added to queue: Refactor logger to use streams
  Task: #8 (pending)
```

## TDD Cycle

The core build loop:

```
1. RED:   Tests fail (before implementation)
   ↓
2. GREEN: Write minimal code to pass tests
   ↓
3. REFACTOR: Improve code while keeping tests green
   ↓
   Repeat for next test/task
```

**Never modify tests during build** - they define what "correct" means.

## Common Scenarios

### Tests Keep Failing

**DO**:
1. Read test error messages carefully
2. Check what test expects vs what code produces
3. Fix implementation to match expectations
4. Add debugging/logging if needed
5. Ask for help if stuck

**DON'T**:
- Modify tests to make them pass
- Skip failing tests
- Comment out assertions
- Change test expectations

### Tests Seem Wrong

**STOP** - tests might actually be wrong!

1. Review test against spec requirements
2. Check if test reflects user perspective
3. If test is genuinely wrong:
   - STOP build phase
   - Return to planning phase
   - Fix tests in plan
   - Re-run validation
   - Restart build with corrected tests

**Remember**: Tests are immutable during build, but if they're wrong, fix in planning phase.

### Need to Change API/Interface

If implementation reveals API should be different:

1. Check if tests cover the new API
2. If yes: implement the new API (tests define it)
3. If no: tests are incomplete
   - STOP build
   - Return to planning
   - Add tests for new API
   - Restart build

## Error Handling

### Build Errors
- **Compilation errors**: Fix syntax/type errors
- **Test failures**: Fix implementation
- **Dependency errors**: Install missing packages
- **Permission errors**: Check file/directory permissions

### Test Integrity Violations
If tests were modified during build:
1. Report CRITICAL violation
2. Show what changed (diff)
3. Explain TDD contract
4. STOP build immediately
5. Require return to planning

### Validation Failures
- Report which layer failed
- Provide fix guidance
- Block completion until resolved
- Re-run validation after fix

## Integration Points

**Task System**: Tracks progress, dependencies, completion
**ContextTracker**: Maintains current build state
**HistoryLogger**: Records all build actions and decisions
**Validation**: Quality gates before and after build
**Git**: Version control for completed features
**Tests**: The contract that defines correctness

## Best Practices

1. **Read tests first** - understand expectations before coding
2. **Small steps** - make one test pass at a time
3. **Run tests frequently** - catch errors early
4. **Keep focused** - implement only what tests require
5. **Refactor when green** - improve code after tests pass
6. **Never modify tests** - they're immutable during build
7. **Complete tasks** - finish before moving to next
8. **Validate often** - ensure quality throughout

## Remember

**Tests define the contract**. Your job during build is to fulfill that contract, not to change it. If the contract is wrong, fix it in the planning phase, not during build.
