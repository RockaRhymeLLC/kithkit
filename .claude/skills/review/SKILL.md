---
name: review
description: Review specs and plans with a critical eye before building. Catches overcomplexity, missed edge cases, and simpler alternatives. Use between planning and building.
argument-hint: [spec-file, plan-file, or "all"]
---

# /review - Pre-Build Sanity Check

Challenge assumptions, catch overcomplexity, and find simpler paths before writing code. Uses **Bob** (a devil's advocate sub-agent) for independent review, plus **R2 peer review** for shared work.

## Purpose

Two layers of review to catch what you can't see in your own work:

1. **Bob** (automatic) — A devil's advocate sub-agent with clean context reviews your spec/plan independently. It only sees the documents, not your conversation history or assumptions. Catches lazy overengineering, scope creep, and obvious gaps.

2. **R2 Peer Review** (selective) — For shared work (skills, daemon features, anything that gets upstreamed), send to R2 for genuine peer review. She brings different experience and context.

## Usage

```bash
/review                                    # Review most recent spec+plan
/review specs/20260204-feature.spec.md     # Review a specific spec
/review plans/20260204-feature.plan.md     # Review a specific plan
/review all                                # Review all unbuilt plans
```

## When to Use

- **After /spec, before /plan** — catch requirement bloat early
- **After /plan, before /build** — the primary use case
- **When something feels off** — gut-check a design decision
- **After major scope changes** — re-evaluate with fresh eyes

## Review Process

### Step 1: Gather Context

Read the target files:
- If given a spec: read the spec
- If given a plan: read the plan AND its referenced spec
- If given neither: find the most recent plan in `plans/` and its spec

Also read any referenced story files (`plans/stories/s-*.json`) and test files (`plans/tests/t-*.json`).

### Step 2: Bob (Devil's Advocate)

**Always run this.** Spawn a Task sub-agent (general-purpose type) with ONLY the spec/plan content. The sub-agent gets none of your conversation history — just the documents and the review criteria below.

```
Use the Task tool with subagent_type="general-purpose" and include:
- The full text of the spec and/or plan
- The review dimensions below
- Instructions to be critical, challenge assumptions, and suggest simpler alternatives
- The output format template
```

The sub-agent's clean context is the whole point — it sees the plan as a stranger would, not as the person who wrote it.

### Step 3: R2 Peer Review (When Applicable)

After the sub-agent review, determine if R2 peer review is needed. See "Peer Review Protocol" below for the criteria.

If needed, send R2 the spec/plan via agent-comms with a summary of what you're building and what kind of feedback you want.

### Step 4: Synthesize and Format

Combine the sub-agent findings with your own assessment (and R2's feedback if received) into the output format below.

### Review Dimensions

Evaluate across these dimensions, thinking like a senior engineer doing a design review:

#### Complexity Check
- Could this be done with fewer moving parts?
- Are there abstractions that aren't earning their keep?
- Is there a "three lines of code" solution hiding behind an architecture diagram?
- Are we building for hypothetical future requirements?

#### Scope Check
- Does every feature trace back to a real need?
- Are there nice-to-haves masquerading as must-haves?
- What's the minimum viable version of this?
- What could we cut and still ship something useful?

#### Risk Check
- What's the riskiest assumption?
- Where are the unknowns we haven't acknowledged?
- What external dependencies could bite us?
- What happens when this fails? (Not "if" — "when")

#### Edge Cases
- What inputs/scenarios haven't been considered?
- What happens at zero? At scale? At timeout?
- What happens when the user does something unexpected?

#### Simplicity Alternatives
- Is there a well-known pattern that solves this?
- Could we use an existing tool/library instead of building?
- Would a simpler architecture work for the next 6 months?
- Are we over-engineering because it's fun, not because it's needed?

#### Documentation Impact
- Will this change affect any docs? (CLAUDE.md, SKILL.md files, README.md, cc4me.config.yaml)
- Which specific docs need updating when this is built?
- Are there new skills, config options, or behaviors that need to be documented?
- Will existing doc sections become stale or misleading after this ships?

#### Story & Test Quality (if plan exists)
- Are stories small enough to complete in one session?
- Do tests actually verify the important behavior?
- Are there gaps in test coverage for critical paths?
- Are story dependencies reasonable?

## Output Format

```markdown
## Review: [Feature Name]

**Reviewed**: [spec file], [plan file]
**Verdict**: SHIP IT | CONCERNS | RETHINK

### Summary
[1-2 sentences: overall assessment]

### Complexity (score /5)
[Specific observations about complexity]

### Scope (score /5)
[Specific observations about scope]

### Risks
- [Risk 1]: [Impact] — [Mitigation suggestion]
- [Risk 2]: [Impact] — [Mitigation suggestion]

### Edge Cases to Consider
- [Case 1]
- [Case 2]

### Simpler Alternatives
- [Alternative 1]: [Trade-off]
- [Alternative 2]: [Trade-off]

### Story/Test Gaps
- [Gap 1]
- [Gap 2]

### Documentation Impact
- [List docs that need updating when this ships]
- [e.g., "CLAUDE.md skills table — new skill added"]
- [e.g., "setup SKILL.md — new config option"]

### Recommendations
1. [Most important change]
2. [Second priority]
3. [Nice to have]

### The "Dave Question"
[If Dave were looking at this right now, what would he say?
Usually something like "do we really need X?" or "what's the
simplest version of this that actually works?"]
```

## Verdicts

- **SHIP IT** — Design is solid, complexity is justified, risks are managed. Build away.
- **CONCERNS** — Mostly good but has specific issues worth addressing first. List them clearly.
- **RETHINK** — Fundamental approach needs reconsideration. Too complex, wrong abstraction, or missing the point.

## Scoring Guide (Complexity & Scope)

- **1/5** — Minimal, elegant, nothing wasted
- **2/5** — Lean with minor extras
- **3/5** — Reasonable but some fat to trim
- **4/5** — Overbuilt — significant simplification possible
- **5/5** — Way too complex for the problem

Lower is better. Aim for 1-2.

## Key Principles

**Be specific, not vague.** "This is too complex" is useless. "The TTS module has 3 abstraction layers when 1 would work because X" is useful.

**Suggest, don't just criticize.** Every concern should come with a simpler alternative or a mitigation.

**Respect the constraint.** If the spec says "must support X", don't suggest removing X. Challenge the spec separately.

**Think in iterations.** "Ship v1 without X, add it in v2 if needed" is almost always good advice.

**Remember the context.** This is a personal project, not enterprise software. Favor shipping over perfection.

## Peer Review Protocol

### When to Request R2 Peer Review

**Always request peer review for:**
- New skills or skill upgrades (she'll use them too)
- Daemon features (shared codebase)
- Changes to upstream pipeline or shared workflows
- Anything touching agent-comms (affects both sides)
- Self-improvement work (new capabilities, core behavior changes)

**Skip peer review for:**
- Personal tasks (research, emails, calendar for Dave)
- BMO-specific config or personality tweaks
- Quick bugfixes to your own stuff
- Simple todo items that are just "do the thing"

### How to Request

Send via agent-comms:
```
/agent-comms send r2d2 "Peer review request: [feature name]. [1-2 sentence summary of approach]. Spec/plan attached below: [paste key sections or file paths]. Looking for feedback on [specific concern]. No rush if you're busy."
```

R2's review carries real weight — if she says RETHINK, stop and reconsider before building.

## Integration

- Fits between `/plan` and `/build` in the standard workflow
- Can also be used standalone on any spec or plan
- Review findings can feed back into spec updates via `/spec`
- The `/validate` skill handles structural alignment; `/review` handles design quality
- Bob (devil's advocate sub-agent) runs automatically on every review
- R2 peer review is triggered selectively based on the protocol above
