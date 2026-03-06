/**
 * CalDAV Client — fetches calendar events via the CalDAV protocol.
 *
 * Uses raw HTTP REPORT requests with calendar-query XML bodies.
 * No external dependencies — uses Node.js built-in fetch().
 *
 * Replaces the icalbuddy dependency which is no longer available in Homebrew.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../../core/logger.js';

const log = createLogger('caldav-client');

// ── Types ────────────────────────────────────────────────────

export interface CalDAVConfig {
  url: string;
  username: string;
  password: string;
}

export interface CalendarEvent {
  title: string;
  startTime: string;   // ISO-ish or HH:MM
  endTime: string;
  allDay: boolean;
}

// ── Keychain resolution ──────────────────────────────────────

/**
 * Resolve a password value — if it starts with "keychain:", look it up
 * in the macOS Keychain via `security find-generic-password`.
 */
async function resolvePassword(password: string): Promise<string> {
  if (!password.startsWith('keychain:')) return password;

  const label = password.slice('keychain:'.length);
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', label, '-w'],
      { timeout: 5_000 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`Keychain lookup failed for "${label}": ${err.message}`));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

// ── ICS Parsing ──────────────────────────────────────────────

/**
 * Parse a DTSTART or DTEND value from an ICS line.
 * Handles:
 *   DTSTART;VALUE=DATE:20260306         → all-day
 *   DTSTART:20260306T140000Z            → timed (UTC)
 *   DTSTART;TZID=America/New_York:20260306T100000  → timed (with tz)
 *
 * Limitation: TZID values are currently ignored — times with TZID but no Z
 * suffix are treated as local system time. This is acceptable when the CalDAV
 * server and this machine share a timezone, but will be wrong for remote
 * calendars in different timezones. A full VTIMEZONE resolver would be needed
 * to handle this correctly.
 */
function parseDTValue(line: string): { date: Date; allDay: boolean } {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return { date: new Date(), allDay: false };

  const params = line.slice(0, colonIdx).toUpperCase();
  const value = line.slice(colonIdx + 1).trim();

  // All-day event: VALUE=DATE with YYYYMMDD format (8 digits, no T)
  if (params.includes('VALUE=DATE') || (value.length === 8 && /^\d{8}$/.test(value))) {
    const y = parseInt(value.slice(0, 4), 10);
    const m = parseInt(value.slice(4, 6), 10) - 1;
    const d = parseInt(value.slice(6, 8), 10);
    return { date: new Date(y, m, d), allDay: true };
  }

  // Timed event: YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (match) {
    const [, yr, mo, dy, hr, mi, sc, z] = match;
    if (z === 'Z') {
      return { date: new Date(Date.UTC(+yr!, +mo! - 1, +dy!, +hr!, +mi!, +sc!)), allDay: false };
    }
    // No Z suffix — treat as local time
    return { date: new Date(+yr!, +mo! - 1, +dy!, +hr!, +mi!, +sc!), allDay: false };
  }

  // Fallback: try Date.parse
  return { date: new Date(value), allDay: false };
}

/**
 * Extract VEVENT blocks from a multi-response CalDAV XML body,
 * then parse each into a CalendarEvent.
 */
function parseICSEvents(responseBody: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  // Extract calendar-data content from the XML multistatus response.
  // CalDAV returns XML with <cal:calendar-data> elements containing raw ICS.
  const calDataRegex = /<(?:cal:|c:|C:)?calendar-data[^>]*>([\s\S]*?)<\/(?:cal:|c:|C:)?calendar-data>/gi;
  let xmlMatch: RegExpExecArray | null;
  const icsBlocks: string[] = [];

  while ((xmlMatch = calDataRegex.exec(responseBody)) !== null) {
    // Unescape XML entities
    const ics = xmlMatch[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#13;/g, '\r');
    icsBlocks.push(ics);
  }

  // If no XML wrapper found, try treating the whole body as ICS
  if (icsBlocks.length === 0 && responseBody.includes('BEGIN:VEVENT')) {
    icsBlocks.push(responseBody);
  }

  for (const ics of icsBlocks) {
    // Split into VEVENT blocks
    const veventRegex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/gi;
    let veventMatch: RegExpExecArray | null;

    while ((veventMatch = veventRegex.exec(ics)) !== null) {
      const block = veventMatch[0];

      // Handle folded lines (RFC 5545: lines continued with leading space/tab)
      const unfolded = block.replace(/\r?\n[ \t]/g, '');

      const lines = unfolded.split(/\r?\n/);

      let title = '';
      let startTime = '';
      let endTime = '';
      let allDay = false;

      for (const line of lines) {
        const upper = line.toUpperCase();

        if (upper.startsWith('SUMMARY')) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            // Unescape RFC 5545 escaped characters in SUMMARY values
            title = line.slice(idx + 1).trim()
              .replace(/\\n/gi, ' ')
              .replace(/\\,/g, ',')
              .replace(/\\;/g, ';')
              .replace(/\\\\/g, '\\');
          }
        } else if (upper.startsWith('DTSTART')) {
          const parsed = parseDTValue(line);
          allDay = parsed.allDay;
          if (allDay) {
            startTime = '';
          } else {
            startTime = parsed.date.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
          }
        } else if (upper.startsWith('DTEND')) {
          const parsed = parseDTValue(line);
          if (!parsed.allDay) {
            endTime = parsed.date.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            });
          }
        }
      }

      if (title) {
        events.push({ title, startTime, endTime, allDay });
      }
    }
  }

  // Sort: timed events by start time, then all-day events at the top
  events.sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return a.startTime.localeCompare(b.startTime);
  });

  return events;
}

// ── CalDAV REPORT ────────────────────────────────────────────

/**
 * Build the calendar-query XML body for fetching today's events.
 */
function buildCalendarQueryXML(): string {
  // Build start/end of today in local time, then format as UTC for the CalDAV
  // time-range filter. Using local Date ensures we query for "today" in the
  // user's timezone, and getUTC* methods convert to the Z-suffix format CalDAV expects.
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // Format as iCal UTC datetime: YYYYMMDDTHHMMSSZ
  // The Date objects hold local midnight/midnight+1; getUTC* converts to UTC.
  const fmt = (d: Date): string => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getcontenttype/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${fmt(startOfDay)}" end="${fmt(endOfDay)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * Fetch today's calendar events from a CalDAV server.
 *
 * @param config - CalDAV server URL, username, and password
 * @returns Array of calendar events for today (empty on error)
 */
export async function fetchTodayEvents(config: CalDAVConfig): Promise<CalendarEvent[]> {
  try {
    const password = await resolvePassword(config.password);
    const auth = Buffer.from(`${config.username}:${password}`).toString('base64');

    const body = buildCalendarQueryXML();

    const response = await fetch(config.url, {
      method: 'REPORT',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Authorization': `Basic ${auth}`,
        'Depth': '1',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      log.warn('CalDAV REPORT failed', {
        status: response.status,
        statusText: response.statusText,
      });
      return [];
    }

    const responseBody = await response.text();
    const events = parseICSEvents(responseBody);

    log.debug('CalDAV events fetched', { count: events.length });
    return events;
  } catch (err) {
    log.warn('CalDAV fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
