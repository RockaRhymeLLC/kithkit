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
- Searches by category/subject, groups overlapping memories, flags where content may conflict
- Advisory only — review results and resolve manually
- Note: No dedicated API endpoint — uses search to find and compare related memories

## API

Memory is managed via the daemon HTTP API (default: `http://localhost:3847`):

| Action | Method | Endpoint |
|--------|--------|----------|
| Store | `POST` | `/api/memory/store` |
| Search | `POST` | `/api/memory/search` |
| Get by ID | `GET` | `/api/memory/:id` |
| Delete | `DELETE` | `/api/memory/:id` |

Note: There is no list-all or conflict-detection endpoint. To list, search with a `category` filter and no `query`. See [reference.md](reference.md) for full API details and curl examples.

## Workflow

### Adding a Fact
1. Determine category, importance, tags from the fact and any explicit options
2. Call `POST /api/memory/store` with the fact and metadata
3. Confirm what was added (the API returns the created file details)

### Looking Up
1. Call `POST /api/memory/search` with `{"query": "search term"}`
2. Return matching facts with their metadata
3. If nothing found, say so (don't guess)

### Listing
1. Call `POST /api/memory/search` with `{"category": "person"}` (or other category filter, no `query` needed)
2. Display grouped by category

### Searching
1. Call `POST /api/memory/search` with `{"query": "term"}`
2. Return matching memories with metadata

### Conflict Detection
There is no daemon endpoint for conflict detection. To surface potential contradictions:
1. Search by relevant category or subject filters using `POST /api/memory/search`
2. Review returned memories for contradictions
3. Display as advisory report — flag potential conflicts, let user decide resolution

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

## References

- [reference.md](reference.md) — File format, frontmatter fields, categories, authority hierarchy, memory architecture, API endpoint details, and conflict detection
