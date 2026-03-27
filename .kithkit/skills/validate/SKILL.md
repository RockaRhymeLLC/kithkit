---
name: validate
description: Run multi-layer validation to ensure spec, plan, and implementation alignment. Use to check quality at any workflow phase.
argument-hint: [plan-file]
---

# /validate - Multi-Layer Validation

Run comprehensive validation checks to ensure specifications, plans, and implementations are properly aligned.

## Usage

```bash
/validate [plan-file-path]
```

Examples:
- `/validate` - Validate current state (finds most recent plan)
- `/validate plans/20260127-feature.plan.md` - Validate specific plan

## Validation Layers

Execute each layer in order. All must pass for validation success.

### Layer 1: Spec Completeness
**Check the spec file has:**
- Goal statement
- Must-have requirements (at least one)
- Success criteria
- No unresolved open questions

### Layer 2: Plan Completeness
**Check the plan file has:**
- Reference to spec file (and spec exists)
- Technical approach section
- Tasks defined
- Acceptance criteria for each task

### Layer 3: Spec-Plan Alignment
**Verify:**
- Each must-have requirement has a corresponding task
- Tasks address the spec's goal
- No orphan tasks (tasks without spec backing)

### Layer 4: Implementation Review (Build Phase Only)
**If implementation exists:**
- Read the implemented files
- Compare against spec requirements
- Check acceptance criteria are met
- Verify constraints respected

### Layer 5: AI Self-Review
**Honest assessment:**
- Does implementation solve the stated problem?
- Are edge cases handled?
- Is error handling appropriate?
- Would you approve this as a code reviewer?

### Layer 6: Documentation Freshness (Post-Build)
**If the spec has a Documentation Impact section:**
- Read the spec's Documentation Impact checklist
- For each listed doc (CLAUDE.md, SKILL.md files, README.md, cc4me.config.yaml):
  - Check if the file was modified since the build started (git diff or timestamp)
  - If not modified, flag as potentially stale
- If no Documentation Impact section exists, check common docs heuristically:
  - New skill added → CLAUDE.md skills table updated?
  - Config changes → cc4me.config.yaml documented?
  - New behavior → CLAUDE.md Core Behaviors section current?
- Result: PASS (all docs updated), WARN (some flagged), or SKIP (no doc impact)

### Layer 7: Manual Review
**Present to user:**
- Summary of what was validated
- Any warnings or concerns (including doc freshness flags)
- Request sign-off before proceeding

## Output Format

```
## Validation Results

### Layer 1: Spec Completeness
- Goal: Found
- Must-have requirements: 5
- Success criteria: 3
- Open questions: 0 (resolved)
Result: PASS

### Layer 2: Plan Completeness
- Spec reference: specs/20260127-feature.spec.md (exists)
- Technical approach: Found
- Tasks: 4 defined
Result: PASS

### Layer 3: Spec-Plan Alignment
- Requirements covered: 5/5
- Orphan tasks: 0
Result: PASS

### Layer 4: Implementation Review
- Files implemented: 3
- Acceptance criteria met: 4/4
Result: PASS

### Layer 5: AI Self-Review
- Solves problem: Yes
- Edge cases: Handled
- Error handling: Appropriate
Result: PASS

### Layer 6: Documentation Freshness
- Spec lists doc impact: CLAUDE.md (skills table), setup SKILL.md
- CLAUDE.md: Modified (verified)
- setup SKILL.md: Modified (verified)
Result: PASS

### Layer 7: Manual Review
Awaiting user sign-off...

---
Overall: 6/6 layers passed, 1 pending approval
```

## When Validation Runs

- **After /plan**: Validates spec and plan completeness (Layers 1-3)
- **After /build**: Full validation including implementation and doc freshness (Layers 1-7)
- **Manual**: Run anytime with `/validate`

## Error Handling

If any layer fails:
1. Stop and report which layer failed
2. Explain what's wrong
3. Suggest how to fix
4. Do NOT proceed until fixed
