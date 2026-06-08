/**
 * Meeting Prep — sends pre-meeting strategic intelligence briefings via Telegram.
 *
 * Runs every 5 minutes.
 * Calls the local M365 calendar API to get upcoming events,
 * then for each event starting in 15-30 minutes:
 *   1. Extracts attendee email addresses
 *   2. Searches M365 and IMAP emails from the past 30 days for threads
 *      involving those attendees
 *   3. Looks up each attendee's profile via M365 People API
 *   4. Fetches Granola meeting note content (not just metadata) for context
 *   5. Sends all gathered context to Claude for a strategic intelligence briefing
 *   6. Sends via Telegram
 *
 * Tracks already-nudged event IDs in memory to avoid duplicate nudges.
 * Clears stale entries (events older than 2 hours) on each run.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { askClaude } from '../../core/claude-api.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('meeting-prep');

// ── Types ─────────────────────────────────────────────────────

interface CalendarAttendee {
  emailAddress?: {
    name?: string;
    address?: string;
  };
  type?: string;
}

interface OnlineMeeting {
  joinUrl?: string;
}

interface CalendarEvent {
  id: string;
  subject?: string;
  start?: {
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    dateTime?: string;
    timeZone?: string;
  };
  location?: {
    displayName?: string;
  };
  onlineMeeting?: OnlineMeeting | null;
  attendees?: CalendarAttendee[];
  bodyPreview?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingUrl?: string;
}

interface UpcomingEventsResponse {
  value?: CalendarEvent[];
  events?: CalendarEvent[];
}

interface AttendeeProfile {
  email: string;
  displayName?: string;
  jobTitle?: string;
  department?: string;
  companyName?: string;
  officeLocation?: string;
}

interface AttendeeContext {
  email: string;
  name: string;
  profile: AttendeeProfile | null;
  recentEmails: EmailThread[];
  teamsChats: EmailThread[];
  granolaNotes: GranolaNoteMatch[];
}

// ── State ─────────────────────────────────────────────────────

// In-memory set of event IDs we have already nudged.
// Each entry pairs the event ID with the timestamp of when it was nudged
// so we can expire stale entries.
const nudgedEvents = new Map<string, number>();

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const NUDGE_WINDOW_MIN = 15;
const NUDGE_WINDOW_MAX = 30;

// ── Helpers ───────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getPort(): number {
  const config = loadConfig();
  return (config as unknown as Record<string, Record<string, unknown>>)?.daemon?.port as number ?? 3847;
}

/**
 * Remove entries from the nudge tracker that are older than 2 hours.
 * This prevents unbounded memory growth during long daemon uptime.
 */
function pruneNudgeTracker(): void {
  const cutoff = Date.now() - TWO_HOURS_MS;
  for (const [id, ts] of nudgedEvents) {
    if (ts < cutoff) {
      nudgedEvents.delete(id);
    }
  }
}

/**
 * Fetch upcoming events from the M365 calendar API.
 * Returns an empty array on any error rather than throwing,
 * so a failed or unauthenticated M365 session does not crash the task.
 */
async function fetchUpcomingEvents(): Promise<CalendarEvent[]> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/api/m365/calendar/upcoming?hours=2`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn('M365 calendar API returned non-OK status', { status: resp.status });
      return [];
    }
    const data = await resp.json() as UpcomingEventsResponse;
    // The API may return { value: [...] } (Graph API shape) or { events: [...] }
    return data.value ?? data.events ?? [];
  } catch (err) {
    log.warn('Failed to fetch upcoming events — M365 may not be authenticated', {
      error: errMsg(err),
    });
    return [];
  }
}

/**
 * Normalize Graph API datetime to a proper ISO string.
 * Graph returns "2026-03-23T15:30:00.0000000" with a separate timeZone field.
 * Without a Z suffix, new Date() treats it as local time — wrong.
 * We append Z since Graph calendar times with timeZone "UTC" are always UTC.
 */
function normalizeDateTime(isoDateTime: string): string {
  if (!isoDateTime.endsWith('Z') && !isoDateTime.includes('+') && !isoDateTime.includes('-', 10)) {
    return isoDateTime + 'Z';
  }
  return isoDateTime;
}

/**
 * Calculate how many minutes from now until the given ISO datetime string.
 */
function minutesUntil(isoDateTime: string): number {
  const start = new Date(normalizeDateTime(isoDateTime)).getTime();
  return Math.round((start - Date.now()) / 60_000);
}

/**
 * Format a start time as "2:30 PM" (local time).
 */
function formatStartTime(isoDateTime: string): string {
  return new Date(normalizeDateTime(isoDateTime)).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Build the location/join line for the message.
 * Prefers the online meeting join URL, falls back to the location display name.
 */
function formatLocation(event: CalendarEvent): string {
  const joinUrl = event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl;
  if (joinUrl) {
    return `Online — ${joinUrl}`;
  }
  const display = event.location?.displayName?.trim();
  if (display && display.length > 0) {
    return display;
  }
  return 'No location specified';
}

/**
 * Build a comma-separated list of attendee names (excluding resources).
 */
function formatAttendees(attendees?: CalendarAttendee[]): string {
  if (!attendees || attendees.length === 0) return 'No attendees listed';
  const names = attendees
    .filter(a => a.type !== 'resource')
    .map(a => a.emailAddress?.name ?? a.emailAddress?.address ?? 'Unknown')
    .filter(Boolean);
  return names.length > 0 ? names.join(', ') : 'No attendees listed';
}

// ── Granola ────────────────────────────────────────────────────

interface GranolaTokenFile {
  access_token?: string;
  refresh_token?: string;
  session_id?: string;
  user_id?: string;
  email?: string;
}

interface GranolaParticipant {
  name?: string;
  email?: string;
}

interface GranolaDocument {
  id?: string;
  title?: string;
  created_at?: string;
  participants?: GranolaParticipant[];
}

interface GranolaDocumentsResponse {
  docs?: GranolaDocument[];
}

interface GranolaNoteMatch {
  title: string;
  date: string;
  participants: string;
  content: string;
}

/**
 * Load the Granola access token from ~/.config/marvbot/granola.json.
 * Returns null if the file is missing, unreadable, or has no access_token.
 */
function loadGranolaToken(): string | null {
  try {
    const tokenPath = `${homedir()}/.config/marvbot/granola.json`;
    const raw = readFileSync(tokenPath, 'utf8');
    const parsed = JSON.parse(raw) as GranolaTokenFile;
    return parsed.access_token ?? null;
  } catch {
    // File missing or malformed — Granola not configured
    return null;
  }
}

/**
 * Fetch the content of a single Granola document by ID.
 * Returns empty string on any error — content is best-effort enrichment.
 */
async function fetchGranolaDocContent(docId: string, token: string, headers: Record<string, string>): Promise<string> {
  try {
    const resp = await fetch('https://api.granola.ai/v2/get-document', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: docId }),
    });

    if (!resp.ok) {
      log.warn('Granola get-document returned non-OK status', { docId, status: resp.status });
      return '';
    }

    const data = await resp.json() as Record<string, unknown>;

    // Try common content fields in order of preference
    const raw =
      (typeof data['notes'] === 'string' ? data['notes'] : '') ||
      (typeof data['transcript'] === 'string' ? data['transcript'] : '') ||
      (typeof data['content'] === 'string' ? data['content'] : '') ||
      '';

    return raw.slice(0, 1000);
  } catch (err) {
    log.warn('Failed to fetch Granola doc content', { docId, error: errMsg(err) });
    return '';
  }
}

/**
 * Search Granola for past meeting notes that include any of the given attendee emails.
 * Returns at most 5 matching docs with title, date, participant names, and content.
 * Fails gracefully — returns empty array on any error.
 */
async function searchGranolaNotes(attendeeEmails: string[]): Promise<GranolaNoteMatch[]> {
  if (attendeeEmails.length === 0) return [];

  const token = loadGranolaToken();
  if (!token) return [];

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
    'X-App-Version': '7.0.0',
    'X-Client-Version': '7.0.0',
    'X-Client-Type': 'cli',
  };

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const resp = await fetch('https://api.granola.ai/v2/get-documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: 50 }),
    });

    if (!resp.ok) {
      log.warn('Granola get-documents returned non-OK status', { status: resp.status });
      return [];
    }

    const data = await resp.json() as GranolaDocumentsResponse;
    const docs = data.docs ?? [];

    const attendeeSet = new Set(attendeeEmails.map(e => e.toLowerCase()));

    const matchingDocs = docs
      .filter(doc => {
        // Only consider docs from the last 30 days
        if (!doc.created_at) return false;
        const docDate = new Date(doc.created_at);
        if (docDate < thirtyDaysAgo) return false;
        // Must have at least one participant email that overlaps
        const participants = doc.participants ?? [];
        return participants.some(p => p.email && attendeeSet.has(p.email.toLowerCase()));
      })
      .slice(0, 5);

    // Fetch content for each matching doc (up to 5) in parallel
    const matches = await Promise.all(
      matchingDocs.map(async doc => {
        const participants = (doc.participants ?? [])
          .map(p => p.name ?? p.email ?? 'Unknown')
          .join(', ');
        const date = doc.created_at
          ? new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';
        const content = doc.id
          ? await fetchGranolaDocContent(doc.id, token, headers)
          : '';
        return {
          title: doc.title ?? '(Untitled)',
          date,
          participants,
          content,
        };
      })
    );

    return matches;
  } catch (err) {
    log.warn('Granola search failed', { error: errMsg(err) });
    return [];
  }
}

// ── People API ────────────────────────────────────────────────

/**
 * Look up an attendee's profile via the M365 People API.
 * Tries the people/search endpoint first, then falls back to people/relevant.
 * Returns null on any failure — this is best-effort enrichment only.
 */
async function lookupAttendeeInfo(email: string): Promise<AttendeeProfile | null> {
  const port = getPort();

  // Try people/search first
  try {
    const searchUrl = `http://127.0.0.1:${port}/api/m365/people/search?q=${encodeURIComponent(email)}&top=1`;
    const resp = await fetch(searchUrl);
    if (resp.ok) {
      const data = await resp.json() as { value?: Array<{ displayName?: string; jobTitle?: string; department?: string; companyName?: string; officeLocation?: string }> };
      const person = (data.value ?? [])[0];
      if (person) {
        return {
          email,
          displayName: person.displayName,
          jobTitle: person.jobTitle,
          department: person.department,
          companyName: person.companyName,
          officeLocation: person.officeLocation,
        };
      }
    }
  } catch {
    // Silently ignore — try fallback
  }

  // Fallback: try people/relevant with the name portion of the email
  try {
    const name = email.split('@')[0].replace(/[._-]/g, ' ');
    const relevantUrl = `http://127.0.0.1:${port}/api/m365/people/relevant?q=${encodeURIComponent(name)}&top=1`;
    const resp = await fetch(relevantUrl);
    if (resp.ok) {
      const data = await resp.json() as { value?: Array<{ displayName?: string; jobTitle?: string; department?: string; companyName?: string; officeLocation?: string }> };
      const person = (data.value ?? [])[0];
      if (person) {
        return {
          email,
          displayName: person.displayName,
          jobTitle: person.jobTitle,
          department: person.department,
          companyName: person.companyName,
          officeLocation: person.officeLocation,
        };
      }
    }
  } catch {
    // Silently ignore
  }

  return null;
}

// ── Email Intelligence ────────────────────────────────────────

interface EmailThread {
  subject: string;
  from: string;
  date: string;
  preview: string;
}

/**
 * Extract attendee email addresses from event, excluding the user's own addresses.
 */
function extractAttendeeEmails(attendees?: CalendarAttendee[]): string[] {
  if (!attendees || attendees.length === 0) return [];
  const ownAddresses = new Set(['wloving@servos.io', 'wfloving@me.com', 'will@altroncorp.com']);
  return attendees
    .filter(a => a.type !== 'resource')
    .map(a => a.emailAddress?.address?.toLowerCase())
    .filter((addr): addr is string => !!addr && !ownAddresses.has(addr));
}

/**
 * Search M365 emails from the past 30 days involving a specific attendee.
 */
async function searchM365Emails(attendeeEmail: string): Promise<EmailThread[]> {
  const port = getPort();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // Use $search instead of $filter — the toRecipients/any() OData filter
  // is not supported by Graph API for messages. KQL search handles it better.
  const params = new URLSearchParams({
    top: '20',
    search: attendeeEmail,
    folder: 'inbox',
  });

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/m365/messages?${params.toString()}`);
    if (!resp.ok) return [];
    const data = await resp.json() as { messages?: Array<{ subject?: string; from?: { emailAddress?: { name?: string; address?: string } }; receivedDateTime?: string; bodyPreview?: string }> };
    return (data.messages ?? []).map(m => ({
      subject: m.subject ?? '(No subject)',
      from: m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'Unknown',
      date: m.receivedDateTime ? new Date(m.receivedDateTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      preview: (m.bodyPreview ?? '').slice(0, 500),
    }));
  } catch (err) {
    log.warn('M365 email search failed for attendee', { attendee: attendeeEmail, error: errMsg(err) });
    return [];
  }
}

/**
 * Search IMAP emails from the past 30 days involving a specific attendee.
 * Searches all configured IMAP accounts in parallel.
 */
async function searchImapEmails(attendeeEmail: string): Promise<EmailThread[]> {
  const port = getPort();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/imap/search?query=${encodeURIComponent(attendeeEmail)}&since=${thirtyDaysAgo}&limit=20`);
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: Array<{ subject?: string; from?: { name?: string; address?: string }; date?: string; text?: string }> };
    return (data.results ?? []).map(m => ({
      subject: m.subject ?? '(No subject)',
      from: m.from?.name ?? m.from?.address ?? 'Unknown',
      date: m.date ? new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      preview: (m.text ?? '').slice(0, 500),
    }));
  } catch {
    // IMAP may not be configured — silently skip
    return [];
  }
}

/**
 * Search Teams chat messages from the past 30 days involving a specific attendee.
 */
async function searchTeamsChats(attendeeEmail: string): Promise<EmailThread[]> {
  const port = getPort();

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/m365/chats/search?person=${encodeURIComponent(attendeeEmail)}&days=30`);
    if (!resp.ok) return [];
    const data = await resp.json() as { messages?: Array<{ body?: { content?: string }; from?: { user?: { displayName?: string } }; createdDateTime?: string }> };
    return (data.messages ?? []).slice(0, 20).map(m => {
      // Strip HTML tags from Teams message bodies
      const rawContent = m.body?.content ?? '';
      const textContent = rawContent.replace(/<[^>]+>/g, '').trim();
      return {
        subject: 'Teams chat',
        from: m.from?.user?.displayName ?? 'Unknown',
        date: m.createdDateTime ? new Date(m.createdDateTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
        preview: textContent.slice(0, 500),
      };
    });
  } catch {
    // Teams chat API may not be available — silently skip
    return [];
  }
}

/**
 * Format email threads as text lines for inclusion in a prompt.
 */
function formatThreadsForPrompt(threads: EmailThread[]): string {
  if (threads.length === 0) return '  (none)';
  return threads
    .map(t => `  - ${t.date}: "${t.subject}" from ${t.from} — ${t.preview.replace(/\n/g, ' ').trim()}`)
    .join('\n');
}

/**
 * Format Granola notes as text lines for inclusion in a prompt.
 */
function formatGranolaForPrompt(notes: GranolaNoteMatch[]): string {
  if (notes.length === 0) return '  (none)';
  return notes
    .map(n => {
      const contentLine = n.content.trim().length > 0
        ? `\n    Content: ${n.content.replace(/\n/g, ' ').trim()}`
        : '';
      return `  - ${n.date}: "${n.title}" (participants: ${n.participants})${contentLine}`;
    })
    .join('\n');
}

/**
 * Build the Claude prompt for meeting briefing generation.
 */
function buildBriefingPrompt(
  meetingSubject: string,
  meetingTime: string,
  attendeeContexts: AttendeeContext[],
): string {
  const attendeeBlocks = attendeeContexts.map(ctx => {
    const profile = ctx.profile;
    const roleLines: string[] = [];
    if (profile?.jobTitle) roleLines.push(`Role: ${profile.jobTitle}`);
    if (profile?.companyName) roleLines.push(`Company: ${profile.companyName}`);
    if (profile?.department) roleLines.push(`Department: ${profile.department}`);
    if (profile?.officeLocation) roleLines.push(`Location: ${profile.officeLocation}`);

    const roleSummary = roleLines.length > 0
      ? roleLines.join(', ')
      : '(no profile data available)';

    const allEmails = [...ctx.recentEmails];
    const emailSection = allEmails.length > 0
      ? formatThreadsForPrompt(allEmails)
      : '  (none)';

    return [
      `## ${ctx.name} (${ctx.email})`,
      roleSummary,
      '',
      'Recent emails (last 30 days):',
      emailSection,
      '',
      'Recent Teams chats:',
      formatThreadsForPrompt(ctx.teamsChats),
      '',
      'Past meeting notes (Granola):',
      formatGranolaForPrompt(ctx.granolaNotes),
    ].join('\n');
  }).join('\n\n');

  return `You are an executive meeting preparation analyst. Your job is to analyze all available context about the people in an upcoming meeting and produce a strategic intelligence briefing that helps the executive walk in fully prepared.

Meeting: ${meetingSubject}
Time: ${meetingTime}

${attendeeBlocks}

Produce a briefing with these sections:

## Discussion History
Synthesize the arc of conversations with these attendees over the past 30 days. What topics have come up repeatedly? What has the trajectory of discussions been? Don't list individual messages — tell the story of what's been happening.

## Key Context & Background
What should I know about the current state of things with each person? Include any relevant decisions made, commitments given, or situations that have evolved.

## Open Items & Commitments
What action items, promises, or unresolved questions exist from past communications? What might come up again?

## Suggested Talking Points
Based on everything above, what specific things should I be prepared to discuss or raise in this meeting? What questions should I ask? What should I follow up on?

Be direct, specific, and actionable. Reference actual topics and details from the communications — don't be generic. If there's limited context for someone, say so briefly and move on.`;
}

/**
 * Generate an AI briefing using Claude.
 * Returns null if AI is unavailable — caller falls back to raw thread listing.
 */
async function generateBriefing(
  meetingSubject: string,
  meetingTime: string,
  attendeeContexts: AttendeeContext[],
): Promise<string | null> {
  if (attendeeContexts.length === 0) return null;

  const prompt = buildBriefingPrompt(meetingSubject, meetingTime, attendeeContexts);

  try {
    const result = await askClaude(prompt, {
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4000,
      timeoutMs: 30_000,
    });

    if (!result) {
      log.warn('Claude returned null for meeting briefing — falling back to raw threads');
      return null;
    }

    log.debug('Meeting briefing generated', {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    return result.content;
  } catch (err) {
    log.warn('Failed to generate AI briefing', { error: errMsg(err) });
    return null;
  }
}

/**
 * Gather all intelligence context for a single attendee (emails, Teams, Granola).
 * Returns structured data for AI analysis.
 */
async function gatherAttendeeContext(
  email: string,
  displayName: string,
  allAttendeeEmails: string[],
): Promise<AttendeeContext> {
  const [profile, m365Emails, imapEmails, teamsChats, granolaNotes] = await Promise.all([
    lookupAttendeeInfo(email),
    searchM365Emails(email),
    searchImapEmails(email),
    searchTeamsChats(email),
    searchGranolaNotes(allAttendeeEmails), // shared across all attendees — caller deduplicates
  ]);

  // Combine and deduplicate M365 + IMAP emails
  const combinedEmails = [...m365Emails, ...imapEmails];
  const seen = new Set<string>();
  const uniqueEmails = combinedEmails.filter(t => {
    const key = t.subject.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  return {
    email,
    name: displayName,
    profile,
    recentEmails: uniqueEmails,
    teamsChats: teamsChats.slice(0, 10),
    granolaNotes,
  };
}

/**
 * Gather email, Teams, and Granola intelligence for all attendees of a meeting.
 * Searches communications from the past 30 days.
 * Returns structured AttendeeContext[] for AI analysis,
 * and a formatted fallback string for when AI is unavailable.
 */
async function gatherEmailIntelligence(attendees?: CalendarAttendee[]): Promise<{
  attendeeContexts: AttendeeContext[];
  fallbackText: string;
}> {
  const emails = extractAttendeeEmails(attendees);
  if (emails.length === 0) return { attendeeContexts: [], fallbackText: '' };

  // Fetch Granola notes once for all attendees (shared call)
  const granolaNotes = await searchGranolaNotes(emails);

  // Gather per-attendee context in parallel (emails + Teams + profile)
  const attendeeContexts = await Promise.all(
    emails.map(async (email) => {
      const attendee = attendees?.find(
        a => a.emailAddress?.address?.toLowerCase() === email
      );
      const displayName = attendee?.emailAddress?.name ?? email.split('@')[0];

      const [profile, m365Emails, imapEmails, teamsChats] = await Promise.all([
        lookupAttendeeInfo(email),
        searchM365Emails(email),
        searchImapEmails(email),
        searchTeamsChats(email),
      ]);

      // Combine and deduplicate M365 + IMAP emails
      const combinedEmails = [...m365Emails, ...imapEmails];
      const seen = new Set<string>();
      const uniqueEmails = combinedEmails.filter(t => {
        const key = t.subject.toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 10);

      return {
        email,
        name: displayName,
        profile,
        recentEmails: uniqueEmails,
        teamsChats: teamsChats.slice(0, 10),
        granolaNotes,
      } satisfies AttendeeContext;
    })
  );

  // Build fallback text (raw thread listing, original behavior)
  const lines: string[] = [];

  const attendeesWithThreads = attendeeContexts.filter(
    ctx => ctx.recentEmails.length > 0 || ctx.teamsChats.length > 0
  );

  if (attendeesWithThreads.length > 0) {
    lines.push('\n\u{1F4E7} Recent comms with attendees (email + Teams, last 30 days):');
    for (const ctx of attendeesWithThreads) {
      lines.push(`\n\u{25B8} ${ctx.name}:`);
      for (const t of [...ctx.recentEmails, ...ctx.teamsChats]) {
        lines.push(`  \u{2022} ${t.date}: "${t.subject}" — ${t.preview.replace(/\n/g, ' ').trim()}`);
      }
    }
    lines.push('\n\u{1F4A1} Review these threads before the meeting for context.');
  }

  if (granolaNotes.length > 0) {
    lines.push('\n\u{1F4DD} Past meeting notes (Granola):');
    for (const note of granolaNotes) {
      lines.push(`  \u{2022} ${note.date}: "${note.title}" — ${note.participants}`);
    }
  }

  return {
    attendeeContexts,
    fallbackText: lines.join('\n'),
  };
}

/**
 * Format the nudge message with meeting details and AI-analyzed intelligence briefing.
 * Falls back to raw thread listing if AI is unavailable.
 */
async function formatNudgeMessage(event: CalendarEvent, minutesAway: number): Promise<string> {
  const subject = event.subject ?? '(No subject)';
  const startTime = event.start?.dateTime ? formatStartTime(event.start.dateTime) : 'Unknown time';
  const location = formatLocation(event);
  const attendees = formatAttendees(event.attendees);
  const bodyPreview = (event.bodyPreview ?? '').slice(0, 200);

  const lines = [
    `\u{1F4C5} Meeting in ${minutesAway} min: ${subject}`,
    `\u{23F0} ${startTime}`,
    `\u{1F4CD} ${location}`,
    `\u{1F465} ${attendees}`,
  ];

  if (bodyPreview.trim().length > 0) {
    lines.push('');
    lines.push(bodyPreview);
  }

  // Gather structured intelligence from past 30 days
  const { attendeeContexts, fallbackText } = await gatherEmailIntelligence(event.attendees);

  const hasAnyContext = attendeeContexts.some(
    ctx => ctx.recentEmails.length > 0 || ctx.teamsChats.length > 0 || ctx.granolaNotes.length > 0
  );

  if (hasAnyContext) {
    // Attempt AI-generated briefing
    const aiBriefing = await generateBriefing(subject, startTime, attendeeContexts);

    if (aiBriefing) {
      lines.push('');
      lines.push('\u{1F9E0} Intelligence Briefing:');
      lines.push(aiBriefing);
    } else if (fallbackText) {
      // Fall back to raw thread listing
      lines.push(fallbackText);
    }
  }

  return lines.join('\n');
}

/**
 * Send a message via the daemon channel router to Telegram.
 */
async function sendTelegram(message: string): Promise<void> {
  const port = getPort();
  const resp = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'telegram',
      message,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Telegram send failed (${resp.status})`);
  }
}

// ── Main ──────────────────────────────────────────────────────

async function run(): Promise<string> {
  pruneNudgeTracker();

  const events = await fetchUpcomingEvents();

  if (events.length === 0) {
    log.debug('No upcoming events returned from calendar API');
    return 'No upcoming events';
  }

  let nudgedCount = 0;
  let skippedCount = 0;

  for (const event of events) {
    if (!event.id || !event.start?.dateTime) {
      skippedCount++;
      continue;
    }

    const minutes = minutesUntil(event.start.dateTime);

    // Only nudge for events in the 15-30 minute window
    if (minutes < NUDGE_WINDOW_MIN || minutes > NUDGE_WINDOW_MAX) {
      skippedCount++;
      continue;
    }

    // Skip events we have already nudged
    if (nudgedEvents.has(event.id)) {
      log.debug('Skipping already-nudged event', { id: event.id, subject: event.subject });
      skippedCount++;
      continue;
    }

    const message = await formatNudgeMessage(event, minutes);

    try {
      await sendTelegram(message);
      nudgedEvents.set(event.id, Date.now());
      nudgedCount++;
      log.info('Sent meeting nudge', {
        id: event.id,
        subject: event.subject,
        minutesAway: minutes,
      });
    } catch (err) {
      log.error('Failed to send meeting nudge', {
        id: event.id,
        subject: event.subject,
        error: errMsg(err),
      });
    }
  }

  const summary = `meeting-prep: nudged=${nudgedCount}, skipped=${skippedCount}, tracked=${nudgedEvents.size}`;
  log.info('Meeting prep run complete', { nudgedCount, skippedCount, trackedEvents: nudgedEvents.size });
  return summary;
}

// ── Registration ──────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('meeting-prep', async (_ctx) => {
    return await run();
  });
}

// ── Exported for testing ───────────────────────────────────────

export {
  lookupAttendeeInfo,
  generateBriefing,
  buildBriefingPrompt,
  gatherEmailIntelligence,
  type AttendeeContext,
  type AttendeeProfile,
  type GranolaNoteMatch,
  type EmailThread,
};
