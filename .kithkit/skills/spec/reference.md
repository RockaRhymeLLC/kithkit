# Spec Workflow Reference

Detailed step-by-step instructions for creating and updating specifications.

## Creation Workflow

### Step 1: Parse the Feature Name

Extract the feature name from the arguments and normalize it to a slug:
- Input: `telegram-bot` → slug: `telegram-bot`
- Input: `State Manager` → slug: `state-manager`
- Input: `breakfast maker` → slug: `breakfast-maker`

Generate the filename: `projects/<feature-name>/YYYYMMDD-[feature-name].spec.md` using today's date. Create the `projects/<feature-name>/` directory if it does not exist.

Example: `/spec telegram-bot` → `projects/telegram-bot/20260127-telegram-bot.spec.md`

### Step 2: Read the Template

Use the Read tool to load `.claude/skills/spec/spec.template.md` (or `templates/spec.template.md` if it exists at the project root). The template defines the section structure. If no template file is found, use the structure documented in this file.

### Step 3: Interview the User

Gather information for each section of the spec. Ask questions conversationally, waiting for answers before moving on. Not every section needs to be extensive — if the user says "none" or "not applicable," document that explicitly rather than leaving sections blank.

#### Goal Section

Ask: "In one sentence, what problem does this feature solve?"

Capture one clear sentence focused on the problem, not the implementation. This becomes the first line of the spec.

#### Requirements

**Must Have:**
Ask: "What are the must-have requirements? These are things the feature absolutely needs to do."

Collect requirements one by one until the user indicates they are done. Each requirement becomes a checkbox item: `- [ ] Requirement text`

**Should Have:**
Ask: "Any should-have requirements? These are valuable but not critical."

Optional enhancements. If none, document "None specified."

**Won't Have:**
Ask: "Anything explicitly out of scope for now?"

Clarifying what is NOT being built prevents scope creep. If none, document "None specified."

#### Constraints

**Security:**
Ask: "Are there any specific security constraints or requirements? For example: authentication, authorization, encryption, input validation."

If none: document "None specified."

**Performance:**
Ask: "Are there any performance requirements? For example: response times, throughput, memory limits."

If none: document "None specified."

**Compatibility:**
Ask: "Are there any compatibility requirements? For example: specific platforms, runtime versions, or dependencies."

Example values: "Node.js 20+", "macOS only", "must work without internet access."
If none: document "None specified."

#### Success Criteria

Ask: "How will we know this feature is complete and working? What observable behaviors should we see?"

Gather 2 to 5 specific, measurable outcomes. Format as a numbered list. Examples:
1. User can send a Telegram message and receive a response within 3 seconds
2. Credentials are stored in Keychain and never written to disk in plaintext
3. State persists across session restarts

#### User Stories

Ask: "Can you describe 1 to 2 scenarios where this feature would be used?"

For each scenario, collect three parts and format them as:

```markdown
### Scenario 1: [Title]
- **Given**: [context — what is the starting situation?]
- **When**: [action — what does the user do?]
- **Then**: [outcome — what should happen?]
```

#### Technical Considerations

Ask: "Any technical notes, dependencies, or architectural considerations we should be aware of?"

This might include:
- Specific libraries to use or avoid
- Integration points with existing code
- Architecture decisions already made
- Known technical constraints

If none, document "None specified."

#### Documentation Impact

Ask: "Will this feature require updates to any documentation when it ships?"

Common candidates:
- `CLAUDE.md` — new skills, config options, behavior changes
- `SKILL.md` files — new or modified skills
- `README.md` — user-facing feature additions
- `kithkit.config.yaml` — new config options

Format as a checklist:
```markdown
- [ ] CLAUDE.md — add new /feature-name skill to capabilities table
- [ ] skills/feature-name/SKILL.md — create skill documentation
```

If no doc impact is expected, document "None expected." This section is checked by `/validate` post-build to ensure docs are actually updated.

#### Open Questions

Ask: "Are there any open questions or uncertainties we need to resolve before planning?"

Examples:
- Unresolved architectural decisions
- Areas that need research before committing to an approach
- Questions for stakeholders or other agents

Format as a checklist: `- [ ] Question?`

If there are open questions, note them as potential blockers for planning. Ideally these are resolved before moving to `/plan`.

### Step 4: Create the Specification File

Create the `projects/<feature-name>/` directory if it does not already exist. Use the Write tool to create the spec file at `projects/<feature-name>/YYYYMMDD-feature-name.spec.md`.

Fill in all sections with the information gathered during the interview. Replace template placeholders:
- `[YYYY-MM-DD]` → today's date
- `[Feature Name]` → formatted feature name

Convert user responses into well-formatted markdown. Use consistent formatting throughout: checkboxes for requirements, numbered lists for success criteria, scenario blocks for user stories.

### Step 5: Confirm and Suggest Next Steps

```
Created: projects/feature-name/20260127-feature-name.spec.md

Next steps:
  1. Review and refine the spec if needed
  2. Resolve any open questions before planning
  3. Run /plan projects/feature-name/20260127-feature-name.spec.md to create the implementation plan
```

If the spec involves shared capabilities (new skills, daemon features, agent-comms), also suggest peer review before moving to planning. See the Peer Review section in SKILL.md.

---

## Update Workflow

### Step 1: Parse the Command

Extract the description from the arguments:
- `/spec add breakfast feature` → description = `"add breakfast feature"`
- `/spec security: must encrypt data at rest` → description = `"security: must encrypt data at rest"`
- `/spec success criteria: responds within 500ms` → description = `"responds within 500ms"` (success criteria target)

### Step 2: Determine Target Spec File

Check the current conversation for references to a spec file. If a spec was recently created or mentioned, use that one.

If no spec is obvious from context, use the Glob tool to list spec files in `projects/` and match the description semantically to spec titles:
- "breakfast" matches a spec titled "breakfast-maker"
- "telegram" matches "telegram-integration"

If there are multiple plausible matches or no clear match, ask the user to confirm which spec to update.

### Step 3: Categorize the Description

Use natural language understanding to determine which section of the spec to update:

| Keywords / Signals | Category | Target Section |
|--------------------|----------|----------------|
| "add", "must", "require", "need", "critical" | Must Have requirement | `### Must Have` |
| "nice to have", "should", "could", "optional" | Should Have requirement | `### Should Have` |
| "won't have", "out of scope", "not now", "exclude" | Won't Have | `### Won't Have (for now)` |
| "security", "auth", "encrypt", "secure", "protect" | Security constraint | `### Security` |
| "performance", "fast", "speed", "latency", "response time" | Performance constraint | `### Performance` |
| "compatibility", "platform", "environment", "requires", "depends on" | Compatibility constraint | `### Compatibility` |
| "success criteria", "done when", "complete when", "working when" | Success criteria | `## Success Criteria` |
| "given", "when", "then", "scenario", "user story" | User story | `## User Stories / Scenarios` |
| "doc", "documentation", "readme", "skill.md" | Documentation impact | `## Documentation Impact` |

Default: If the category is genuinely unclear, treat it as a Must Have requirement and confirm with the user.

### Step 4: Update the Spec File

Use the Read tool to load the current spec. Use the Edit tool to add the new content — always preserve existing content.

#### For Requirements

Find the appropriate section (`### Must Have` or `### Should Have`) and append a new checkbox line:

```markdown
### Must Have
- [ ] Existing requirement 1
- [ ] Existing requirement 2
- [ ] New requirement text  ← added
```

#### For Constraints

Find the constraint section (`### Security`, `### Performance`, or `### Compatibility`). If it currently says "None specified," replace that line. Otherwise, append to the existing list.

#### For Success Criteria

Find the `## Success Criteria` section, determine the next number in the sequence, and append a new numbered item.

#### For User Stories

Find the `## User Stories / Scenarios` section, determine the next scenario number, and append the new scenario block in Given/When/Then format. Parse the description to extract these parts, or construct a reasonable scenario if the description is in plain prose.

#### For Documentation Impact

Find the `## Documentation Impact` section and append a new checkbox item.

### Step 5: Confirm

```
Added to Must Have: "New requirement text"
  File: projects/agent-assistant-harness/20260127-agent-assistant-harness.spec.md
```

---

## Spec File Structure

Every spec follows this structure:

```markdown
# Spec: [Feature Name]

**Created**: YYYY-MM-DD
**Status**: Draft | Ready | Approved

## Goal

[One sentence: what problem does this solve?]

## Requirements

### Must Have
- [ ] Requirement 1
- [ ] Requirement 2

### Should Have
- [ ] Optional enhancement

### Won't Have (for now)
- Out-of-scope item

## Constraints

### Security
[Security requirements or "None specified"]

### Performance
[Performance requirements or "None specified"]

### Compatibility
[Compatibility requirements or "None specified"]

## Success Criteria

1. Observable outcome 1
2. Observable outcome 2
3. Observable outcome 3

## User Stories / Scenarios

### Scenario 1: [Title]
- **Given**: [context]
- **When**: [action]
- **Then**: [expected outcome]

## Technical Considerations

[Libraries, integration points, architectural notes, or "None specified"]

## Documentation Impact

- [ ] CLAUDE.md — [reason]
- [ ] skills/feature/SKILL.md — [reason]

(or "None expected")

## Open Questions

- [ ] Question that must be resolved before planning?

(or "None")
```

---

## Error Handling

### Creation Workflow

- **Spec already exists at target path**: Ask whether to open it for editing or choose a different name
- **Template not found**: Use the structure documented in this file as the fallback template
- **User cancels interview partway through**: Save the partial spec with `Status: Draft` and note which sections are incomplete
- **File write fails**: Report the error clearly and suggest checking disk space and permissions

### Update Workflow

- **Target spec file does not exist**: Ask the user to create a spec first or select a different file
- **Target section not found**: If the section is clearly applicable, add it. Otherwise notify the user of the structural issue and ask how to proceed
- **Edit tool fails**: Report the error clearly and suggest making the change manually
- **Ambiguous target spec**: Always ask rather than guess — an update to the wrong spec is worse than a brief delay

---

## Best Practices

### For Creation

1. **Be thorough**: Do not skip sections — document "None specified" explicitly rather than leaving blanks
2. **Clarify vague requirements**: Ask follow-up questions when a requirement is ambiguous; "fast" is not a requirement, "responds within 500ms" is
3. **Keep specs user-focused**: Specs describe behavior and outcomes, not implementation details
4. **Document uncertainties**: Open questions are fine — capturing them is better than pretending they do not exist
5. **One feature per spec**: Keep specs focused; overlapping specs create planning confusion

### For Updates

1. **Preserve existing content**: Never remove or modify existing items, only append
2. **Maintain formatting**: Keep the markdown structure intact (checkboxes, numbered lists, section headers)
3. **Be smart about categorization**: Use context clues from the description; when in doubt, ask
4. **Ask when the target is ambiguous**: A quick confirmation is always better than updating the wrong file
5. **Keep it fast**: This is a rapid-iteration tool — short commands, quick confirmation, move on

---

## Integration Points

**Validation** (`/validate`): Specs are validated before planning begins. The Documentation Impact section is also checked post-build to ensure docs were actually updated.

**Peer Review**: Specs for shared capabilities should get peer input before moving to `/plan`. See the Peer Review section in SKILL.md.

**Plan Phase** (`/plan`): Takes the spec file path as input and maps requirements to stories and tests.

**Templates**: The spec template (if present at `templates/spec.template.md`) provides the canonical section structure. If absent, use the structure in this reference.
