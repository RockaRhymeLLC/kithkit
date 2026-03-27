# Memory System Reference

Detailed reference for the memory file format, architecture, and advanced usage.

## File Format

The daemon stores memories as individual markdown files with YAML frontmatter.

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
| `category` | Yes | person, preference, infrastructure, tool, architecture, account, website, decision, pattern, other | other |
| `importance` | Yes | 5 (critical), 4 (high), 3 (medium), 2 (low), 1 (minimal) | 3 |
| `subject` | Yes | Brief subject line | Derived from fact |
| `tags` | Yes | Array of searchable tags | [] |
| `confidence` | Yes | 0.0 to 1.0 | 0.9 (user-stated), 0.7 (auto-extracted), 0.5 (inferred) |
| `source` | Yes | user, observation, extraction, system | user |

**All required fields are mandatory.** Use defaults when the value isn't obvious. The `source` field helps distinguish human-curated memories from auto-extracted ones.

### Categories

- `person` — People, contacts, relationships
- `preference` — How the user likes things
- `infrastructure` — Servers, hosting, deployment, networking
- `tool` — Specific tools, CLIs, libraries, APIs
- `architecture` — System design, patterns, approaches
- `account` — Usernames, services, non-secret identifiers
- `website` — Per-site web browsing learnings (selectors, navigation, quirks). Tag with domain
- `decision` — Decisions made (with reasoning)
- `pattern` — Reusable approaches ("X is better than Y for Z")
- `other` — Anything else (minimize use)

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
- Use the conflicts command to surface potential contradictions for manual review.

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

## API Endpoints

Memory is managed via the daemon HTTP API (default: `http://localhost:3847`):

| Action | Method | Endpoint | Body / Notes |
|--------|--------|----------|--------------|
| Store a memory | `POST` | `/api/memory/store` | JSON body: `{ content, type?, category?, tags?, source? }` |
| Search memories | `POST` | `/api/memory/search` | JSON body: `{ query?, tags?, category?, type?, date_from?, date_to?, mode? }` |
| Get a memory | `GET` | `/api/memory/:id` | Returns single memory by numeric ID |
| Delete a memory | `DELETE` | `/api/memory/:id` | Permanently removes memory by numeric ID |

Search supports three modes via the `mode` field: `keyword` (default, SQL LIKE), `vector` (semantic, requires vector search enabled), `hybrid` (keyword + vector combined).

Note: There is no list-all endpoint or conflict-detection endpoint. To list memories, use `POST /api/memory/search` with a `category` filter and no `query`.

### Example: Store a memory
```bash
curl -X POST http://localhost:3847/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{"content": "Prefers dark mode in all applications", "category": "preference", "type": "fact"}'
```

### Example: Search memories by keyword
```bash
curl -X POST http://localhost:3847/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "email"}'
```

### Example: Filter by category
```bash
curl -X POST http://localhost:3847/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"category": "person"}'
```

### Example: Get a specific memory
```bash
curl http://localhost:3847/api/memory/42
```

## Conflict Detection

There is no daemon endpoint for conflict detection. To surface potential contradictions:

1. Search by relevant category or subject filters using `POST /api/memory/search`
2. Review returned memories for contradictions
3. Display as advisory report — flag potential conflicts, let user decide resolution

**Example output:**
```
## Memory Conflicts Report

### Group: The User
- 20260201-1200-user-identity.md (user, confidence 0.9) — "Prefers first name, works at Acme"
- 20260205-0900-user-work.md (auto-extraction, confidence 0.7) — "User works at Initech"
⚠️  Possible conflict: workplace

### No other conflicts found.
```
