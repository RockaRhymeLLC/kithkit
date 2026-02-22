---
name: memory
description: Stores and retrieves persistent facts across sessions. Use when remembering something, looking up a fact, searching past conversations, or when information the user previously shared is needed.
argument-hint: [lookup "query" | add "fact" | list | search "term"]
---

# Memory Management

Store and retrieve persistent facts using the memory system. The daemon manages storage via HTTP API; individual memory files use YAML frontmatter for rich metadata.

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
- `/memory add "Partner's name is Sarah" category:person importance:high tags:family`

### List
- `list` - Show all memory entries
- `list category:work` - Show entries matching category

### Search
- `search "term"` - Full-text search across all memory files

### Conflicts
- `conflicts` - Scan for potential contradictions across memory files
- Groups memories by subject/person overlap and flags where content may conflict
- Advisory only — review results and resolve manually

## API Endpoints

Memory is managed via the daemon HTTP API (default: `http://localhost:3847`):

| Action | Method | Endpoint | Body / Notes |
|--------|--------|----------|--------------|
| Store a fact | `POST` | `/api/memory/store` | JSON body: `{ fact, category?, importance?, tags?, subject? }` |
| Search memories | `GET` | `/api/memory/search` | Query param: `q=search+term` |
| List memories | `GET` | `/api/memory/list` | Query param: `category=person` (optional) |
| Detect conflicts | `POST` | `/api/memory/conflicts` | No body required |

### Example: Store a fact
```bash
curl -X POST http://localhost:3847/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{"fact": "Prefers dark mode in all applications", "category": "preference", "importance": "medium"}'
```

### Example: Search memories
```bash
curl "http://localhost:3847/api/memory/search?q=email"
```

### Example: List by category
```bash
curl "http://localhost:3847/api/memory/list?category=person"
```

### Example: Run conflict detection
```bash
curl -X POST http://localhost:3847/api/memory/conflicts
```

## File Format

The daemon stores memories as individual markdown files with YAML frontmatter. Understanding this format helps interpret search results and conflict reports.

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
| `importance` | Yes | 5 (critical), 4 (high), 3 (medium), 2 (low), 1 (minimal) | 3 |
| `subject` | Yes | Brief subject line | Derived from fact |
| `tags` | Yes | Array of searchable tags | [] |
| `confidence` | Yes | 0.0 to 1.0 | 0.9 (user-stated), 0.7 (auto-extracted), 0.5 (inferred) |
| `source` | Yes | user, observation, extraction, system | user |

**All required fields are mandatory.** Use defaults when the value isn't obvious. The `source` field helps distinguish human-curated memories from auto-extracted ones.

### Updating Memories

**Edit in place** — the default approach. When a fact changes, the daemon updates the file directly. One file per topic, always current. Git preserves the full edit history if you ever need to see what something used to say.

**Inline history** — When previous values have ongoing relevance (e.g., a decision that changed and the reasoning matters), the daemon keeps both current and previous values in the same file:

```markdown
# User's Workplace

**Current**: Founded Initech (as of 2026-03-01)

**Previous**:
- Worked at Acme Corp (until 2026-02-28) — left to start own company
```

This keeps everything in one place — any query that finds the file gets the full picture.

### Authority Hierarchy

When multiple memories cover the same topic, authority determines which is trusted:

1. **Source** (highest to lowest): `user` > `observation` > `email`/`conversation` > `auto-extraction` > `system`
2. **Recency**: For equal source authority, the most recent memory wins
3. **Confidence**: Tiebreaker when source and date are similar

**Key rules:**
- User-stated facts are canonical. Auto-extraction should never contradict a `source: user` memory.
- Use `/memory conflicts` to surface potential contradictions for manual review.

### Categories
- `person` — People, contacts, relationships
- `preference` — How the user likes things
- `infrastructure` — Servers, hosting, deployment, networking
- `tool` — Specific tools, CLIs, libraries, APIs
- `architecture` — System design, patterns, approaches
- `account` — Usernames, services, non-secret identifiers
- `website` — Per-site web browsing learnings (selectors, navigation, quirks). Tag with domain.
- `decision` — Decisions made (with reasoning)
- `pattern` — Reusable approaches ("X is better than Y for Z")
- `other` — Anything else (minimize use)

Note: Legacy `technical` and `event` categories still exist on older files. New memories should use the categories above.

## Workflow

### Adding a Fact
1. Determine category, importance, tags from the fact and any explicit options
2. Call `POST /api/memory/store` with the fact and metadata
3. Confirm what was added (the API returns the created file details)

### Looking Up
1. Call `GET /api/memory/search?q=query`
2. Return matching facts with their source file and metadata
3. If nothing found, say so (don't guess)

### Listing
1. Call `GET /api/memory/list` with optional `category` filter
2. Display grouped by category

### Searching
1. Call `GET /api/memory/search?q=term`
2. Return matching lines with file context and frontmatter metadata

### Conflict Detection
1. Call `POST /api/memory/conflicts`
2. The API groups memories by subject/category similarity and identifies contradictions
3. Display as advisory report — flag potential conflicts, let user decide resolution

**Output format:**
```
## Memory Conflicts Report

### Group: The User
- 20260201-1200-user-identity.md (user, confidence 0.9) — "Prefers first name, works at Acme"
- 20260205-0900-user-work.md (auto-extraction, confidence 0.7) — "User works at Initech"
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

### Writing Good Memory Facts
- One fact or closely related group of facts per entry
- Use descriptive subjects for easy scanning
- Tag generously — tags are searchable
- Set importance appropriately (critical/high for permanent facts, medium for context-dependent)
- Use `source: user` when the user stated it directly
