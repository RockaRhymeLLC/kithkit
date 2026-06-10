/**
 * Granola SQLite CRUD — uses existing db handle, no new connection.
 */

import { getDatabase } from '../../core/db.js';
import type { NoteDetail, GranolaAttendee } from './client.js';

// ── Types ─────────────────────────────────────────────────────

export interface NoteRow {
  note_id: string;
  title: string;
  summary_markdown: string | null;
  summary_text: string | null;
  web_url: string | null;
  calendar_event_id: string | null;
  event_title: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
  organiser: string | null;
  attendees_json: string | null;
  owner_email: string | null;
  created_at: string;
  updated_at: string;
  fetched_at: string;
}

export interface Candidate {
  id?: number;
  note_id: string;
  text: string;
  owner_guess?: string | null;
  due_date_guess?: string | null;
  confidence?: number | null;
  state: 'suggested' | 'approved' | 'rejected' | 'deferred';
  approved_todo_id?: number | null;
  dedup_hash: string;
  created_at?: string;
  updated_at?: string;
}

export interface SyncState {
  id: 1;
  last_updated_after: string | null;
  last_sync_at: string | null;
  last_sync_status: 'ok' | 'error' | 'disabled' | null;
  last_error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────

function attendeesJson(attendees?: GranolaAttendee[]): string | null {
  if (!attendees || attendees.length === 0) return null;
  return JSON.stringify(attendees);
}

// ── Notes ─────────────────────────────────────────────────────

/**
 * Upsert a Granola note from a full detail record (nested API shape).
 * Flattens calendar_event into individual columns.
 * Returns true if this was a new insert (not an update).
 */
export function upsertNote(note: NoteDetail): boolean {
  const db = getDatabase();
  const now = new Date().toISOString();
  const ce = note.calendar_event;

  const existing = db.prepare(
    'SELECT note_id FROM granola_notes WHERE note_id = ?',
  ).get(note.id);

  db.prepare(`
    INSERT INTO granola_notes
      (note_id, title, summary_markdown, summary_text, web_url,
       calendar_event_id, event_title, scheduled_start_time, scheduled_end_time,
       organiser, attendees_json, owner_email, created_at, updated_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id) DO UPDATE SET
      title = excluded.title,
      summary_markdown = excluded.summary_markdown,
      summary_text = excluded.summary_text,
      web_url = excluded.web_url,
      calendar_event_id = excluded.calendar_event_id,
      event_title = excluded.event_title,
      scheduled_start_time = excluded.scheduled_start_time,
      scheduled_end_time = excluded.scheduled_end_time,
      organiser = excluded.organiser,
      attendees_json = excluded.attendees_json,
      owner_email = excluded.owner_email,
      updated_at = excluded.updated_at,
      fetched_at = excluded.fetched_at
  `).run(
    note.id,
    note.title,
    note.summary_markdown ?? null,
    note.summary_text ?? null,
    note.web_url ?? null,
    ce?.calendar_event_id ?? null,
    ce?.event_title ?? null,
    ce?.scheduled_start_time ?? null,
    ce?.scheduled_end_time ?? null,
    ce?.organiser ?? null,
    attendeesJson(note.attendees),
    note.owner?.email ?? null,
    note.created_at,
    note.updated_at,
    now,
  );

  return !existing;
}

export function getNote(noteId: string): NoteRow | null {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM granola_notes WHERE note_id = ?').get(noteId) as NoteRow | undefined) ?? null;
}

export function queryNotesByDate(date: string): NoteRow[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM granola_notes WHERE date(scheduled_start_time) = ? ORDER BY scheduled_start_time ASC",
  ).all(date) as NoteRow[];
}

export function queryNotesByRange(from: string, to: string): NoteRow[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM granola_notes WHERE scheduled_start_time >= ? AND scheduled_start_time <= ? ORDER BY scheduled_start_time ASC",
  ).all(from, to) as NoteRow[];
}

export function queryNotesByCalendarEventId(eventId: string): NoteRow[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM granola_notes WHERE calendar_event_id = ? ORDER BY scheduled_start_time ASC",
  ).all(eventId) as NoteRow[];
}

export function countNotes(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as n FROM granola_notes').get() as { n: number };
  return row.n;
}

/**
 * Returns notes that have summary content but no candidate todos yet.
 * Used by the granola-extract task to determine what needs processing.
 *
 * Note: `isNew` return from upsertNote is retained for diagnostics but no longer gates
 * extraction. Extraction is triggered by the needs-extraction list (this query).
 * To re-extract a note's candidates:
 *   DELETE FROM granola_candidate_todos WHERE note_id = '<id>';
 * The next granola-extract cycle will re-process it automatically.
 */
export function listNotesNeedingExtraction(limit: number = 100): NoteRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT n.* FROM granola_notes n
    WHERE NOT EXISTS (
      SELECT 1 FROM granola_candidate_todos WHERE note_id = n.note_id
    )
    AND n.summary_markdown IS NOT NULL
    AND length(n.summary_markdown) > 0
    ORDER BY n.updated_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as NoteRow[];
}

// ── Candidates ────────────────────────────────────────────────

export function insertCandidate(c: Candidate): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO granola_candidate_todos
      (note_id, text, owner_guess, due_date_guess, confidence, state, dedup_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedup_hash) DO NOTHING
  `).run(
    c.note_id,
    c.text,
    c.owner_guess ?? null,
    c.due_date_guess ?? null,
    c.confidence ?? null,
    c.state,
    c.dedup_hash,
  );
}

export function listCandidates(state?: string): Candidate[] {
  const db = getDatabase();
  if (state) {
    return db.prepare(
      'SELECT * FROM granola_candidate_todos WHERE state = ? ORDER BY created_at DESC',
    ).all(state) as Candidate[];
  }
  return db.prepare(
    'SELECT * FROM granola_candidate_todos ORDER BY created_at DESC',
  ).all() as Candidate[];
}

export function getCandidate(id: number): Candidate | null {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM granola_candidate_todos WHERE id = ?').get(id) as Candidate | undefined) ?? null;
}

export function updateCandidateState(
  id: number,
  newState: Candidate['state'],
  approvedTodoId?: number,
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE granola_candidate_todos
    SET state = ?, approved_todo_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newState, approvedTodoId ?? null, id);
}

export function countCandidatesByState(state: string): number {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT COUNT(*) as n FROM granola_candidate_todos WHERE state = ?',
  ).get(state) as { n: number };
  return row.n;
}

// ── Sync state ────────────────────────────────────────────────

export function getSyncState(): SyncState {
  const db = getDatabase();
  return (db.prepare('SELECT * FROM granola_sync_state WHERE id = 1').get() as SyncState | undefined) ?? {
    id: 1,
    last_updated_after: null,
    last_sync_at: null,
    last_sync_status: null,
    last_error: null,
  };
}

export function updateSyncState(patch: Partial<Omit<SyncState, 'id'>>): void {
  const db = getDatabase();
  const fields = Object.keys(patch) as Array<keyof typeof patch>;
  if (fields.length === 0) return;
  const set = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => patch[f] ?? null);
  db.prepare(`UPDATE granola_sync_state SET ${set} WHERE id = 1`).run(...values);
}

// ── Briefing helper ───────────────────────────────────────────

/**
 * Returns a formatted string of pending candidate todos for use in morning briefing.
 * Non-throwing.
 */
export function getPendingCandidatesFormatted(): string {
  try {
    const candidates = listCandidates('suggested');
    if (candidates.length === 0) return '';
    const lines = [
      `\n## Meeting Action Items (${candidates.length} awaiting review)\n`,
      ...candidates.slice(0, 10).map((c, i) => {
        const due = c.due_date_guess ? ` (due: ${c.due_date_guess.slice(0, 10)})` : '';
        const owner = c.owner_guess ? ` — ${c.owner_guess}` : '';
        return `${i + 1}. ${c.text}${due}${owner}\n` +
          `   Approve: POST /api/granola/candidates/${c.id}/approve\n` +
          `   Reject:  POST /api/granola/candidates/${c.id}/reject`;
      }),
    ];
    if (candidates.length > 10) lines.push(`\n…and ${candidates.length - 10} more. GET /api/granola/candidates?state=suggested`);
    return lines.join('\n');
  } catch {
    return '';
  }
}
