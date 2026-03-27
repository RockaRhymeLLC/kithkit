---
name: build
description: Implement features by working through stories and verifying tests. Use after planning is complete, ready for implementation.
argument-hint: [plan-file or build request]
---

# /build - Story-Driven Implementation

Implement features by working through stories in priority order, verifying each test step.

## Purpose

Execute the plan by:
1. Working through stories in priority order
2. Implementing to satisfy acceptance criteria
3. Verifying test steps
4. Updating story status and notes

## Usage

### Execute Plan
```bash
/build <plan-file-path>
```
Examples:
- `/build plans/20260128-auth-system.plan.md`
- `/build plans/20260128-api-integration.plan.md`

### Resume Build
```bash
/build
```
Continues from the active plan's in-progress story.

## Workflow

1. **Pre-build checks** (via hook)
   - Verify plan file exists
   - Verify spec file exists

2. **Load plan context**
   - Read plan.md
   - Load all stories from `plans/stories/`
   - Load all tests from `plans/tests/`

3. **For each story (by priority):**

   **Step 1: Initial test (should fail)**
   - Run the story's test(s)
   - Confirm they fail (expected - not implemented yet)

   **Step 2: Implement**
   - Update story status to `in-progress`
   - Read acceptance criteria
   - Implement the required functionality
   - Add notes as you progress

   **Step 3: Verify test passes**
   - Run the story's test(s) again
   - All steps must pass

   **Step 4: Regression check**
   - Pick 2 tests from OTHER completed stories (at random)
   - Run both regression tests
   - Both must pass (ensures new code didn't break existing work)
   - If regression fails: Fix before continuing

   **Step 5: Complete**
   - If all tests pass (story + regression): Mark story `completed`
   - If blocked: Update status to `blocked`, add note explaining why

4. **Post-build**
   - Run /validate
   - Offer to create git commit
   - Update parent to-do if applicable

## Working with Stories

### Reading a Story

Load from `plans/stories/s-{id}.json`:
- Check `status` - is it pending or blocked?
- Check `blockedBy` - are dependencies complete?
- Read `acceptanceCriteria` - what defines done?
- Read `tests` - which tests verify this story?

### Updating a Story

**You CAN update during /build:**
- `status`: pending → in-progress → completed (or blocked)
- `updated`: Current timestamp
- `notes`: Add progress notes
- `files`: Add files you created/modified

**You CANNOT update:**
- `acceptanceCriteria` (would require user approval)
- `tests` (test definitions are immutable)

### Story Status Flow

```
pending → in-progress → completed
              ↓
           blocked (with note explaining why)
```

## Working with Tests

### Verifying a Test

Load from `plans/tests/t-{id}.json`:
1. Read each step in order
2. Perform the `action`
3. Verify the `expected` result
4. If all steps pass: Update test `status` to `passed`
5. If any step fails: Update test `status` to `failed`, record `failedStep`

### Test Immutability

**CRITICAL: Tests are IMMUTABLE during /build**

You can only update:
- `status`: pending → passed | failed
- `executedAt`: When you ran the test
- `result`: Pass/fail details

You CANNOT modify:
- `steps` (the actions and expected results)
- `title`, `description`
- Any test definition

**If a test is wrong:**
1. STOP the build
2. Explain what's wrong with the test
3. Request user approval to modify
4. Return to /plan phase to fix

## Example Build Session

```
## Building: auth-system

### Story s-a1b: Implement login form (Priority 1)

Step 1: Initial test (expect failure)
Running test t-001: Login with valid credentials
- Step 1: Open login page ✗ (page doesn't exist yet)
Test failed as expected (not implemented).

Step 2: Implementing...
Status: pending → in-progress
- Created src/components/LoginForm.tsx
- Added email/password fields
- Connected submit handler
Added note: "Implemented login form with validation"

Step 3: Verify test passes
Running test t-001: Login with valid credentials
- Step 1: Open login page ✓
- Step 2: Enter valid credentials ✓
- Step 3: Click login button ✓
Test passed.

Step 4: Regression check
(First story - no completed stories yet, skipping regression)

Step 5: Complete
Story s-a1b: in-progress → completed

---

### Story s-c2d: Create session management (Priority 2)

Step 1: Initial test (expect failure)
Running test t-002: Session persists on refresh
- Step 1: Log in ✓
- Step 2: Refresh page ✗ (session lost)
Test failed as expected.

Step 2: Implementing...
Status: pending → in-progress
- Created src/auth/session.ts
- Added session storage logic
Added note: "Implemented session persistence"

Step 3: Verify test passes
Running test t-002: Session persists on refresh
- Step 1: Log in ✓
- Step 2: Refresh page ✓
- Step 3: User still logged in ✓
Test passed.

Step 4: Regression check
Running 2 random tests from completed stories...
- t-001 (from s-a1b): Login with valid credentials ✓
(Only 1 completed story, running its test)
Regression passed.

Step 5: Complete
Story s-c2d: in-progress → completed
```

## Progress Notes

Add notes to stories as you work:

```json
{
  "notes": [
    {
      "timestamp": "2026-01-28T14:30:00Z",
      "content": "Started implementing login form"
    },
    {
      "timestamp": "2026-01-28T15:00:00Z",
      "content": "Added validation, form submits correctly"
    }
  ]
}
```

Notes help with:
- Context recovery after session break
- Audit trail of decisions
- Debugging if something goes wrong

## Regression Testing

After each story's tests pass, run regression tests before marking complete:

### Rules
- Pick **2 tests at random** from OTHER completed stories
- If fewer than 2 completed stories exist, run what's available (0 or 1)
- Both regression tests must pass
- If regression fails: Stop, fix the regression, re-run

### Why
- Ensures new code doesn't break existing functionality
- Catches integration issues early
- Simple, lightweight approach to continuous validation

### On Regression Failure

```
Step 4: Regression check
Running 2 random tests from completed stories...
- t-001 (from s-a1b): Login with valid credentials ✗
  Step 3 failed: Expected redirect to dashboard, got error page

REGRESSION FAILURE: t-001 broke after implementing s-c2d

Action:
1. Identify what in s-c2d broke the login flow
2. Fix the regression
3. Re-run t-002 (current story test)
4. Re-run regression tests
5. Then mark s-c2d complete
```

## Handling Blockers

If you encounter a blocker:

1. Update story status to `blocked`
2. Add a note explaining the blocker
3. Check if another story can be worked on
4. If truly stuck, ask the user for help

```json
{
  "status": "blocked",
  "notes": [
    {
      "timestamp": "2026-01-28T16:00:00Z",
      "content": "Blocked: Need API credentials to test authentication"
    }
  ]
}
```

## Integration

- **Stories**: `plans/stories/s-{id}.json` - work units
- **Tests**: `plans/tests/t-{id}.json` - verification criteria
- **To-Dos**: Parent to-do gets updated when plan completes
- **Validation**: /validate runs automatically post-build
- **Git**: Commit offered after successful build

See `reference.md` for detailed schemas.
