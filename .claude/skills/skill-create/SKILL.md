# skill-create

Create new Kithkit skills with quality gates.

## Usage

```
/skill-create <skill-name>
```

## What It Does

1. Creates a skill directory in `.claude/skills/<skill-name>/` with the required structure:
   - `SKILL.md` — skill documentation and instructions
   - `manifest.yaml` — skill metadata (name, version, description, author, capabilities)

2. Runs the Kithkit linter against the new skill to catch issues before publishing:
   - Structure checks (required files present)
   - Manifest validation (fields, types, naming)
   - Security checks (no credential leaks, no suspicious patterns)
   - Scope checks (capabilities match actual tool usage)
   - Unicode checks (no homoglyph attacks)
   - Naming checks (valid package name format)

3. Reports results with clear pass/fail and actionable findings.

## Skill Structure

A valid skill requires at minimum:

```
my-skill/
├── manifest.yaml    # Required — skill metadata
└── SKILL.md         # Required — instructions and documentation
```

### manifest.yaml

```yaml
name: my-skill
version: "1.0.0"
description: What this skill does
author:
  name: Your Name
  github: your-github-username
capabilities:
  required:
    - read          # Tools this skill needs
    - web-search
  optional:
    - bash          # Tools it can use but doesn't require
tags:
  - category-tag
trust_level: community
```

### SKILL.md

The skill's documentation and behavioral instructions. This file is loaded into the agent's context when the skill is invoked. Write clear, specific instructions.

## Quality Gate

The linter must pass (0 errors) before a skill is considered ready. Warnings are informational and don't block.

### Linter Checks

| Check | What It Catches |
|-------|----------------|
| Structure | Missing required files (manifest.yaml, SKILL.md) |
| Manifest | Invalid fields, missing required metadata, bad version format |
| Security | Credential patterns, exfiltration attempts, prompt injection |
| Scope | Declared capabilities vs actual tool usage mismatches |
| Unicode | Homoglyph characters, invisible Unicode, bidirectional overrides |
| Naming | Invalid package names, typosquatting detection |

## Workflow

```bash
# Create a new skill
/skill-create my-cool-skill

# Edit the generated files
# ... customize SKILL.md and manifest.yaml ...

# Re-lint to verify
npx kithkit-linter .claude/skills/my-cool-skill/

# Publish to the catalog (when ready)
npx kithkit publish .claude/skills/my-cool-skill/
```
