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
| `allowed-tools` | Tools Claude can use without permission when skill is active, e.g., `Read, Grep, Glob` |
| `model` | Model to use when skill is active |
| `context` | Set to `fork` to run in isolated subagent |
| `agent` | Subagent type when `context: fork` (e.g., `Explore`, `Plan`, `general-purpose`) |
| `hooks` | Hooks scoped to skill lifecycle |

### Invocation Control

| Frontmatter | User can invoke | Claude can invoke | When to use |
|-------------|-----------------|-------------------|-------------|
| (default) | Yes | Yes | Most skills |
| `disable-model-invocation: true` | Yes | No | Workflows with side effects (`/deploy`, `/commit`) |
| `user-invocable: false` | No | Yes | Background knowledge, not actionable as command |

### String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed to skill |
| `$ARGUMENTS[N]` or `$N` | Specific argument by index (0-based) |
| `${CLAUDE_SESSION_ID}` | Current session ID |

Example: `/fix-issue 123` with content "Fix GitHub issue $ARGUMENTS" → "Fix GitHub issue 123"

### Dynamic Context Injection

Use `!`command`` to run shell commands before content is sent:
```yaml
PR diff: !`gh pr diff`
Changed files: !`gh pr diff --name-only`
```

## Creation Process

### 1. Determine Skill Name

**From natural language**:
- "a skill for deploying to production" → `deploy-prod`
- "skill to review pull requests" → `review-pr`

**Validation**:
- Lowercase letters, numbers, hyphens only
- Max 64 characters

### 2. Write Description

**Requirements**:
- Recommended (not required)
- Max ~250 characters (ideal <100)
- Include action verbs and WHEN to use

**Examples**:
- ✓ "Deploy application to production with validation. Use when releasing new versions."
- ✓ "Review pull requests for quality and standards. Use for PR reviews."
- ✗ "Deployment skill" (too vague)

### 3. Choose Invocation Behavior

Ask: Who should invoke this skill?

- **Both (default)**: User can type `/name`, Claude can auto-load
- **User only**: Add `disable-model-invocation: true` for workflows with side effects
- **Claude only**: Add `user-invocable: false` for background knowledge

### 4. Choose Execution Context

Ask: Should this run in the main conversation or isolated?

- **Inline (default)**: Runs in current conversation context
- **Forked**: Add `context: fork` for isolated execution with optional `agent` type

### 5. Scaffold Files

**Always create**: `.claude/skills/[skill-name]/SKILL.md`

**Create if needed**:
- `reference.md` - Detailed workflows (if multi-step)
- `examples.md` - Usage examples
- `scripts/` - Helper scripts

**Keep SKILL.md under 500 lines.** Move details to supporting files.

### 6. Generate SKILL.md

```yaml
---
name: skill-name
description: Clear description with action verbs
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

## Validation Rules

### Name
- ✓ `lowercase-with-hyphens`
- ✓ 1-64 characters
- ✗ Spaces, underscores, capitals, special chars

### Description
- ✓ Recommended but optional
- ✓ States WHEN to use skill
- ✓ Contains action verbs

### Structure
- ✓ SKILL.md has frontmatter
- ✓ SKILL.md under 500 lines
- ✓ References section if supporting files exist

## Best Practices

- **Keep SKILL.md focused**: Under 500 lines, details in reference.md
- **Use `disable-model-invocation`**: For any skill with side effects (deploy, commit, send)
- **Use `allowed-tools`**: For read-only skills that shouldn't modify files
- **Use `context: fork`**: For research or analysis that shouldn't affect main conversation
- **Use `argument-hint`**: To help users understand expected inputs

## After Creation

- Skill is immediately available as `/skill-name`
- Claude can auto-invoke based on description (unless disabled)
- No confirmation needed

## References

- For detailed workflow and validation logic, see [reference.md](reference.md)
- Official documentation: https://code.claude.com/docs/en/skills
