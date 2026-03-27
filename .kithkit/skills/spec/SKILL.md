---
name: spec
description: Create or update specification documents using the spec-driven workflow. Use when starting a new feature or adding requirements.
argument-hint: [feature-name or update description]
---

# /spec - Specification Management

This skill handles both creating new specifications and updating existing ones. The workflow adapts based on the arguments you provide.

## Purpose

Define WHAT we're building and WHY, before planning HOW to build it. Specifications are the source of truth for requirements, constraints, and success criteria.

## Usage Patterns

### Create New Specification
```bash
/spec [feature-name]
```
Examples:
- `/spec telegram-integration`
- `/spec state-manager`
- `/spec breakfast-maker`

**When to use**: Starting a new feature from scratch

### Update Existing Specification
```bash
/spec <natural language description>
```
Examples:
- `/spec add breakfast feature`
- `/spec security constraint: must encrypt data`
- `/spec success criteria: responds within 500ms`
- `/spec nice to have: coffee brewing`

**When to use**: Quick additions to an existing spec

## How It Works

**I infer your intent** based on:
1. **Argument format**:
   - Single word/slug → Create new spec
   - Natural sentence → Update existing spec
2. **Conversation context**: What spec are we working on?
3. **File system**: What specs exist in `specs/`?

If ambiguous, I'll ask you to clarify.

## Workflows

### Creation Workflow
1. Parse feature name
2. Interview you to gather requirements
3. Use template structure
4. Create `specs/YYYYMMDD-feature-name.spec.md`
5. Set as active spec (context tracker)
6. Suggest next steps: `/plan`

### Update Workflow
1. Parse your description
2. Determine target spec (from context or ask)
3. Categorize content (requirement, constraint, success criteria, etc.)
4. Update the appropriate section
5. Log change to history
6. Confirm what was added

## Best Practices

**For Creation**:
- Be thorough in the interview
- Clarify vague requirements
- Keep specs user-focused (behavior, not implementation)
- Document uncertainties as open questions
- One feature per spec

**For Updates**:
- Use natural language - I'll categorize correctly
- Trust the inference - I'll find the right spec
- Quick iterations - add multiple items in sequence
- If I get it wrong, you can manually edit

## Peer Review for Shared Specs

When a spec defines **shared capabilities** — things R2 will also use or that get upstreamed — consider requesting R2 peer review before moving to `/plan`. She may catch requirements you missed or suggest approaches based on her own experience.

**Always request peer review for specs covering:**
- New skills or skill upgrades
- Daemon features or core behavior changes
- Upstream pipeline or shared workflow changes
- Anything touching agent-comms

**Skip peer review for:**
- Personal tasks, BMO-specific config
- Quick features that only affect your own workflows

Send via agent-comms: `/agent-comms send r2d2 "Spec review: [feature]. [Summary]. Looking for feedback on [concern]."`

## Documentation Impact Section

Every spec includes a **Documentation Impact** section that identifies which docs will need updating when the feature ships. This is checked by `/validate` post-build to ensure docs stay fresh. Common candidates:

- `CLAUDE.md` — new skills, config options, behavior changes
- `SKILL.md` files — new or modified skills
- `README.md` — user-facing feature additions
- `cc4me.config.yaml` — new config options

If the feature has no doc impact, document "None expected."

## Integration

**Context Tracker**: Remembers which spec is active across conversation
**History Logger**: Records all spec changes for audit
**Validation**: Specs are validated before moving to plan phase; doc impact is checked post-build
**Peer Review**: Shared specs should get R2's input before planning (see above)

See `reference.md` for detailed step-by-step workflows.
