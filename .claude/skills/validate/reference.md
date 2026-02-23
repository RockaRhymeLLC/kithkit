# Validate Reference

Detailed documentation for multi-layer validation.

## Purpose

Validate alignment between spec, plan, and implementation at every workflow phase.

## Validation Layers

### Layer 1: Spec Completeness

**Check that spec file contains:**
- Goal statement (## Goal section with content)
- Must-have requirements (### Must Have with at least one `- [ ]` item)
- Success criteria (## Success Criteria with numbered items)
- Resolved open questions (## Open Questions should be empty or have all items checked)

**How to check:**
1. Read the spec file
2. Parse sections
3. Verify required content exists

**Pass criteria:**
- Goal section has content
- At least 1 must-have requirement
- At least 1 success criterion
- No unchecked open questions

### Layer 2: Plan Completeness

**Check that plan file contains:**
- Spec reference (links to existing spec file)
- Technical approach (## Technical Approach section)
- Tasks defined (with acceptance criteria)
- Files listed (what will be created/modified)

**How to check:**
1. Read the plan file
2. Extract spec path, verify file exists
3. Check for required sections
4. Verify tasks have acceptance criteria

**Pass criteria:**
- Spec file reference exists and file is found
- Technical approach section present
- At least 1 task defined
- Each task has acceptance criteria

### Layer 3: Spec-Plan Alignment

**Verify:**
- Each must-have requirement has a corresponding task
- Tasks address the spec's stated goal
- No orphan tasks (tasks without spec backing)

**How to check:**
1. Extract requirements from spec
2. Extract tasks from plan
3. Map requirements to tasks
4. Report coverage percentage

**Pass criteria:**
- 100% of must-have requirements mapped to tasks
- All tasks traceable to requirements

### Layer 4: Implementation Review

**Only runs after build phase. Check:**
- Files listed in plan were created/modified
- Implementation matches task descriptions
- Acceptance criteria are met

**How to check:**
1. Read the plan's file list
2. Verify files exist
3. Read implementation
4. Compare against acceptance criteria

**Pass criteria:**
- All planned files exist
- Acceptance criteria satisfied

### Layer 5: AI Self-Review

**Honest assessment of implementation:**
- Does it solve the problem stated in the spec?
- Are edge cases handled appropriately?
- Is error handling present where needed?
- Are there obvious bugs or issues?
- Would you approve this in a code review?

**How to check:**
1. Read spec goal and requirements
2. Read implementation files
3. Critically evaluate
4. Report any concerns

**Pass criteria:**
- Implementation solves the stated problem
- No critical issues identified
- Code is maintainable

### Layer 6: Documentation Freshness (Post-Build)

**If the spec has a Documentation Impact section:**
- Read the Documentation Impact checklist
- For each listed doc (CLAUDE.md, SKILL.md files, README.md, kithkit.config.yaml):
  - Check if the file was modified since the build started (git diff or timestamp)
  - If not modified, flag as potentially stale
- If no Documentation Impact section, check common docs heuristically:
  - New skill added → CLAUDE.md skills table updated?
  - Config changes → kithkit.config.yaml documented?
  - New behavior → CLAUDE.md Core Behaviors section current?

**How to check:**
1. Read the spec's Documentation Impact section (if present)
2. For each listed doc, check modification time vs build start
3. Flag docs that weren't updated
4. If no Documentation Impact section, apply heuristic checks

**Pass criteria:**
- PASS: All listed docs were updated
- WARN: Some docs flagged as potentially stale
- SKIP: No documentation impact expected (pre-build or no doc changes)

### Layer 7: Manual Review

**Present summary to user:**
- What was validated
- What passed/failed
- Any warnings or concerns (including doc freshness flags)
- Request approval to proceed

**Pass criteria:**
- User approves

## Output Format

```
## Validation Results

### Layer 1: Spec Completeness
- Goal: Found
- Must-have requirements: 5
- Success criteria: 3
- Open questions: 0
Result: PASS

### Layer 2: Plan Completeness
- Spec reference: Found (specs/20260127-feature.spec.md)
- Technical approach: Found
- Tasks: 4 defined
- Acceptance criteria: All tasks have criteria
Result: PASS

### Layer 3: Spec-Plan Alignment
- Requirements covered: 5/5 (100%)
- Orphan tasks: 0
Result: PASS

### Layer 4: Implementation Review
- Files created: 3/3
- Acceptance criteria met: 4/4
Result: PASS

### Layer 5: AI Self-Review
- Solves stated problem: Yes
- Edge cases: Handled
- Error handling: Present
- Code quality: Good
Result: PASS

### Layer 6: Documentation Freshness
- Spec lists doc impact: CLAUDE.md (skills table), setup SKILL.md
- CLAUDE.md: Modified (verified)
- setup SKILL.md: Modified (verified)
Result: PASS

### Layer 7: Manual Review
Summary presented. Awaiting approval.

---
Overall: 6/7 layers passed, awaiting manual approval
```

## When to Skip Layers

- **Layer 4 (Implementation)**: Skip if no implementation exists yet (planning phase)
- **Layer 5 (AI Review)**: Skip if no implementation exists yet
- **Layer 6 (Documentation Freshness)**: Skip if pre-build or no documentation impact expected
- **Layer 7 (Manual)**: Always runs last, presents summary

## Error Handling

When a layer fails:
1. Stop validation
2. Report which layer failed
3. Explain what's missing or wrong
4. Suggest specific fixes
5. Do NOT proceed to next phase

Example failure:
```
### Layer 3: Spec-Plan Alignment
- Requirements covered: 3/5 (60%)
- Missing coverage:
  - "System must validate user input" (no task found)
  - "System must log all errors" (no task found)
Result: FAIL

Action needed:
Add tasks in the plan for the missing requirements,
or update the spec to remove these requirements if they're no longer needed.
```

## Best Practices

1. Run validation after each workflow phase
2. Fix issues before proceeding
3. Don't skip the manual review
4. Re-run validation after making fixes
