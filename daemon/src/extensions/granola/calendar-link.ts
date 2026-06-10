/**
 * Calendar link — attempts to match a Granola note to a local calendar event.
 * Read-only. Does NOT modify the calendar or M365 cache.
 *
 * Strategy:
 *   1. Exact: match calendar_event_id against calendar.source field (M365 stores iCal uid there)
 *   2. Fuzzy: same date ±30 min, title substring match OR attendee email overlap
 */

import { getDatabase } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';
import type { GranolaNote, GranolaAttendee } from './client.js';

const log = createLogger('granola-calendar-link');

interface CalendarRow {
  id: number;
  title: string;
  start_time: string;
  end_time: string | null;
  source: string | null;
  description: string | null;
}

export interface LinkResult {
  match: 'exact' | 'fuzzy' | 'none';
  eventId?: string;
  eventTitle?: string;
}

function attendeeEmails(attendees?: GranolaAttendee[]): Set<string> {
  if (!attendees) return new Set();
  return new Set(attendees.map(a => a.email.toLowerCase()));
}

function titleSimilarity(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  // Check if either is a substring of the other (min 5 chars to avoid false positives)
  return (na.length >= 5 && nb.includes(na)) || (nb.length >= 5 && na.includes(nb));
}

export async function linkNoteToCalendarEvent(note: GranolaNote): Promise<LinkResult> {
  const db = getDatabase();

  // 1. Exact match by calendar_event_id → calendar.source
  if (note.calendar_event_id) {
    const exact = db.prepare(
      "SELECT id, title, source FROM calendar WHERE source = ? LIMIT 1",
    ).get(note.calendar_event_id) as CalendarRow | undefined;

    if (exact) {
      log.debug('Granola note matched calendar event exactly', {
        noteId: note.id,
        calendarId: exact.id,
      });
      return { match: 'exact', eventId: String(exact.id), eventTitle: exact.title };
    }
  }

  // 2. Fuzzy match by date + title/attendees
  if (!note.scheduled_start_time) {
    return { match: 'none' };
  }

  const startMs = new Date(note.scheduled_start_time).getTime();
  if (isNaN(startMs)) return { match: 'none' };

  const windowStart = new Date(startMs - 30 * 60 * 1000).toISOString();
  const windowEnd = new Date(startMs + 30 * 60 * 1000).toISOString();

  const nearby = db.prepare(
    "SELECT id, title, start_time, end_time, source, description FROM calendar " +
    "WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC",
  ).all(windowStart, windowEnd) as CalendarRow[];

  if (nearby.length === 0) return { match: 'none' };

  const emails = attendeeEmails(note.attendees);
  const organiserEmail = typeof note.organiser === 'string'
    ? note.organiser.toLowerCase()
    : (note.organiser as GranolaAttendee | undefined)?.email.toLowerCase();

  for (const row of nearby) {
    const titleMatch = note.title ? titleSimilarity(note.title, row.title) : false;

    let attendeeMatch = false;
    if (row.description) {
      const desc = row.description.toLowerCase();
      for (const email of emails) {
        if (desc.includes(email)) { attendeeMatch = true; break; }
      }
      if (!attendeeMatch && organiserEmail && desc.includes(organiserEmail)) {
        attendeeMatch = true;
      }
    }

    if (titleMatch || attendeeMatch) {
      log.debug('Granola note fuzzy-matched calendar event', {
        noteId: note.id,
        calendarId: row.id,
        titleMatch,
        attendeeMatch,
      });
      return { match: 'fuzzy', eventId: String(row.id), eventTitle: row.title };
    }
  }

  return { match: 'none' };
}
