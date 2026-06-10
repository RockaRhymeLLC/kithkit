/**
 * Granola API client — thin HTTP wrapper.
 * Reads API key from Keychain fresh on each call (never caches).
 */

import { readKeychain } from '../../core/keychain.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('granola-client');

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

export async function getKey(): Promise<string | null> {
  return readKeychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

// ── Type definitions ──────────────────────────────────────────

export interface GranolaAttendee {
  email: string;
  name?: string;
}

/** A single utterance in a Granola transcript (flat array returned by the API). */
export interface GranolaTranscriptEntry {
  speaker: string;
  text: string;
}

export interface GranolaNote {
  id: string;
  title: string;
  summary_markdown?: string;
  summary_text?: string;
  web_url?: string;
  calendar_event_id?: string;
  event_title?: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
  organiser?: string | GranolaAttendee;
  attendees?: GranolaAttendee[];
  owner_email?: string;
  created_at: string;
  updated_at: string;
  /** Flat array of {speaker, text} utterances. Populated only when include_transcript=true. */
  transcript?: GranolaTranscriptEntry[];
}

export interface GranolaCalendarEvent {
  event_title?: string;
  invitees?: Array<{ email: string }>;
  organiser?: string;
  calendar_event_id?: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
}

/** Full detail record returned by GET /v1/notes/:id */
export interface NoteDetail {
  id: string;
  title: string;
  web_url?: string;
  /** Flat array of {speaker, text} utterances from ?include_transcript=true. NOT a string or {segments:[]}. */
  transcript?: GranolaTranscriptEntry[];
  summary_text?: string;
  summary_markdown?: string;
  created_at: string;
  updated_at: string;
  calendar_event?: GranolaCalendarEvent;
  attendees?: GranolaAttendee[];
  owner?: { name?: string; email?: string };
}

export interface NotesPage {
  notes: GranolaNote[];
  cursor?: string;
  has_more: boolean;
}

// ── HTTP helper ───────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  apiKey: string,
  retries = 3,
): Promise<Response | null> {
  await rateLimit();

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt === retries) {
        log.error('Granola API request failed after retries', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      const backoff = Math.min(1000 * 2 ** attempt, 30_000);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (res.status === 401) {
      log.warn('Granola API: 401 Unauthorized — check API key in Keychain');
      return null;
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = Math.min(retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000, 5 * 60 * 1000);
      log.warn('Granola API: rate limited', { waitMs });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (res.status >= 500) {
      if (attempt === retries) {
        log.error('Granola API: 5xx error', { status: res.status });
        return null;
      }
      const backoff = Math.min(1000 * 2 ** attempt, 30_000);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    return res;
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────

export async function listNotes(
  baseUrl: string,
  params: { updated_after?: string; cursor?: string; limit?: number },
): Promise<NotesPage | null> {
  const apiKey = await getKey();
  if (!apiKey) {
    log.warn('Granola API key not found in Keychain — skipping listNotes');
    return null;
  }

  const qs = new URLSearchParams();
  if (params.updated_after) qs.set('updated_after', params.updated_after);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit) qs.set('limit', String(params.limit));

  const url = `${baseUrl}/v1/notes${qs.toString() ? '?' + qs.toString() : ''}`;
  const res = await fetchWithRetry(url, apiKey);
  if (!res) return null;

  try {
    const data = await res.json() as { notes?: GranolaNote[]; cursor?: string; has_more?: boolean };
    return {
      notes: data.notes ?? [],
      cursor: data.cursor,
      has_more: data.has_more ?? false,
    };
  } catch (err) {
    log.error('Failed to parse listNotes response', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function getNote(
  baseUrl: string,
  noteId: string,
  includeTranscript = false,
): Promise<NoteDetail | null> {
  const apiKey = await getKey();
  if (!apiKey) {
    log.warn('Granola API key not found in Keychain — skipping getNote');
    return null;
  }

  const qs = includeTranscript ? '?include_transcript=true' : '';
  const url = `${baseUrl}/v1/notes/${encodeURIComponent(noteId)}${qs}`;
  const res = await fetchWithRetry(url, apiKey);
  if (!res) return null;

  if (res.status === 404) {
    log.debug('Granola note not found (deleted?)', { noteId });
    return null;
  }

  try {
    return await res.json() as NoteDetail;
  } catch (err) {
    log.error('Failed to parse getNote response', {
      error: err instanceof Error ? err.message : String(err),
      noteId,
    });
    return null;
  }
}

/** Alias for getNote — preferred name for fetching full note detail. */
export const getNoteDetail = getNote;
