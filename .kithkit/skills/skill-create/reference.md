# Skill Creation Reference

Detailed workflow for creating new Claude Code skills with validation and best practices.

**Official Documentation**: https://code.claude.com/docs/en/skills

## Complete Frontmatter Reference

All fields are optional. Only `description` is recommended.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name for the skill. If omitted, uses directory name. Lowercase letters, numbers, and hyphens only (max 64 characters) |
| `description` | Recommended | What the skill does and when to use it. Claude uses this to decide when to apply the skill. If omitted, uses first paragraph of markdown content |
| `argument-hint` | No | Hint shown during autocomplete to indicate expected arguments. Example: `[issue-number]` or `[filename] [format]` |
| `disable-model-invocation` | No | Set to `true` to prevent Claude from automatically loading this skill. Use for workflows you want to trigger manually with `/name`. Default: `false` |
| `user-invocable` | No | Set to `false` to hide from the `/` menu. Use for background knowledge users shouldn't invoke directly. Default: `true` |
| `allowed-tools` | No | Tools Claude can use without asking permission when this skill is active |
| `model` | No | Model to use when this skill is active |
| `context` | No | Set to `fork` to run in a forked subagent context |
| `agent` | No | Which subagent type to use when `context: fork` is set |
| `hooks` | No | Hooks scoped to this skill's lifecycle |

## String Substitutions

Skills support string substitution for dynamic values:

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking the skill. If not present in content, arguments are appended as `ARGUMENTS: <value>` |
| `$ARGUMENTS[N]` | Access specific argument by 0-based index, e.g., `$ARGUMENTS[0]` for first argument |
| `$N` | Shorthand for `$ARGUMENTS[N]`, e.g., `$0` for first, `$1` for second |
| `${CLAUDE_SESSION_ID}` | Current session ID. Useful for logging or session-specific files |

**Example using substitutions**:
```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

Running `/migrate-component SearchBar React Vue` substitutes appropriately.

## Dynamic Context Injection

The `!`command`` syntax runs shell commands before the skill content is sent to Claude:

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

The commands execute immediately, output replaces the placeholder, and Claude receives the fully-rendered prompt.

## Invocation Control

### Who Can Invoke

| Frontmatter | You can invoke | Claude can invoke | When loaded into context |
|-------------|----------------|-------------------|--------------------------|
| (default) | Yes | Yes | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes | No | Description not in context, full skill loads when you invoke |
| `user-invocable: false` | No | Yes | Description always in context, full skill loads when invoked |

### When to Use Each

**`disable-model-invocation: true`**:
- Workflows with side effects
- Actions you want to control timing
- Examples: `/deploy`, `/commit`, `/send-slack-message`

**`user-invocable: false`**:
- Background knowledge
- Context Claude should know but isn't actionable
- Example: `legacy-system-context` explains old system but isn't a meaningful user command

## Subagent Execution

Add `context: fork` to run skills in isolation:

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:

1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

**Available agents**:
- `Explore` - Read-only tools for codebase exploration
- `Plan` - Planning and design
- `general-purpose` - Default, full tool access

The skill content becomes the subagent's task. Results are summarized and returned to main conversation.

## Tool Restrictions

Use `allowed-tools` to limit what Claude can do:

```yaml
---
name: safe-reader
description: Read files without making changes
allowed-tools: Read, Grep, Glob
---
```

## Where Skills Live

| Location | Path | Applies to |
|----------|------|------------|
| Enterprise | See managed settings | All users in organization |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<skill-name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | Where plugin is enabled |

Higher-priority locations win: enterprise > personal > project.

## Skill Types

### Reference Content
Knowledge Claude applies to current work - conventions, patterns, style guides:

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

## Complete Creation Workflow

### Step 1: Parse Input and Determine Skill Name

**If natural language provided**:
```
Input: "a skill for deploying to production"
→ Extract action: "deploy"
→ Extract target: "production"
→ Generate name: "deploy-prod"
```

**Name Generation Rules**:
1. Identify primary action (deploy, review, create, validate, etc.)
2. Identify target (prod, pr, api, etc.)
3. Combine with hyphen: `action-target`
4. Validate format

**Validation**:
```typescript
const nameRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isValid = nameRegex.test(name) && name.length <= 64;
```

### Step 2: Determine Frontmatter Fields

Ask these questions:

1. **Who should invoke?**
   - Both user and Claude → default
   - User only → `disable-model-invocation: true`
   - Claude only → `user-invocable: false`

2. **Where should it run?**
   - Main conversation → default
   - Isolated subagent → `context: fork` + optional `agent`

3. **What tools are allowed?**
   - All tools → default
   - Limited set → `allowed-tools: Tool1, Tool2`

4. **Does it take arguments?**
   - Yes → add `argument-hint` for autocomplete help

### Step 3: Determine File Structure

**Decision tree**:

```
Is the skill simple and single-purpose?
├─ Yes → SKILL.md only
└─ No → Continue

Does it have multi-step workflow?
├─ Yes → Add reference.md
└─ No → Continue

Would examples help understanding?
├─ Yes → Add examples.md
└─ No → Continue

Does it need automation/scripts?
├─ Yes → Add scripts/ directory
└─ No → Done
```

### Step 4: Generate SKILL.md

**Template**:
```yaml
---
name: skill-name
description: Action-verb-driven description
# Add fields based on Step 2 decisions
---

# [Skill Title]

[One paragraph explaining what and why]

## Usage

/skill-name [arguments]

Examples:
- `/skill-name arg1` - Description

## What This Does

[Brief numbered list or short paragraph]

## [Main Section]

[Core instructions]

## References

For detailed workflows, see [reference.md](reference.md)
```

**Keep under 500 lines.** Move details to reference.md.

### Step 5: Validate Everything

```typescript
// Name validation
const nameValid =
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) &&
  name.length <= 64;

// Description validation (if provided)
const actionVerbs = [
  'use', 'create', 'deploy', 'build', 'review', 'analyze',
  'troubleshoot', 'debug', 'query', 'update', 'delete',
  'run', 'execute', 'validate', 'generate', 'fix'
];

const descValid =
  !description ||
  actionVerbs.some(verb =>
    description.toLowerCase().includes(verb)
  );

// Structure validation
const skillMdLines = content.split('\n').length;
const sizeValid = skillMdLines <= 500;
```

## Description Best Practices

**Structure**: `[Action] [What] [Details]. Use when [Trigger].`

**Character Count Guidelines**:
- **Ideal** (<100 chars): Concise, clear, actionable
- **Good** (<150 chars): Detailed enough, still readable
- **Acceptable** (<250 chars): Maximum practical length

**Action Verb Categories**:
- **Creation**: Create, Build, Generate, Scaffold, Initialize
- **Modification**: Update, Modify, Change, Refactor, Improve
- **Removal**: Delete, Remove, Clean, Purge
- **Inspection**: Review, Analyze, Inspect, Validate, Verify
- **Execution**: Deploy, Run, Execute, Trigger, Launch
- **Troubleshooting**: Debug, Diagnose, Fix, Resolve, Troubleshoot
- **Communication**: Send, Notify, Alert, Report
- **Query**: Query, Search, Find, Retrieve, Fetch

## Common Patterns

### Deployment Skill
```yaml
---
name: deploy-prod
description: Deploy application to production with validation
disable-model-invocation: true
context: fork
---
```

### Research Skill
```yaml
---
name: analyze-deps
description: Analyze project dependencies for issues
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob, Bash(npm *)
---
```

### Background Knowledge Skill
```yaml
---
name: legacy-api-context
description: Context about the legacy API system architecture
user-invocable: false
---
```

### Read-Only Exploration
```yaml
---
name: explore-codebase
description: Explore codebase without making changes
allowed-tools: Read, Grep, Glob
---
```

## Context Efficiency

**Why split files?**
- SKILL.md descriptions load at session start
- Full SKILL.md loads when skill is invoked
- reference.md only loads when explicitly referenced

**Optimization strategy**:
- Keep SKILL.md under 500 lines (ideally 200-300)
- Move detailed procedures to reference.md
- Move examples to examples.md
- Use References section to guide when to load what

## Troubleshooting

### Skill not triggering
1. Check description includes keywords users would naturally say
2. Verify skill appears in "What skills are available?"
3. Try rephrasing request to match description
4. Invoke directly with `/skill-name`

### Skill triggers too often
1. Make description more specific
2. Add `disable-model-invocation: true`

### Claude doesn't see all skills
Skill descriptions have a character budget (default 15,000). Set `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable to increase.

## Post-Creation

After creating the skill:
- No confirmation needed
- Skill is immediately available
- Can be invoked with `/skill-name`
- Will auto-load based on description match (unless disabled)

## Official Documentation

For the most up-to-date information, see:
https://code.claude.com/docs/en/skills
