# Skill Creation Reference

Detailed workflow, patterns, and examples for creating Claude Code skills.

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
| `allowed-tools` | No | Tools Claude can use without asking permission when this skill is active. Supports patterns like `Bash(npm *)` |
| `model` | No | Model to use when this skill is active |
| `context` | No | Set to `fork` to run in a forked subagent context |
| `agent` | No | Which subagent type to use when `context: fork` is set. Options: `Explore`, `Plan`, `general-purpose`, or custom agents from `.claude/agents/` |
| `hooks` | No | Hooks scoped to this skill's lifecycle. See [Hooks docs](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents) |

## String Substitutions

Skills support string substitution for dynamic values:

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking the skill. If not present in content, arguments are appended as `ARGUMENTS: <value>` |
| `$ARGUMENTS[N]` | Access specific argument by 0-based index, e.g., `$ARGUMENTS[0]` for first argument |
| `$N` | Shorthand for `$ARGUMENTS[N]`, e.g., `$0` for first, `$1` for second |
| `${CLAUDE_SESSION_ID}` | Current session ID. Useful for logging or session-specific files |

**Example using positional arguments**:
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

The `` !`command` `` syntax runs shell commands before the skill content is sent to Claude:

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

The commands execute immediately, output replaces the placeholder, and Claude receives the fully-rendered prompt. This is preprocessing — Claude only sees the final result.

**Edge cases**:
- If a command fails, the placeholder may remain or be replaced with empty output
- Commands that produce very large output will consume context budget
- Use robust commands that fail gracefully (e.g., `gh pr diff 2>/dev/null || echo "No PR found"`)

## Invocation Control

### Who Can Invoke

| Frontmatter | You can invoke | Claude can invoke | When loaded into context |
|-------------|----------------|-------------------|--------------------------|
| (default) | Yes | Yes | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes | No | Description not in context, full skill loads when you invoke |
| `user-invocable: false` | No | Yes | Description always in context, full skill loads when invoked |

### When to Use Each

**`disable-model-invocation: true`**:
- Workflows with side effects (deploy, commit, send messages)
- Actions where you want to control timing
- Examples: `/deploy`, `/commit`, `/send-slack-message`

**`user-invocable: false`**:
- Background knowledge that isn't actionable as a command
- Context Claude should know but isn't a meaningful user action
- Example: `legacy-system-context` explains old system architecture

### Permission Control

Three ways to control which skills Claude can invoke:

1. **Disable all skills**: Deny the `Skill` tool in `/permissions`
2. **Allow/deny specific skills**: `Skill(commit)` for exact match, `Skill(deploy *)` for prefix match
3. **Hide individual skills**: `disable-model-invocation: true` in frontmatter

Note: `user-invocable` only controls menu visibility, not Skill tool access.

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

**How it works**:
1. A new isolated context is created
2. The subagent receives the skill content as its prompt
3. The `agent` field determines the execution environment (model, tools, permissions)
4. Results are summarized and returned to your main conversation

**Important**: `context: fork` only makes sense for skills with explicit task instructions. If your skill contains only guidelines (like "use these API conventions"), the subagent receives guidelines but no actionable prompt and returns without meaningful output.

**Available agent types**:
- `Explore` - Read-only tools for codebase exploration
- `Plan` - Planning and design
- `general-purpose` - Default, full tool access
- Custom agents defined in `.claude/agents/`

### Skills + Subagents (Two Directions)

| Approach | System prompt | Task | Also loads |
|----------|--------------|------|------------|
| Skill with `context: fork` | From agent type | SKILL.md content | CLAUDE.md |
| Subagent with `skills` field | Subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md |

## Tool Restrictions

Use `allowed-tools` to limit what Claude can do:

```yaml
---
name: safe-reader
description: Read files without making changes
allowed-tools: Read, Grep, Glob
---
```

Pattern syntax for fine-grained control:
```yaml
allowed-tools: Bash(npm *), Bash(node *), Read, Grep
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
```
Pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/
Length: 1-64 characters
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

5. **Does it need lifecycle hooks?**
   - Yes → add `hooks` with appropriate configuration

### Step 3: Determine File Structure

**Decision tree**:

```
Is the skill simple and single-purpose?
├─ Yes → SKILL.md only
└─ No → Continue

Does it have detailed reference material or multi-step workflow?
├─ Yes → Add reference.md
└─ No → Continue

Would examples help understanding?
├─ Yes → Add examples.md
└─ No → Continue

Does it need automation/scripts?
├─ Yes → Add scripts/ directory
└─ No → Done
```

**File structure**:
```
my-skill/
├── SKILL.md           # Main instructions (required)
├── reference.md       # Detailed reference (loaded when needed)
├── examples.md        # Usage examples (loaded when needed)
└── scripts/
    └── helper.sh      # Helper scripts (executed, not loaded)
```

### Step 4: Generate SKILL.md

**Template**:
```yaml
---
name: skill-name
description: Action-verb-driven description. Use when [trigger].
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

### Step 5: Validate

- Name matches `/^[a-z0-9]+(-[a-z0-9]+)*$/` and is ≤ 64 chars
- Description (if provided) includes action verbs and is under 250 chars
- SKILL.md is under 500 lines
- Supporting files are referenced from SKILL.md
- Frontmatter fields are valid YAML

## Description Best Practices

**Structure**: `[Action] [What] [Details]. Use when [Trigger].`

**Character Count Guidelines**:
- **Ideal** (<100 chars): Concise, clear, actionable
- **Good** (<150 chars): Detailed enough, still readable
- **Acceptable** (<250 chars): Maximum practical length

**The first paragraph matters**: If no description is set in frontmatter, Claude uses the first paragraph of markdown content. Make it count.

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

### Deployment Skill (User-Only, Forked)
```yaml
---
name: deploy-prod
description: Deploy application to production with validation. Use when releasing new versions.
disable-model-invocation: true
context: fork
---

Deploy $ARGUMENTS to production:
1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

### Research Skill (Forked, Read-Only)
```yaml
---
name: analyze-deps
description: Analyze project dependencies for issues. Use for dependency audits.
context: fork
agent: Explore
allowed-tools: Read, Grep, Glob, Bash(npm *)
---

Analyze dependencies in $ARGUMENTS:
1. Read package.json and lock files
2. Identify outdated, deprecated, or vulnerable packages
3. Report findings with recommended actions
```

### Background Knowledge (Claude-Only)
```yaml
---
name: legacy-api-context
description: Context about the legacy API system architecture
user-invocable: false
---

The legacy API uses SOAP/XML over HTTP. Key endpoints:
- /api/v1/users - User management
- /api/v1/orders - Order processing
When working on the new API, maintain backwards compatibility with these endpoints.
```

### Read-Only Exploration
```yaml
---
name: explore-codebase
description: Explore codebase without making changes. Use for codebase orientation.
allowed-tools: Read, Grep, Glob
---

Explore the codebase focusing on $ARGUMENTS.
Summarize architecture, key patterns, and important files.
```

### Dynamic Context with Shell Commands
```yaml
---
name: pr-review
description: Review current pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## PR Context
- Diff: !`gh pr diff`
- Comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

Review this PR for:
1. Code quality and correctness
2. Test coverage
3. Security concerns
```

### Script-Bundled Skill (Visual Output)
```yaml
---
name: visualize-deps
description: Generate an interactive dependency graph visualization
allowed-tools: Bash(python *)
---

# Dependency Visualizer

Run the bundled visualization script:
```bash
python ~/.claude/skills/visualize-deps/scripts/graph.py .
```

Opens an interactive HTML file showing the project's dependency graph.
```

Skills can bundle scripts in any language. The script does the heavy lifting while Claude handles orchestration.

## Context Efficiency

Context window space is finite and shared between your skill content, conversation history, code being discussed, and Claude's reasoning. Every line of SKILL.md that loads into context is a line that can't hold something else. Write skills like you're paying per token — because you are.

### How Loading Works

```
Session start:
  → All skill DESCRIPTIONS load (2% of context budget)

Skill invoked (by user or Claude):
  → Full SKILL.md loads into context

Claude reads a reference during execution:
  → reference.md / examples.md load on demand
```

This three-tier system is intentional. Use it:

| Tier | File | Loads when | Cost | Put here |
|------|------|-----------|------|----------|
| 1 | Description (frontmatter) | Every session | Always paid | One-liner: what + when |
| 2 | SKILL.md | Every invocation | Paid per use | Core instructions, decision logic, workflow steps |
| 3 | reference.md, examples.md | On demand | Only when needed | Detailed docs, schemas, examples, edge cases |

### What to Split Out

**Move to reference.md if**:
- It's a lookup table or field-by-field reference (Claude can consult it when needed)
- It's edge case handling (only relevant 20% of the time)
- It's detailed validation rules or error catalogs
- It's background context that explains *why* rather than *what to do*
- Removing it wouldn't break the core workflow

**Move to examples.md if**:
- It's sample inputs/outputs showing expected format
- It's common patterns users might copy/adapt
- It's more than 2-3 inline examples (keep the best 1-2 in SKILL.md)

**Keep in SKILL.md if**:
- Claude needs it every single invocation to do the job
- It's a decision point ("if X, do Y")
- It's a step in the core workflow
- Removing it would cause Claude to do the wrong thing

### Size Targets

| File | Target | Ceiling | Notes |
|------|--------|---------|-------|
| Description | < 100 chars | 250 chars | Shorter = more room for other skill descriptions |
| SKILL.md | 200-300 lines | 500 lines | If you're over 300, look for reference material to extract |
| reference.md | Any length | Practical | Only loads on demand, but very large files still cost when read |
| examples.md | Any length | Practical | Same — on demand only |

### The Description Budget

All skill descriptions share a budget of **2% of context window** (fallback: 16,000 characters). This is across ALL skills, not per skill. If you have 30 skills with 200-char descriptions, that's 6,000 chars — fine. If each is 500 chars, that's 15,000 chars and you're hitting the ceiling.

Run `/context` to check for warnings about excluded skills. Override with `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable.

## Skill Discovery

### Where Claude Finds Skills

| Location | Path | Applies to |
|----------|------|------------|
| Enterprise | See managed settings | All users in organization |
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<skill-name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | Where plugin is enabled |

Higher-priority locations win: enterprise > personal > project. Plugin skills use `plugin-name:skill-name` namespace, so they cannot conflict.

### Monorepo Support

Claude automatically discovers skills from nested `.claude/skills/` directories when working in subdirectories. Example: editing `packages/frontend/src/App.tsx` also loads skills from `packages/frontend/.claude/skills/`.

### Additional Directories

Skills in `.claude/skills/` within `--add-dir` directories are loaded automatically and support live change detection — edit during a session without restarting.

## Compatibility

Skills follow the [Agent Skills](https://agentskills.io) open standard. Claude Code extends the standard with:
- Invocation control (`disable-model-invocation`, `user-invocable`)
- Subagent execution (`context: fork`, `agent`)
- Dynamic context injection (`` !`command` ``)
- Tool restrictions (`allowed-tools` with pattern support)
- Skill-scoped hooks (`hooks`)

### Migration from Commands

`.claude/commands/` files still work and support the same frontmatter. Skills are recommended since they support directories with supporting files. If a skill and command share the same name, the skill takes precedence.

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
Descriptions may exceed the context budget (2% of context window). Run `/context` to check. Override with `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable.

### Extended thinking
Include the word "ultrathink" in skill content to enable extended thinking mode.

## Official Documentation

For the most up-to-date information:
- Skills: https://code.claude.com/docs/en/skills
- Hooks: https://code.claude.com/docs/en/hooks
- Subagents: https://code.claude.com/docs/en/sub-agents
- Permissions: https://code.claude.com/docs/en/permissions
