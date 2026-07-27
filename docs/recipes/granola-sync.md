# Recipe: Granola Meeting Notes Sync

Sync your [Granola](https://www.granola.ai) meeting notes into the Kithkit daemon on a schedule, link them to calendar events, and optionally extract action items as candidate todos using a Claude sub-agent.

This recipe polls the Granola public API for new/updated notes, caches them in the daemon's SQLite database, and (if enabled) runs each note through a lightweight classification prompt to surface action items for your review — no auto-created todos, every candidate needs an explicit approve/reject.

---

## Prerequisites

- A Granola account with API access and an API key
- Node.js 22+ (daemon runtime)
- The Kithkit daemon configured and running
- Claude API access configured (`askClaude()` helper) if you want action-item extraction — sync itself works without it

---

## Setup Steps

### Step 1 — Get a Granola API key

1. Sign in to your Granola account
2. Generate an API key from your account settings
3. Copy the key — it will be used as a Bearer token against the public API

### Step 2 — Store the key in Keychain

```bash
security add-generic-password \
  -s credential-granola-api \
  -a assistant \
  -w "YOUR_GRANOLA_API_KEY_HERE"
```

Verify it stored correctly:

```bash
security find-generic-password -s credential-granola-api -w
```

The client reads this key fresh on every call — it is never cached in memory, so a rotated key takes effect on the next request with no restart.

### Step 3 — Add the database tables

Add a migration (or reuse this one) that creates the three tables the extension needs: `granola_notes` (synced note cache), `granola_candidate_todos` (extracted action items awaiting review), and `granola_sync_state` (single-row cursor tracker). See the Reference Code section below for the full schema.

### Step 4 — Enable the extension in config

Add the `integrations.granola` block to your config (see Config Snippet below) and register the sync task in `scheduler.tasks`.

### Step 5 — Rebuild and restart the daemon

```bash
cd daemon && npm run build
launchctl unload ~/Library/LaunchAgents/com.your-agent.daemon.plist
launchctl load  ~/Library/LaunchAgents/com.your-agent.daemon.plist
```

### Step 6 — Verify

```bash
curl http://localhost:3847/api/granola/status
```

Expected response once the first sync has run:

```json
{
  "enabled": true,
  "last_sync_at": "2026-01-01T12:00:00.000Z",
  "last_sync_status": "ok",
  "key_present": true,
  "notes_count": 12,
  "candidates_pending": 3
}
```

Trigger a sync manually instead of waiting for the schedule:

```bash
curl -X POST http://localhost:3847/api/granola/sync
```

---

## Config Snippet

```yaml
integrations:
  granola:
    enabled: true
    poll_interval_minutes: 15
    include_transcripts: false   # fetch full transcripts (higher API usage)
    extraction_enabled: true     # run Claude sub-agent to extract action items
    extraction_model: "claude-sonnet-4-6"
    api_base_url: "https://public-api.granola.ai"

scheduler:
  tasks:
    - name: granola-sync
      interval: "15m"
      enabled: true
    - name: granola-extract
      # Runs a few minutes after sync so new notes have landed first
      cron: "7,22,37,52 * * * *"
      enabled: true
```

**Why sync and extraction are separate tasks**: extraction is offset from sync (`:07, :22, :37, :52` vs. sync on a plain 15-minute interval) so newly-synced notes are guaranteed to exist in the local cache before extraction scans for candidates. Coupling extraction inline with sync makes each note's processing dependent on the whole sync cycle finishing cleanly; splitting them means a stalled extraction run never blocks ingestion, and vice versa.

---

## Reference Code

### Database schema

```sql
CREATE TABLE IF NOT EXISTS granola_notes (
  note_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary_markdown TEXT,
  summary_text TEXT,
  web_url TEXT,
  calendar_event_id TEXT,
  event_title TEXT,
  scheduled_start_time DATETIME,
  scheduled_end_time DATETIME,
  organiser TEXT,
  attendees_json TEXT,
  owner_email TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  fetched_at DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_granola_notes_calendar_event_id ON granola_notes(calendar_event_id);
CREATE INDEX IF NOT EXISTS idx_granola_notes_scheduled_start_time ON granola_notes(scheduled_start_time);

CREATE TABLE IF NOT EXISTS granola_candidate_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES granola_notes(note_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  owner_guess TEXT,
  due_date_guess DATETIME,
  confidence REAL,
  state TEXT NOT NULL DEFAULT 'suggested',   -- suggested | approved | rejected | deferred
  approved_todo_id INTEGER,                  -- FK to todos.id once approved
  dedup_hash TEXT NOT NULL,                  -- sha256(note_id || text)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(dedup_hash)
);
CREATE INDEX IF NOT EXISTS idx_candidate_todos_note_id ON granola_candidate_todos(note_id);
CREATE INDEX IF NOT EXISTS idx_candidate_todos_state ON granola_candidate_todos(state);

CREATE TABLE IF NOT EXISTS granola_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_updated_after DATETIME,
  last_sync_at DATETIME,
  last_sync_status TEXT,       -- ok | error | disabled
  last_error TEXT
);
INSERT OR IGNORE INTO granola_sync_state (id) VALUES (1);
```

### API client with retry/backoff

The client rate-limits itself (200ms minimum between calls, ~5 req/s) and retries transient failures with exponential backoff. A 401 or a `null` API key aborts immediately rather than retrying — bad credentials are not transient.

```typescript
const KEYCHAIN_SERVICE = 'credential-granola-api';
const KEYCHAIN_ACCOUNT = 'assistant';
const MIN_INTER_CALL_MS = 200; // ~5 req/s max

let _lastCallAt = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastCallAt;
  if (elapsed < MIN_INTER_CALL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTER_CALL_MS - elapsed));
  }
  _lastCallAt = Date.now();
}

async function fetchWithRetry(url: string, apiKey: string, retries = 3): Promise<Response | null> {
  await rateLimit();

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 30_000)));
      continue;
    }

    if (res.status === 401) return null; // bad key — don't retry
    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = Math.min(retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000, 5 * 60 * 1000);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.status >= 500) {
      if (attempt === retries) return null;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 30_000)));
      continue;
    }
    return res;
  }
  return null;
}

export async function listNotes(
  baseUrl: string,
  params: { updated_after?: string; cursor?: string; limit?: number },
): Promise<{ notes: unknown[]; cursor?: string; has_more: boolean } | null> {
  const apiKey = await getKeyFromKeychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!apiKey) return null;

  const qs = new URLSearchParams();
  if (params.updated_after) qs.set('updated_after', params.updated_after);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));

  const res = await fetchWithRetry(`${baseUrl}/v1/notes?${qs}`, apiKey);
  if (!res) return null;
  const data = await res.json() as { notes?: unknown[]; cursor?: string; has_more?: boolean };
  return { notes: data.notes ?? [], cursor: data.cursor, has_more: data.has_more ?? false };
}
```

### Sync loop — cursor-paginated, resumable on partial failure

The sync cursor (`last_updated_after`) only advances when a full page cycle completes with zero errors. A partial failure leaves the cursor where it was, so the next scheduled run retries the same window instead of silently skipping notes.

```typescript
export async function syncNotes(config: GranolaConfig): Promise<{ new: number; updated: number; errors: number }> {
  const result = { new: 0, updated: 0, errors: 0 };
  const syncState = getSyncState();
  const updatedAfter = syncState.last_updated_after ?? undefined;

  let cursor: string | undefined;
  let maxUpdatedAt = updatedAfter ?? '';
  let pageCount = 0;
  const MAX_PAGES = 100; // circuit breaker against a runaway/misbehaving upstream

  do {
    const page = await listNotes(config.api_base_url, { updated_after: updatedAfter, cursor, limit: 50 });
    if (!page) { result.errors++; break; }

    for (const stub of page.notes as Array<{ id: string; updated_at: string }>) {
      await new Promise(r => setTimeout(r, 200)); // per-note detail fetch, same rate limit
      const detail = await getNoteDetail(config.api_base_url, stub.id);
      if (!detail) { result.errors++; continue; }

      const isNew = upsertNote(detail);
      isNew ? result.new++ : result.updated++;
      if (detail.updated_at > maxUpdatedAt) maxUpdatedAt = detail.updated_at;
    }

    cursor = page.cursor;
    pageCount++;
    if (pageCount >= MAX_PAGES) break;
  } while (cursor);

  if (result.errors === 0 && maxUpdatedAt) {
    updateSyncState({ last_updated_after: maxUpdatedAt, last_sync_at: new Date().toISOString(), last_sync_status: 'ok' });
  } else {
    updateSyncState({ last_sync_at: new Date().toISOString(), last_sync_status: 'error' });
  }

  return result;
}
```

### Calendar linking (read-only, best-effort)

Notes are matched to existing calendar events by exact ID first, then a fuzzy fallback (±30 min window, title substring or attendee-email overlap in the event description). This never writes to the calendar — it only annotates which note belongs to which event.

```typescript
async function linkNoteToCalendarEvent(note: GranolaNote): Promise<{ match: 'exact' | 'fuzzy' | 'none'; eventId?: string }> {
  const db = getDatabase();

  if (note.calendar_event_id) {
    const exact = db.prepare('SELECT id FROM calendar WHERE source = ? LIMIT 1').get(note.calendar_event_id);
    if (exact) return { match: 'exact', eventId: String((exact as { id: number }).id) };
  }

  if (!note.scheduled_start_time) return { match: 'none' };
  const startMs = new Date(note.scheduled_start_time).getTime();
  const windowStart = new Date(startMs - 30 * 60 * 1000).toISOString();
  const windowEnd = new Date(startMs + 30 * 60 * 1000).toISOString();

  const nearby = db.prepare(
    'SELECT id, title, description FROM calendar WHERE start_time >= ? AND start_time <= ?',
  ).all(windowStart, windowEnd) as Array<{ id: number; title: string; description: string | null }>;

  for (const row of nearby) {
    const titleMatch = titleSimilarity(note.title, row.title);
    const attendeeMatch = row.description
      ? (note.attendees ?? []).some(a => row.description!.toLowerCase().includes(a.email.toLowerCase()))
      : false;
    if (titleMatch || attendeeMatch) return { match: 'fuzzy', eventId: String(row.id) };
  }
  return { match: 'none' };
}
```

### Action-item extraction (Claude sub-agent)

Extraction runs as a separate scheduled task, offset a few minutes after sync (see Config Snippet). It scans for notes that have summary content but no candidate rows yet — this makes backfill automatic and re-extraction as simple as deleting the existing candidates for a note.

```typescript
const SYSTEM_PROMPT =
  'You are an assistant that extracts action items from meeting notes. ' +
  'Return ONLY a JSON array of objects with these fields: ' +
  '{"text": string, "owner_guess": string|null, "due_date_guess": string|null, "confidence": number}. ' +
  'due_date_guess must be ISO-8601 date or null. confidence is 0-1. ' +
  'Do not include items that are already complete or purely informational. ' +
  'Do not include any explanation or markdown — only the raw JSON array.';

export async function extractActionItems(note: GranolaNote, model: string): Promise<Candidate[]> {
  const userPrompt = [
    `Meeting: ${note.title}`,
    note.scheduled_start_time ? `Date: ${note.scheduled_start_time.slice(0, 10)}` : '',
    note.summary_markdown ? `Notes:\n${note.summary_markdown}` : '(No notes available)',
  ].filter(Boolean).join('\n');

  const response = await askClaude(userPrompt, { model, maxTokens: 1024, system: SYSTEM_PROMPT });
  if (!response) return [];

  const raw = response.content.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
  const items = JSON.parse(raw) as Array<{ text: string; owner_guess?: string; due_date_guess?: string; confidence?: number }>;

  return items
    .filter(item => item.text && (item.confidence ?? 0.5) >= 0.3)
    .map(item => ({
      note_id: note.id,
      text: item.text.trim(),
      owner_guess: item.owner_guess ?? null,
      due_date_guess: item.due_date_guess ?? null,
      confidence: item.confidence ?? 0.5,
      state: 'suggested' as const,
      dedup_hash: sha256(note.id + '\x00' + item.text.trim()),
    }));
}
```

### Candidate review endpoints

Extraction never creates real todos directly — it only inserts `suggested` candidates. A human (or the morning briefing surfacing `getPendingCandidatesFormatted()`) approves or rejects each one via:

```
GET  /api/granola/candidates?state=suggested
POST /api/granola/candidates/:id/approve   { "todo_text"?: string }
POST /api/granola/candidates/:id/reject
POST /api/granola/candidates/:id/defer
```

Approving creates a real todo and links it back to the candidate row (`approved_todo_id`), so the same action item is never suggested twice — the `dedup_hash` (`sha256(note_id + text)`) has a `UNIQUE` constraint that silently no-ops repeat inserts.

---

## Troubleshooting

**`key_present: false` in `/api/granola/status`**

- The Keychain entry is missing or under the wrong service/account name
- Verify: `security find-generic-password -s credential-granola-api -w`
- The extension checks for the key at startup and disables itself (non-fatally) if it's missing — check daemon logs for `Granola API key not found in Keychain`

**Sync runs but `notes_count` stays at 0**

- Confirm the extension is actually enabled: `integrations.granola.enabled: true` in config, then `POST /api/config/reload`
- Trigger a manual sync and inspect the result: `curl -X POST http://localhost:3847/api/granola/sync`
- Check `last_sync_status` — if it's `error`, check `last_error` for the upstream failure reason

**401 Unauthorized from the Granola API**

- The API key is invalid, revoked, or expired — regenerate it from your Granola account and update Keychain
- The client treats 401 as non-retryable by design (retrying a bad key wastes the rate-limit budget) — this is expected behavior, not a bug

**429 rate limited**

- The client already self-throttles to ~5 req/s and honors `Retry-After` on 429s (capped at 5 minutes) — if you're still hitting this consistently, lower `poll_interval_minutes` or check for other processes hitting the same API key concurrently

**Candidates never advance past `suggested`**

- Extraction only creates suggestions — nothing auto-approves. Someone has to hit the approve/reject/defer endpoints
- Check the morning-briefing (or equivalent) integration is actually surfacing `getPendingCandidatesFormatted()` output, otherwise pending candidates are invisible until you query the endpoint directly

**A note's extraction seems wrong — how to redo it**

```sql
DELETE FROM granola_candidate_todos WHERE note_id = '<note_id>';
```

The next `granola-extract` cycle re-processes any note with summary content and no existing candidates — no manual re-trigger needed.

**Calendar linking picks the wrong event**

- Fuzzy matching requires either a title substring match (min 5 chars) or an attendee/organiser email appearing in the calendar event's `description` field — if your calendar sync doesn't populate `description` with attendee emails, fuzzy matching degrades to title-only
- Exact matching (via `calendar_event_id` → `calendar.source`) is authoritative when available and always preferred — check that your calendar sync stores the iCal UID in the `source` column
