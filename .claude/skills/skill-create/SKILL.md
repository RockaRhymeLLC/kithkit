---
name: skill-create
description: Creates new Claude Code skills following best practices. Use when building new workflows, commands, or extending Claude's capabilities.
argument-hint: [skill description]
---

# Skill Creation

Create a new Claude Code skill with proper structure, validation, and best practices.

## Usage

```bash
/skill-create [natural language description]
```

Examples:
- `/skill-create` - Interactive: prompts for skill details
- `/skill-create a skill for deploying to production` - Inferred: extracts intent from description

## What This Does

1. **Parse Intent**: Extract skill name and purpose from your description
2. **Configure**: Set appropriate frontmatter fields for behavior control
3. **Scaffold**: Create SKILL.md and supporting files as needed
4. **Validate**: Enforce naming rules, description format, and best practices

## Frontmatter Reference (Essential)

All fields are optional. Only `description` is recommended.

| Field | Purpose |
|-------|---------|
| `name` | Display name (defaults to directory name). Lowercase, numbers, hyphens only (max 64 chars) |
| `description` | **Recommended.** What the skill does and when to use it. Claude uses this to decide when to auto-load |
| `argument-hint` | Hint shown during autocomplete, e.g., `[issue-number]` or `[filename]` |
| `disable-model-invocation` | Set `true` to prevent Claude from auto-loading. Use for manual-only workflows like `/deploy` |
| `user-invocable` | Set `false` to hide from `/` menu. Use for background knowledge Claude should know but users shouldn't invoke |
| `allowed-tools` | Tools Claude can use without permission when skill is active. Supports patterns: `Bash(npm *)` |
| `model` | Model to use when skill is active |
| `context` | Set to `fork` to run in isolated subagent |
| `agent` | Subagent type when `context: fork` (e.g., `Explore`, `Plan`, `general-purpose`, or custom agents from `.claude/agents/`) |
| `hooks` | Hooks scoped to skill lifecycle. See [Hooks in skills and agents](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents) |

### Invocation Control

| Frontmatter | User can invoke | Claude can invoke | When to use |
|-------------|-----------------|-------------------|-------------|
| (default) | Yes | Yes | Most skills |
| `disable-model-invocation: true` | Yes | No | Workflows with side effects (`/deploy`, `/commit`) |
| `user-invocable: false` | No | Yes | Background knowledge, not actionable as command |

### String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed to skill. If not present in content, appended as `ARGUMENTS: <value>` |
| `$ARGUMENTS[N]` or `$N` | Specific argument by index (0-based) |
| `${CLAUDE_SESSION_ID}` | Current session ID |

Example: `/fix-issue 123` with content "Fix GitHub issue $ARGUMENTS" → "Fix GitHub issue 123"

### Dynamic Context Injection

Use `` !`command` `` to run shell commands before content is sent to Claude:

```yaml
PR diff: !`gh pr diff`
Changed files: !`gh pr diff --name-only`
```

Commands execute immediately. Output replaces the placeholder. Claude receives the fully-rendered prompt. This is preprocessing — Claude only sees the final result.

**Note**: If a command fails or times out, the placeholder may remain or be empty. Use robust commands that fail gracefully.

## Creation Process

### 1. Determine Skill Name

**From natural language**:
- "a skill for deploying to production" → `deploy-prod`
- "skill to review pull requests" → `review-pr`

**Validation**:
- Lowercase letters, numbers, hyphens only
- Max 64 characters
- Pattern: `^[a-z0-9]+(-[a-z0-9]+)*$`

### 2. Write Description

**Structure**: `[Action] [What] [Details]. Use when [Trigger].`

**Guidelines**:
- Recommended (not required) — if omitted, Claude uses the first paragraph of markdown content
- Include action verbs and state WHEN to use the skill
- Keep under 250 characters (ideal < 100)

**Examples**:
- ✓ "Deploy application to production with validation. Use when releasing new versions."
- ✓ "Explains code with visual diagrams and analogies. Use when explaining how code works."
- ✗ "Deployment skill" (too vague, no trigger)

### 3. Choose Invocation Behavior

Ask: Who should invoke this skill?

- **Both (default)**: User can type `/name`, Claude can auto-load
- **User only**: Add `disable-model-invocation: true` for workflows with side effects
- **Claude only**: Add `user-invocable: false` for background knowledge

### 4. Choose Execution Context

Ask: Should this run in the main conversation or isolated?

- **Inline (default)**: Runs in current conversation context. Good for reference content and guidelines
- **Forked**: Add `context: fork` for isolated execution. Good for tasks with explicit instructions

**Important**: `context: fork` only makes sense for skills with explicit task instructions. If your skill is just guidelines (e.g., "use these API conventions"), the subagent receives guidelines but no actionable prompt and returns without meaningful output.

### 5. Scaffold Files and Manage Size

**Context is expensive.** Every line of SKILL.md loads into the conversation when the skill is invoked, consuming context window budget that Claude needs for reasoning about your actual problem. A 500-line skill eats context that could hold code, error messages, or conversation history. Shorter skills leave more room for the work.

**The loading hierarchy**:
1. **Skill descriptions** — loaded at session start (always in context, 2% budget)
2. **SKILL.md** — full content loads when the skill is invoked
3. **reference.md, examples.md** — loaded only when Claude reads them during execution

This means: anything in SKILL.md pays its context cost every invocation. Anything in supporting files only pays when actually needed. Split accordingly.

**Always create**: `.claude/skills/[skill-name]/SKILL.md`

**Create supporting files when**:
- `reference.md` — detailed workflows, API docs, schemas, lookup tables. Anything Claude needs to *consult* but not *memorize*
- `examples.md` — sample inputs/outputs, usage patterns. Helpful for complex skills but not needed every run
- `scripts/` — helper scripts Claude executes. These aren't loaded into context at all — they're run via Bash

**What belongs in SKILL.md (the "hot path")**:
- Frontmatter configuration
- Brief purpose statement
- Core workflow steps (the 80% case)
- Decision logic Claude needs every time
- Pointers to supporting files with descriptions of what they contain

**What belongs in reference.md (the "cold path")**:
- Detailed field-by-field documentation
- Edge cases and troubleshooting
- Complete API references or schemas
- Extended examples and patterns
- Validation rules and error catalogs

**Target**: SKILL.md under 500 lines, ideally 200-300. If you're over 300 lines, look for sections that are reference material rather than instructions and move them out.

**Reference supporting files explicitly** so Claude knows what each file contains and when to load it:
```markdown
## References

- For complete API field reference, see [reference.md](reference.md)
- For usage examples and common patterns, see [examples.md](examples.md)
```

### 6. Generate SKILL.md

```yaml
---
name: skill-name
description: Clear description with action verbs. Use when [trigger].
# Add other fields as needed based on behavior requirements
---

# [Skill Title]

[What this skill does and why]

## Usage

/skill-name [arguments]

## What This Does

[Brief workflow overview]

## [Main Instructions]

[Step-by-step instructions]

## References

For detailed workflows, see [reference.md](reference.md)
```

## Skill Types

### Reference Content
Knowledge Claude applies to current work — conventions, patterns, style guides:

```yaml
---
name: api-conventions
description: API design patterns for this codebase
---

When writing API endpoints:
- Use RESTful naming conventions
- Return consistent error formats
- Include request validation
```

### Task Content
Step-by-step instructions for specific actions:

```yaml
---
name: deploy
description: Deploy the application to production
context: fork
disable-model-invocation: true
---

Deploy the application:
1. Run the test suite
2. Build the application
3. Push to the deployment target
```

## Where Skills Live

| Location | Path | Applies to |
|----------|------|------------|
| Enterprise | See managed settings | All users in organization |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<skill-name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | Where plugin is enabled |

Higher-priority locations win: enterprise > personal > project. Plugin skills use `plugin-name:skill-name` namespace, so they cannot conflict with other levels.

**Monorepo support**: Claude automatically discovers skills from nested `.claude/skills/` directories when you work with files in subdirectories.

## Validation Rules

### Name
- ✓ `lowercase-with-hyphens`
- ✓ 1-64 characters
- ✓ Pattern: `/^[a-z0-9]+(-[a-z0-9]+)*$/`
- ✗ Spaces, underscores, capitals, special chars

### Description
- ✓ Recommended but optional
- ✓ States WHEN to use skill
- ✓ Contains action verbs
- ✓ Under 250 characters

### Structure
- ✓ SKILL.md has frontmatter
- ✓ SKILL.md under 500 lines
- ✓ References section if supporting files exist

## Best Practices

### Size and Structure
- **Treat context like money** — every line in SKILL.md costs context budget on every invocation. Be concise
- **SKILL.md = instructions, reference.md = documentation** — if Claude doesn't need it every run, it's reference material
- **Target 200-300 lines for SKILL.md** — 500 is the ceiling, not the goal
- **One concept per supporting file** — `reference.md` for detailed docs, `examples.md` for patterns. Don't dump everything into one giant reference file

### Behavior
- **Use `allowed-tools`**: To restrict what Claude can do (e.g., read-only skills)
- **Use `context: fork`**: For tasks that should run in isolation, not reference content
- **Use `argument-hint`**: To help users understand expected inputs
- **Use `disable-model-invocation: true`**: For anything with side effects
- **Write strong descriptions**: They're how Claude decides when to auto-load your skill
- **Reference supporting files explicitly**: Tell Claude what each file contains and when to load it

## Context Budget

Skill descriptions are loaded into context so Claude knows what's available. The budget scales at **2% of the context window** (fallback: 16,000 characters). If you have many skills, some may be excluded. Run `/context` to check for warnings about excluded skills.

Override with the `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable.

## After Creation

- Skill is immediately available as `/skill-name`
- Claude can auto-invoke based on description (unless disabled)
- No restart or confirmation needed
- Skills from `--add-dir` directories support live change detection

## References

- For detailed workflow, common patterns, and examples, see [reference.md](reference.md)
- Official documentation: https://code.claude.com/docs/en/skills
- Agent Skills standard: https://agentskills.io
