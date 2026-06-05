/**
 * Meeting Prep Intelligence Briefings — sends Dave a prep briefing before upcoming meetings.
 *
 * Every 5 minutes:
 * 1. Checks M365 calendar for meetings in the next 60 minutes
 * 2. For each upcoming meeting, fetches recent email threads with each attendee
 * 3. Builds a concise summarized briefing with key context and action items
 * 4. Sends via daemon send API (Teams channel)
 * 5. Tracks briefed meetings in-memory to avoid duplicate notifications
 */

import { createLogger } from '../../../core/logger.js';
import { sendToHuman } from '../../../automation/tasks/helpers/send-to-human.js';
import type { Scheduler } from '../../../automation/scheduler.js';
import { getGraphClient } from '../../m365/index.js';
import type { OrgUser, PersonItem } from '../../m365/graph.js';

const log = createLogger('meeting-prep');

// ── Config Shape ─────────────────────────────────────────────

interface MeetingPrepConfig {
  lookahead_minutes?: number;
  max_threads_per_attendee?: number;
  min_minutes_before?: number;
  dave_email?: string;
  daemon_port?: number;
  internal_domain?: string;  // default 'servos.io'
}

// ── In-Memory Dedup ──────────────────────────────────────────

/** Tracks event IDs that have already been briefed this daemon session. */
const briefedEvents = new Set<string>();

// ── Helpers ──────────────────────────────────────────────────

function normalizeSubject(subject: string): string {
  return subject.replace(/^(Re|Fwd|FW|RE|FWD):\s*/gi, '').trim();
}

/**
 * Parse a Graph API datetime string as UTC.
 * Graph returns datetimes like "2026-03-23T14:00:00.0000000" without a Z suffix,
 * which JavaScript would otherwise parse as local time. Append Z if needed.
 */
function parseUTC(dateStr: string): Date {
  if (!dateStr.endsWith('Z') && !dateStr.includes('+') && !/[+-]\d{2}:\d{2}$/.test(dateStr)) {
    return new Date(dateStr + 'Z');
  }
  return new Date(dateStr);
}

function formatTime(dateStr: string): string {
  return parseUTC(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

function formatDate(dateStr: string): string {
  return parseUTC(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

// Common words to skip when extracting topic keywords from email subjects
const TOPIC_STOPWORDS = new Set([
  're', 'fwd', 'fw', 'meeting', 'update', 'the', 'a', 'an', 'and', 'or',
  'for', 'in', 'on', 'at', 'to', 'of', 'is', 'are', 'was', 'with', 'your',
  'our', 'about', 'from', 'this', 'that', 'have', 'has', 'had', 'be', 'it',
]);

/**
 * Extract the top 2-3 meaningful topic keywords from a list of email subjects.
 * Returns a short phrase like "budget, timeline" or empty string if nothing useful found.
 */
function extractTopicPhrase(subjects: string[]): string {
  const freq = new Map<string, number>();
  for (const subj of subjects) {
    const words = subj
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !TOPIC_STOPWORDS.has(w));
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return sorted.join(', ');
}

// ── Data Types ───────────────────────────────────────────────

interface ThreadInfo {
  subject: string;
  date: string;
  dateMs: number;
  owesReply: boolean;
  attendeeEmail: string;
  attendeeName: string;
}

interface AttendeeSummary {
  name: string;
  subtitle: string;
  threadCount: number;
  lastContactDate: string;
  lastContactMs: number;
  isExternal: boolean;
  companyName: string;       // from people search or profile
  contextSummary: string;    // 1-line summary for external attendees
}

// ── Main ─────────────────────────────────────────────────────

async function run(config: MeetingPrepConfig): Promise<string> {
  const graph = getGraphClient();
  if (!graph) {
    log.warn('M365 not initialized, skipping meeting-prep');
    return 'skipped: M365 not initialized';
  }

  const lookahead = config.lookahead_minutes ?? 60;
  const maxThreads = config.max_threads_per_attendee ?? 5;
  const minBefore = config.min_minutes_before ?? 10;
  const daveEmail = (config.dave_email ?? 'dSmith@servos.io').toLowerCase();
  const daemonPort = config.daemon_port ?? 3847;
  const internalDomain = (config.internal_domain ?? 'servos.io').toLowerCase();

  const now = new Date();
  const windowEnd = new Date(now.getTime() + lookahead * 60 * 1000);

  log.info('Meeting-prep: checking calendar', {
    window: `${now.toISOString()} → ${windowEnd.toISOString()}`,
    lookaheadMin: lookahead,
    minBeforeMin: minBefore,
  });

  // Fetch upcoming calendar events
  let events;
  try {
    events = await graph.getCalendarEvents({
      startDateTime: now.toISOString(),
      endDateTime: windowEnd.toISOString(),
      top: 20,
    });
  } catch (err) {
    log.warn('Failed to fetch calendar events', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'error: failed to fetch calendar events';
  }

  log.info(`Meeting-prep: found ${events.length} event(s) in window`);

  if (events.length === 0) {
    return 'no events in lookahead window';
  }

  let briefsSent = 0;

  for (const event of events) {
    const startMs = parseUTC(event.start.dateTime).getTime();
    const endMs = parseUTC(event.end.dateTime).getTime();
    const minutesUntil = (startMs - now.getTime()) / 60000;
    const durationHours = (endMs - startMs) / 3600000;

    log.info('Meeting-prep: evaluating event', {
      subject: event.subject,
      startDateTime: event.start.dateTime,
      timeZone: event.start.timeZone,
      minutesUntil: Math.round(minutesUntil),
      durationHours: Math.round(durationHours * 10) / 10,
      attendeeCount: event.attendees?.length ?? 0,
      alreadyBriefed: briefedEvents.has(event.id),
    });

    // Skip already briefed
    if (briefedEvents.has(event.id)) {
      log.info('Meeting-prep: already briefed this session, skipping', { subject: event.subject });
      continue;
    }

    // Skip if too close (< min_minutes_before) — not enough time to prep
    if (minutesUntil < minBefore) {
      log.info('Meeting-prep: skipping (too soon or already started)', {
        subject: event.subject,
        minutesUntil: Math.round(minutesUntil),
        minBefore,
      });
      continue;
    }

    // Skip all-day events — check if event spans >=23 hours
    if (durationHours >= 23) {
      log.info('Meeting-prep: skipping all-day event', { subject: event.subject, durationHours });
      continue;
    }

    // Filter attendees — exclude Dave
    const attendees = (event.attendees ?? []).filter(
      a => a.emailAddress.address.toLowerCase() !== daveEmail,
    );

    log.info('Meeting-prep: attendees after filtering', {
      subject: event.subject,
      total: event.attendees?.length ?? 0,
      afterFilter: attendees.length,
    });

    if (attendees.length === 0) {
      log.info('Meeting-prep: skipping (no non-Dave attendees)', { subject: event.subject });
      continue;
    }

    log.info('Meeting-prep: preparing briefing', {
      subject: event.subject,
      minutesUntil: Math.round(minutesUntil),
      attendeeCount: attendees.length,
    });

    // Cap large meetings
    const MAX_ATTENDEES = 10;
    const extraAttendees = attendees.length > MAX_ATTENDEES ? attendees.length - MAX_ATTENDEES : 0;
    const attendeesToBrief = attendees.slice(0, MAX_ATTENDEES);

    // Extract keywords from meeting subject for relevance matching
    const meetingKeywords = (event.subject ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // ── Gather data per attendee ──────────────────────────────
    const allThreads: ThreadInfo[] = [];
    const attendeeSummaries: AttendeeSummary[] = [];

    for (const attendee of attendeesToBrief) {
      const email = attendee.emailAddress.address;
      const name = attendee.emailAddress.name || email;
      const isExternal = !email.toLowerCase().endsWith(`@${internalDomain}`);

      // Enrich attendee with Graph directory profile
      let profile: OrgUser | null = null;
      try {
        profile = await graph.getUser(email);
      } catch {
        log.debug('Could not look up Graph profile for attendee', { email });
      }
      const displayName = profile?.displayName || name;
      const titleParts = [profile?.jobTitle, profile?.department].filter(Boolean);
      const subtitle = titleParts.length > 0 ? titleParts.join(', ') : '';

      // For external attendees, run people search in parallel with email fetches
      let peopleSearchPromise: Promise<PersonItem[]> | null = null;
      if (isExternal) {
        peopleSearchPromise = graph.searchPeople(email, 1).catch((err) => {
          log.debug('People search failed for external attendee', {
            email,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        });
      }

      let threadCount = 0;
      let lastContactMs = 0;
      let lastContactDate = '';

      try {
        const [fromThem, toThem] = await Promise.all([
          graph.searchEmails(`from:${email}`, maxThreads + 5),
          graph.searchEmails(`to:${email}`, maxThreads + 5),
        ]);

        // Combine and dedup by normalized subject
        const threadMap = new Map<string, { msg: typeof fromThem[0]; fromThem: boolean }>();
        for (const msg of fromThem) {
          const key = normalizeSubject(msg.subject || '(No subject)');
          const existing = threadMap.get(key);
          if (!existing || new Date(msg.receivedDateTime) > new Date(existing.msg.receivedDateTime)) {
            threadMap.set(key, { msg, fromThem: true });
          }
        }
        for (const msg of toThem) {
          const key = normalizeSubject(msg.subject || '(No subject)');
          const existing = threadMap.get(key);
          if (!existing || new Date(msg.receivedDateTime) > new Date(existing.msg.receivedDateTime)) {
            threadMap.set(key, { msg, fromThem: false });
          }
        }

        threadCount = threadMap.size;

        for (const [normalized, { msg, fromThem: latestIsFromThem }] of threadMap) {
          const msgMs = new Date(msg.receivedDateTime).getTime();
          if (msgMs > lastContactMs) {
            lastContactMs = msgMs;
            lastContactDate = formatDate(msg.receivedDateTime);
          }
          allThreads.push({
            subject: normalized || '(No subject)',
            date: formatDate(msg.receivedDateTime),
            dateMs: msgMs,
            owesReply: latestIsFromThem,
            attendeeEmail: email,
            attendeeName: displayName,
          });
        }
      } catch (err) {
        log.warn('Failed to fetch email history for attendee', {
          email,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Build external enrichment if applicable
      let companyName = profile?.companyName ?? '';
      let contextSummary = '';

      if (isExternal) {
        // Resolve people search result (started earlier in parallel)
        if (peopleSearchPromise) {
          try {
            const people = await peopleSearchPromise;
            if (people.length > 0 && people[0].companyName) {
              companyName = people[0].companyName;
            }
          } catch {
            // already handled in the catch above during Promise construction
          }
        }

        // Derive topic phrase from email subjects for this attendee
        const attendeeSubjects = allThreads
          .filter(t => t.attendeeEmail === email)
          .map(t => t.subject);
        const topicPhrase = extractTopicPhrase(attendeeSubjects);

        // Build context summary
        const jobTitle = profile?.jobTitle ?? '';
        const roleAt = jobTitle && companyName
          ? `${jobTitle} at ${companyName}`
          : jobTitle || (companyName ? `at ${companyName}` : '');

        if (roleAt && topicPhrase) {
          contextSummary = `${roleAt} — discusses: ${topicPhrase}`;
        } else if (roleAt) {
          contextSummary = roleAt;
        } else if (topicPhrase) {
          contextSummary = `discusses: ${topicPhrase}`;
        } else {
          contextSummary = 'external contact';
        }
      }

      attendeeSummaries.push({
        name: displayName,
        subtitle,
        threadCount,
        lastContactDate: lastContactDate || 'no recent emails',
        lastContactMs,
        isExternal,
        companyName,
        contextSummary,
      });
    }

    // ── Build concise briefing ────────────────────────────────

    const subject = event.subject || '(No subject)';
    const startTime = formatTime(event.start.dateTime);
    const endTime = formatTime(event.end.dateTime);
    const location = event.location?.displayName || 'No location';
    const timestamp = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
    });

    // Attendee names list
    const attendeeNames = attendeeSummaries.map(a => a.name).join(', ');

    // Key Context: threads related to the meeting topic
    const relatedThreads = allThreads.filter(t =>
      meetingKeywords.some(kw => t.subject.toLowerCase().includes(kw)),
    );
    // Dedup related threads by subject
    const seenRelated = new Set<string>();
    const uniqueRelated = relatedThreads.filter(t => {
      if (seenRelated.has(t.subject)) return false;
      seenRelated.add(t.subject);
      return true;
    }).slice(0, 5);

    // Needs Reply: threads where the latest message is from the attendee
    const replyNeeded = allThreads
      .filter(t => t.owesReply)
      .sort((a, b) => b.dateMs - a.dateMs)
      .slice(0, 5);

    // Separate external vs internal attendees
    const externalSummaries = attendeeSummaries.filter(a => a.isExternal);
    const internalSummaries = attendeeSummaries.filter(a => !a.isExternal);
    const hasExternals = externalSummaries.length > 0;
    const hasInternals = internalSummaries.length > 0;

    // Build lines
    const lines: string[] = [];

    // Header
    lines.push(`Meeting Prep: ${subject}`);
    lines.push(`${startTime} - ${endTime} | ${location}`);
    lines.push(`Attendees: ${attendeeNames}`);
    if (extraAttendees > 0) {
      lines.push(`  ...and ${extraAttendees} other(s)`);
    }

    // Key Context
    if (uniqueRelated.length > 0) {
      lines.push('');
      lines.push('Key Context:');
      for (const t of uniqueRelated) {
        const status = t.owesReply ? '(awaiting your reply)' : `(you replied ${t.date})`;
        lines.push(`  - ${t.subject} - last updated ${t.date} ${status}`);
      }
    }

    // Needs Reply
    if (replyNeeded.length > 0) {
      lines.push('');
      lines.push('Needs Reply:');
      for (const t of replyNeeded) {
        lines.push(`  - ${t.attendeeName}: "${t.subject}" (${t.date})`);
      }
    }

    // Attendee Activity — smarter split for external vs internal
    if (attendeeSummaries.length > 0) {
      if (!hasExternals) {
        // All internal — use original format unchanged
        lines.push('');
        lines.push('Attendee Activity:');
        for (const a of internalSummaries) {
          const role = a.subtitle ? ` (${a.subtitle})` : '';
          lines.push(`  - ${a.name}${role} - ${a.threadCount} thread${a.threadCount === 1 ? '' : 's'}, last contact ${a.lastContactDate}`);
        }
      } else {
        // Has externals — show External Contacts first, then Team (if any internals)
        lines.push('');
        lines.push('External Contacts:');
        for (const a of externalSummaries) {
          const threadLabel = `${a.threadCount} thread${a.threadCount === 1 ? '' : 's'}`;
          lines.push(`  - ${a.name} (${a.contextSummary}) — ${threadLabel}, last contact ${a.lastContactDate}`);
        }

        if (hasInternals) {
          lines.push('');
          lines.push('Team:');
          for (const a of internalSummaries) {
            const role = a.subtitle ? ` (${a.subtitle})` : '';
            lines.push(`  - ${a.name}${role} - ${a.threadCount} thread${a.threadCount === 1 ? '' : 's'}, last contact ${a.lastContactDate}`);
          }
        }
      }
    }

    lines.push('');
    lines.push(`---`);
    lines.push(`Briefing generated at ${timestamp}`);

    const briefingText = lines.join('\n');

    // Send via the sanctioned scheduler-send helper (in-process router first,
    // HTTP+daemon-token fallback). Auth-family fix 2026-06-05: the bare fetch
    // here 401'd against the #290 role gate from 5/20 onward.
    try {
      const res = await sendToHuman(
        { message: briefingText, channels: ['teams'] },
        Number(daemonPort),
      );

      if (!res.ok) {
        log.warn('Meeting-prep: send failed', { status: res.status, body: res.error });
      } else {
        log.info('Meeting-prep: briefing sent', { subject, minutesUntil: Math.round(minutesUntil) });
        briefedEvents.add(event.id);
        briefsSent++;
      }
    } catch (err) {
      log.warn('Meeting-prep: error sending briefing', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return briefsSent > 0 ? `sent ${briefsSent} briefing(s)` : 'no briefings sent (all events filtered)';
}

// ── Register ─────────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('meeting-prep', async (ctx) => {
    const config = (ctx.config ?? {}) as MeetingPrepConfig;
    return run(config);
  });
}
