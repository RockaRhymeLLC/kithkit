# Memory API Reference

Store, search, retrieve, and delete persistent memories. Supports keyword, vector, and hybrid search modes.

## POST /api/memory/store

Store a new memory. Embeddings are auto-generated if vector search is enabled.

```bash
curl -X POST http://localhost:3847/api/memory/store \
  -H 'Content-Type: application/json' \
  -d '{"content": "User prefers dark mode", "type": "fact", "category": "preferences", "tags": ["ui"]}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | The memory content |
| `type` | string | no | `fact`, `episodic`, or `procedural` (default: `fact`) |
| `category` | string | no | Grouping label (e.g., `preferences`, `person`, `infrastructure`) |
| `tags` | string[] | no | Tags for OR-match filtering |
| `source` | string | no | Origin label (e.g., `user`, `conversation`, `extraction`) |
| `dedup` | boolean | no | If `true` and vector search is enabled, checks for similar existing memories before storing |

**Responses:**

| Status | Body |
|--------|------|
| 201 | Full memory object with `id`, `content`, `type`, `category`, `tags`, `source`, timestamps |
| 200 | (dedup mode) `{ "action": "review_duplicates", "duplicates": [...], "proposed": {...} }` — caller decides whether to store |
| 400 | Missing content or invalid type |

**Dedup behavior:**
- When `dedup: true`, the API checks vector similarity before storing
- If similar memories found (similarity >= 0.85), returns them for review instead of storing
- The caller (agent) decides whether to proceed — vector similarity can give false positives
- If no duplicates found, stores normally

**Gotchas:**
- Embedding generation is async but non-blocking — if it fails, the memory is still stored (just without vector indexing)
- Tags are stored as a JSON string internally but returned as an array in the API response
- `type` must be exactly `fact`, `episodic`, or `procedural` — anything else returns 400

---

## POST /api/memory/search

Search memories. Three modes available: keyword (default), vector, hybrid.

### Keyword search (default)

Multi-word queries use AND matching. Tags use OR matching. Results ranked by keyword occurrence frequency.

```bash
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "dark mode preferences"}'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | no | `keyword` (default), `vector`, or `hybrid` |
| `query` | string | conditional | Required for vector/hybrid; optional for keyword if other filters provided |
| `tags` | string[] | no | OR-match across tags |
| `category` | string | no | Exact match |
| `type` | string | no | Exact match (`fact`, `episodic`, `procedural`) |
| `date_from` | string | no | ISO date — filter `created_at >=` |
| `date_to` | string | no | ISO date — filter `created_at <=` |
| `limit` | number | no | Max results (vector/hybrid only, default: 10) |

**Keyword mode notes:**
- Multi-word queries: each word must match (AND logic via SQL LIKE)
- Tags: any matching tag qualifies (OR logic)
- Results sorted by keyword occurrence count, then recency
- At least one of `query`, `tags`, `category`, `type`, `date_from`, or `date_to` required

### Vector search

Semantic similarity using embeddings.

```bash
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"mode": "vector", "query": "how the user likes to communicate", "limit": 5}'
```

### Hybrid search

Combines keyword and vector results.

```bash
curl -X POST http://localhost:3847/api/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"mode": "hybrid", "query": "response style preferences", "limit": 10}'
```

**Responses:**

| Status | Body |
|--------|------|
| 200 | `{ "data": [/* memory objects */], "mode": "keyword", "timestamp": "..." }` |
| 400 | Missing query or filters |
| 503 | Vector search not initialized (for vector/hybrid modes) |

**Gotchas:**
- Vector/hybrid modes return 503 if sqlite-vec is not loaded
- Search updates `last_accessed` on returned memories (access tracking)
- There is no list-all endpoint — to list, use `POST /api/memory/search` with just a `category` filter

---

## GET /api/memory/:id

Retrieve a single memory by ID. Updates `last_accessed`.

```bash
curl http://localhost:3847/api/memory/42
```

| Status | Response |
|--------|----------|
| 200 | Memory object (with parsed tags array) |
| 404 | `{ "error": "Not found" }` |

---

## DELETE /api/memory/:id

Permanently delete a memory.

```bash
curl -X DELETE http://localhost:3847/api/memory/42
```

| Status | Response |
|--------|----------|
| 204 | No body |
| 404 | `{ "error": "Not found" }` |
