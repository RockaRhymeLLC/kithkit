# Agent Profiles

Agent profiles define capabilities and constraints for worker agents. They live in `.claude/agents/*.md` and use YAML frontmatter for structured fields.

## Profile Format

```markdown
---
name: profile-name
description: What this worker does
tools:
  - Read
  - Glob
  - Grep
disallowedTools:
  - Bash
  - Edit
  - Write
model: sonnet
permissionMode: bypassPermissions
maxTurns: 20
---

System prompt / behavioral instructions for this worker type.
Everything after the frontmatter becomes the worker's system prompt.
```

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | **yes** | — | Profile identifier (used in spawn requests) |
| `description` | string | no | `""` | Human-readable description |
| `tools` | string[] | no | `[]` | Claude Code tools this worker can use |
| `disallowedTools` | string[] | no | `[]` | Tools explicitly blocked |
| `model` | string | no | `"sonnet"` | Claude model to use |
| `permissionMode` | string | no | `"bypassPermissions"` | One of: `default`, `acceptEdits`, `bypassPermissions`, `plan` |
| `maxTurns` | number | no | `20` | Maximum agentic turns before stopping |

The markdown body (everything after the `---` frontmatter closing) becomes the worker's system prompt, appended to the base SDK configuration.

## Validation Rules

- `name` is the only required field
- `permissionMode` must be one of the 4 valid values if provided
- `maxTurns` must be a positive integer if provided
- `tools` and `disallowedTools` must be arrays if provided
- Unknown fields are silently ignored (forward-compatible)

## Built-in Profiles

Kithkit ships 6 built-in worker profiles in the `profiles/` directory. They're copied to `.claude/agents/` during `kithkit init`. Two additional system profiles (`orchestrator` and `memory-worker`) are created in `.claude/agents/` for internal use.

### research

Read-only research worker for information gathering and analysis.

- **Tools**: Read, Glob, Grep, WebSearch, WebFetch, Task
- **Blocked**: Bash, Edit, Write, NotebookEdit
- **Max turns**: 20
- **Use for**: Information gathering, codebase exploration, fact-checking

### coding

Full-capability code implementation worker.

- **Tools**: Read, Glob, Grep, Edit, Write, Bash, Task
- **Blocked**: (none)
- **Max turns**: 30
- **Use for**: Feature implementation, bug fixes, refactoring

### testing

Test runner — executes tests and reports results without modifying code.

- **Tools**: Read, Glob, Grep, Bash, Task
- **Blocked**: Edit, Write, NotebookEdit
- **Max turns**: 15
- **Use for**: Running test suites, regression testing, CI validation

### email

Email composition worker — drafts emails without sending.

- **Tools**: Read, Glob, Grep, WebSearch
- **Blocked**: Bash, Edit, Write, NotebookEdit
- **Max turns**: 10
- **Use for**: Drafting professional emails, email triage

### review

Code review worker — reviews PRs, diffs, and implementation quality.

- **Tools**: Read, Glob, Grep, WebSearch, Task
- **Blocked**: Bash, Edit, Write, NotebookEdit
- **Max turns**: 20
- **Use for**: Code review, spec review, design review

### devils-advocate

Challenges plans and designs to find weaknesses and simpler alternatives.

- **Tools**: Read, Glob, Grep, WebSearch
- **Blocked**: Bash, Edit, Write, NotebookEdit
- **Max turns**: 15
- **Use for**: Pre-build review, stress-testing designs, finding edge cases

### System Profiles

These are created in `.claude/agents/` and used internally by the daemon.

#### orchestrator

Task orchestrator — decomposes work, delegates to workers, reports results.

- **Model**: opus
- **Max turns**: 200
- **Use for**: Complex multi-step tasks escalated from comms

#### memory-worker

Memory consolidation and cleanup worker.

- **Tools**: Bash
- **Model**: haiku
- **Max turns**: 40
- **Use for**: Deduplication, consolidation, and cleanup of the memory store

## Creating Custom Profiles

Create a new `.md` file in `.claude/agents/` with the frontmatter format above. The profile name must be unique. Example:

```markdown
---
name: data-analyst
description: Analyzes data files and generates reports
tools:
  - Read
  - Glob
  - Grep
  - Bash
disallowedTools:
  - Edit
  - Write
model: sonnet
permissionMode: bypassPermissions
maxTurns: 25
---

You are a data analysis worker. Analyze the provided data files and generate clear, actionable reports.

Rules:
- Use Bash only for running analysis scripts, not for modifying files.
- Present findings with specific numbers and citations.
- Flag anomalies and unexpected patterns.
```

## Spawning Workers

Use the daemon API to spawn a worker with a profile:

```bash
curl -X POST http://localhost:3847/api/agents/spawn \
  -H 'Content-Type: application/json' \
  -d '{"profile": "research", "prompt": "Find the top 3 TypeScript testing frameworks"}'
```

The daemon loads the profile from `.claude/agents/research.md`, applies its tool permissions and system prompt, and spawns the worker via the Agent SDK.
