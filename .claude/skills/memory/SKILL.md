---
name: memory
description: Look up and add facts to persistent memory. Use before asking the user questions they may have already answered.
argument-hint: [lookup "query" | add "fact" | list | search "term"]
---

# Memory Management (v2)

Store and retrieve persistent facts using the v2 memory system: individual files in `.claude/state/memory/memories/` with YAML frontmatter.

## Philosophy

**Check memory before asking.** If you need information that the user may have provided before (preferences, names, accounts, etc.), search memory first. Only ask if it's not there.

## Commands

Parse $ARGUMENTS to determine the action:

### Lookup
- `lookup "query"` - Search memory files for matching facts
- `"query"` - If argument looks like a search query, treat as lookup

Examples:
- `/memory lookup "email"` - Find email-related facts
- `/memory "preferred name"` - What do they like to be called?

### Add
- `add "fact"` - Add a new fact to memory
- `add "fact" category:preferences` - Add with category
- `add "fact" importance:high` - Add with importance level
- `add "fact" tags:tag1,tag2` - Add with tags
- Options can be combined: `add "fact" category:person importance:high tags:family,contact`

Examples:
- `/memory add "Prefers dark mode in all applications"`
- `/memory add "Wife's name is Sarah" category:person importance:high tags:family`

### List
- `list` - Show all memory entries
- `list category:work` - Show entries matching category

### Search
- `search "term"` - Full-text search across all memory files

### Conflicts
- `conflicts` - Scan for potential contradictions across memory files
- Groups memories by subject/person overlap and flags where content may conflict
- Advisory only — review results and resolve manually

## File Format (v2)

Memories are stored as individual markdown files in `.claude/state/memory/memories/`.

**Naming Convention**: `YYYYMMDD-HHMM-slug.md`

**File Structure**:
```markdown
---
date: 2026-01-27T09:00:00
category: person
importance: high
subject: Jane Smith
tags: [owner, identity]
confidence: 1.0
source: user
---

# Jane Smith — Identity

- **Name**: Jane Smith
- **Role**: Assistant owner/operator
```

### Frontmatter Fields

| Field | Required | Values | Default |
|-------|----------|--------|---------|
| `date` | Yes | ISO 8601 timestamp | Current time |
| `category` | Yes | person, preference, technical, account, event, decision, other | other |
| `importance` | Yes | critical, high, medium, low | medium |
| `subject` | Yes | Brief subject line | Derived from fact |
| `tags` | Yes | Array of searchable tags | [] |
| `confidence` | Yes | 0.0 to 1.0 | 0.9 (user-stated), 0.7 (auto-extracted), 0.5 (inferred) |
| `source` | Yes | user, observation, system, auto-extraction, email, conversation | user |
| `correction_for` | No | Filename of the memory this corrects (e.g., `20260201-1200-old-fact.md`) | — |

**All required fields are mandatory.** Use defaults when the value isn't obvious. The `source` field helps distinguish human-curated memories from auto-extracted ones.

### Authority Hierarchy

When multiple memories cover the same topic, authority determines which is trusted:

1. **Source** (highest to lowest): `user` > `observation` > `email`/`conversation` > `auto-extraction` > `system`
2. **Recency**: For equal source authority, the most recent memory wins
3. **Confidence**: Tiebreaker when source and date are similar

**Key rules:**
- User-stated facts are canonical. Auto-extraction should never contradict a `source: user` memory.
- When a user explicitly corrects a fact, set `correction_for` on the new memory to link it to the old one. The old memory remains for audit trail but the corrected version is authoritative.
- Use `/memory conflicts` to surface potential contradictions for manual review.

### Categories
- `person` — People, contacts, relationships
- `preference` — How the user likes things
- `technical` — Dev environment, tools, architecture
- `account` — Usernames, services, non-secret identifiers
- `event` — Things that happened (decays over time)
- `decision` — Decisions made (decays over time)
- `other` — Anything else

## Workflow

### Adding a Fact
1. Determine category, importance, tags from the fact and any explicit options
2. Generate a slug from the subject (kebab-case, max 40 chars)
3. Generate timestamp: `YYYYMMDD-HHMM`
4. Create the file at `.claude/state/memory/memories/YYYYMMDD-HHMM-slug.md`
5. Write YAML frontmatter + markdown content
6. Confirm what was added

**Generating the filename**:
```
Date: 2026-02-03 04:45 → 20260203-0445
Subject: "Prefers dark mode" → prefers-dark-mode
Filename: 20260203-0445-prefers-dark-mode.md
```

### Looking Up
1. Use Grep to search `.claude/state/memory/memories/` by keyword
2. Search both file content and frontmatter (tags, category, subject)
3. Return matching facts with their source file
4. If nothing found, say so (don't guess)

### Listing
1. Glob all `.md` files in `memories/` directory
2. If filtering by category, use Grep on frontmatter `category:` field
3. Display grouped by category

### Searching
1. Use Grep to search `.claude/state/memory/memories/` for the search term
2. Return matching lines with file context
3. Include frontmatter metadata (category, importance) in results

### Conflict Detection
1. Glob all `.md` files in `memories/` directory
2. Parse frontmatter from each file (subject, category, source, date, confidence)
3. Group memories by similarity:
   - Same person (category: person, same name in subject or body)
   - Same topic (similar subject lines or overlapping tags)
4. For each group with 2+ memories, compare content for contradictions
5. Display as advisory report — flag potential conflicts, let user decide resolution
6. When correcting a conflict: use `/memory add` with `correction_for:filename.md`

**Output format:**
```
## Memory Conflicts Report

### Group: Dave Hurley
- 20260201-1200-dave-identity.md (user, confidence 0.9) — "Prefers Dave, works at Acme"
- 20260205-0900-dave-work.md (auto-extraction, confidence 0.7) — "Dave works at Initech"
⚠️  Possible conflict: workplace

### No other conflicts found.
```

## Memory Architecture

### Sources of Truth
- **memories/** — Individual fact files with YAML frontmatter. The knowledge store. Created by `/memory add`, the Stop hook auto-extractor, or nightly consolidation.
- **timeline/** — Daily files with YAML frontmatter (date, sessions, topics, todos, highlights). Append-only, no compression. Created by nightly consolidation from 24hr.md entries.
- **24hr.md** — Ephemeral rolling state log. Entries rotate to timeline/ after 24 hours.

### Auto-Extraction
A Stop hook agent automatically scans conversation transcripts after each response and extracts new persistent facts into individual memory files. Tagged `source: auto-extraction`, `confidence: 0.7`.

### Nightly Consolidation (5am)
1. Reads 24hr.md entries older than 24 hours
2. Creates/appends to timeline/YYYY-MM-DD.md daily files (with frontmatter)
3. Extracts new facts as individual memory files
4. Removes processed entries from 24hr.md

### Timeline Retrieval
- Scan frontmatter without loading body: `Read(file, limit: 10)` or `Grep("topics:.*voice", path: "timeline/")`
- Load specific days: `Glob("timeline/2026-02-0[1-7].md")`
- Search across timeline: `Grep("highlights:.*shipped", path: "timeline/")`

## Output Format

### Lookup Result
```
## Memory Lookup: "email"

Found 2 matches:

**20260127-1000-email-accounts.md** (account, high)
- Primary email: user@example.com
- Secondary email: user@fastmail.com

**20260127-0905-manager-contact.md** (person, high)
- Manager email: manager@company.com
```

### Add Confirmation
```
Added to memory:
  File: 20260203-0445-prefers-dark-mode.md
  Category: preference | Importance: medium
  "Prefers dark mode in all applications"
```

## Best Practices

### What to Remember
- Stated preferences
- Names of people they mention
- Account identifiers (not passwords!)
- Technical preferences and setup
- Important dates
- Frequently referenced information

### What NOT to Remember
- Passwords or secrets (use Keychain)
- Temporary information
- One-time context
- Sensitive data without permission

### Writing Good Memory Files
- One fact or closely related group of facts per file
- Use descriptive subjects for easy scanning
- Tag generously — tags are searchable
- Set importance appropriately (critical/high for permanent facts, medium for context-dependent)
- Use `source: user` when the user stated it directly

## Migration Note

The legacy `.claude/state/memory.md` file is deprecated. All new facts should be written to individual files in `memory/memories/`. The legacy file is kept for reference but is no longer updated.
