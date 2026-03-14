/**
 * Morning Briefing — daily summary task.
 *
 * Gathers calendar, weather, todos, overnight messages, and email status,
 * then delivers via the channel router (POST /api/send).
 *
 * This is a core task handler. Instance-specific customisation (weather
 * location, delivery channels) is driven by scheduler task config.
 *
 * Data sources:
 * - Calendar: CalDAV API + internal calendar DB
 * - Weather: Open-Meteo API with wttr.in fallback
 * - Todos: SQLite (open todos, priority-sorted)
 * - Email: task_results from the email-check task
 * - Overnight messages: daemon log scan
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '../../core/db.js';
import { loadConfig, getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { fetchTodayEvents } from './caldav-client.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('morning-briefing');

// ── Helpers ──────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function execCommand(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// ── Calendar ─────────────────────────────────────────────────

interface EventKitEvent {
  title: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  calendar: string;
}

/**
 * Try fetching today's events from macOS Calendar.app via EventKit.
 * Returns null if the helper is unavailable or fails.
 */
async function fetchEventKitEvents(): Promise<EventKitEvent[] | null> {
  const scriptPath = path.join(getProjectDir(), 'scripts', 'calendar-events.swift');

  // 1. Try running binary/script directly
  try {
    if (fs.existsSync(scriptPath)) {
      // Prefer compiled binary (avoids swift interpreter overhead + TCC issues)
      const binaryPath = scriptPath.replace(/\.swift$/, '');
      const useBinary = fs.existsSync(binaryPath);
      const output = useBinary
        ? await execCommand(binaryPath, [], 15_000)
        : await execCommand('/usr/bin/swift', [scriptPath], 15_000);
      const parsed = JSON.parse(output.trim());
      if (parsed.error) {
        log.warn('EventKit helper returned error', { error: parsed.error });
      } else if (Array.isArray(parsed)) {
        return parsed as EventKitEvent[];
      }
    }
  } catch (err) {
    log.warn('EventKit helper failed (will try cache)', { error: errMsg(err) });
  }

  // 2. Fall back to cache file (populated by terminal-context runs of the binary)
  try {
    const home = process.env.HOME ?? '/Users/agent';
    const cachePath = path.join(home, '.cache', 'kithkit', 'calendar-events.json');
    if (fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      const cache = JSON.parse(raw);
      const cachedAt = new Date(cache.cached_at);
      const ageHours = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours < 12 && Array.isArray(cache.events)) {
        log.info('Using cached calendar events', { ageHours: Math.round(ageHours * 10) / 10, count: cache.events.length });
        return cache.events as EventKitEvent[];
      }
      log.debug('Calendar cache too old', { ageHours: Math.round(ageHours) });
    }
  } catch (err) {
    log.debug('Calendar cache read failed', { error: errMsg(err) });
  }

  return null;
}

/**
 * Format a list of EventKit events into briefing lines.
 * Includes calendar name in parentheses when events span multiple calendars.
 */
function formatEventKitEvents(events: EventKitEvent[]): string {
  if (events.length === 0) return 'No events today.';

  const calendars = new Set(events.map(ev => ev.calendar));
  const multiCal = calendars.size > 1;

  return events
    .map(ev => {
      const suffix = multiCal ? ` (${ev.calendar})` : '';
      if (ev.allDay) return `• ${ev.title}${suffix}`;
      return `• ${ev.startTime} ${ev.title}${suffix}`;
    })
    .join('\n');
}

/**
 * Fetch today's events. Strategy:
 * 1. Try local EventKit (covers iCloud + Outlook via Calendar.app)
 * 2. Fall back to CalDAV if EventKit unavailable
 * 3. Return "Calendar not configured." if neither works
 */
async function gatherCalendar(): Promise<string> {
  // 1. Try EventKit first
  const ekEvents = await fetchEventKitEvents();
  if (ekEvents !== null) {
    log.debug('Using EventKit calendar data', { eventCount: ekEvents.length });
    return formatEventKitEvents(ekEvents);
  }

  // 2. Fall back to CalDAV
  const config = loadConfig();
  const caldavConfig = config.calendar?.caldav;

  if (!caldavConfig?.url) {
    log.debug('No CalDAV config — skipping external calendar');
    return 'Calendar not configured.';
  }

  try {
    const events = await fetchTodayEvents(caldavConfig);

    if (events.length === 0) return 'No events today.';

    return events
      .map(ev => {
        if (ev.allDay) return `• ${ev.title}`;
        return `• ${ev.startTime} ${ev.title}`;
      })
      .join('\n');
  } catch (err) {
    log.warn('CalDAV calendar fetch failed', { error: errMsg(err) });
    return 'Calendar unavailable.';
  }
}

function gatherInternalCalendar(): string {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const events = query<{ title: string; start_time: string; all_day: number }>(
      "SELECT title, start_time, all_day FROM calendar WHERE date(start_time) = date(?) ORDER BY start_time ASC",
      todayStr,
    );
    if (events.length === 0) return '';
    return events
      .map(ev => {
        const time = ev.all_day ? '' : ` ${ev.start_time.slice(11, 16)}`;
        return `• ${ev.title}${time}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

// ── Weather ──────────────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
};

async function gatherWeather(location: string): Promise<string> {
  try {
    const geoRaw = await execCommand('/usr/bin/curl', [
      '-s', '--max-time', '5',
      `${loadConfig().weather?.geocoding_api_url ?? 'https://geocoding-api.open-meteo.com/v1/search'}?name=${encodeURIComponent(location)}&count=1`,
    ]);
    const geo = JSON.parse(geoRaw.trim());
    if (!geo.results?.length) throw new Error('No geocoding results');
    const { latitude, longitude, timezone } = geo.results[0];

    const url = `${loadConfig().weather?.forecast_api_url ?? 'https://api.open-meteo.com/v1/forecast'}?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
      `&timezone=${encodeURIComponent(timezone)}&forecast_days=3`;

    const raw = await execCommand('/usr/bin/curl', ['-s', '--max-time', '8', url]);
    const data = JSON.parse(raw.trim());
    const c = data.current;
    const desc = WMO_CODES[c.weather_code as number] ?? `Code ${c.weather_code}`;
    const feelsLike = c.apparent_temperature != null
      ? ` (feels ${Math.round(c.apparent_temperature)}°)`
      : '';

    const currentLine = `${desc} ${Math.round(c.temperature_2m)}°F${feelsLike} · ` +
      `Humidity ${c.relative_humidity_2m}% · Wind ${Math.round(c.wind_speed_10m)} mph`;

    const days = data.daily;
    const dayNames = ['Today', 'Tomorrow'];
    const forecastLines: string[] = [];
    for (let i = 0; i < Math.min(days.time.length, 3); i++) {
      const label = dayNames[i] ??
        new Date(days.time[i] + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      const hi = Math.round(days.temperature_2m_max[i]);
      const lo = Math.round(days.temperature_2m_min[i]);
      const precip = days.precipitation_probability_max[i];
      const dayDesc = WMO_CODES[days.weather_code[i] as number] ?? '';
      const precipStr = precip > 10 ? ` · ${precip}% precip` : '';
      forecastLines.push(`  ${label}: ${dayDesc}, ${hi}°/${lo}°F${precipStr}`);
    }

    return `${currentLine}\n${forecastLines.join('\n')}`;
  } catch (err) {
    log.warn('Open-Meteo failed, trying wttr.in fallback', { error: errMsg(err) });
  }

  try {
    const loc = location.replace(/\s+/g, '+');
    const current = await execCommand('/usr/bin/curl', [
      '-s', '--max-time', '8',
      `${loadConfig().weather?.wttr_base_url ?? 'https://wttr.in'}/${loc}?format=%c+%t+|+Humidity:+%h+|+Wind:+%w`,
    ]);
    return current.trim() || 'Weather unavailable.';
  } catch (err) {
    log.warn('wttr.in also failed', { error: errMsg(err) });
    return 'Weather unavailable.';
  }
}

// ── Reminders (Apple Reminders via EventKit helper) ──────────

interface AppleReminder {
  title: string;
  list: string;
  priority: number;
  dueDate?: string;
  notes?: string;
}

/**
 * Fetch incomplete Apple Reminders. Strategy:
 * 1. Try running the compiled binary directly
 * 2. Fall back to swift interpreter
 * 3. Fall back to cache file
 */
async function gatherReminders(): Promise<string> {
  const scriptPath = path.join(getProjectDir(), 'scripts', 'reminders.swift');
  const binaryPath = scriptPath.replace(/\.swift$/, '');
  let reminders: AppleReminder[] | null = null;

  // 1. Try binary/script
  try {
    if (fs.existsSync(binaryPath)) {
      const output = await execCommand(binaryPath, [], 15_000);
      const parsed = JSON.parse(output.trim());
      if (!parsed.error && Array.isArray(parsed)) {
        reminders = parsed;
      }
    } else if (fs.existsSync(scriptPath)) {
      const output = await execCommand('/usr/bin/swift', [scriptPath], 30_000);
      const parsed = JSON.parse(output.trim());
      if (!parsed.error && Array.isArray(parsed)) {
        reminders = parsed;
      }
    }
  } catch (err) {
    log.debug('Reminders helper failed (will try cache)', { error: errMsg(err) });
  }

  // 2. Fall back to cache
  if (!reminders) {
    try {
      const home = process.env.HOME ?? '/Users/agent';
      const cachePath = path.join(home, '.cache', 'kithkit', 'reminders.json');
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const cache = JSON.parse(raw);
        const cachedAt = new Date(cache.cached_at);
        const ageHours = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60);
        if (ageHours < 24 && Array.isArray(cache.reminders)) {
          log.info('Using cached reminders', { ageHours: Math.round(ageHours * 10) / 10, count: cache.reminders.length });
          reminders = cache.reminders;
        }
      }
    } catch (err) {
      log.debug('Reminders cache read failed', { error: errMsg(err) });
    }
  }

  if (!reminders || reminders.length === 0) return 'No reminders.';

  // Format: group by list, show priority and due date
  const byList = new Map<string, AppleReminder[]>();
  for (const r of reminders) {
    const list = byList.get(r.list) ?? [];
    list.push(r);
    byList.set(r.list, list);
  }

  const lines: string[] = [];
  for (const [listName, items] of byList) {
    if (byList.size > 1) lines.push(`<i>${listName}</i>`);
    for (const r of items.slice(0, 8)) {
      const pri = r.priority === 1 ? ' !!' : r.priority === 5 ? ' !' : '';
      const due = r.dueDate ? ` (${r.dueDate})` : '';
      lines.push(`• ${r.title}${pri}${due}`);
    }
    if (items.length > 8) lines.push(`  … +${items.length - 8} more`);
  }

  return lines.join('\n');
}

// ── Email (from task_results) ────────────────────────────────

function gatherEmailSummary(): string {
  try {
    const rows = query<{ output: string | null }>(
      `SELECT output FROM task_results
       WHERE task_name = 'email-check' AND status = 'success'
       ORDER BY id DESC LIMIT 1`,
    );
    if (rows.length > 0 && rows[0]!.output) {
      return rows[0]!.output;
    }
    return 'No recent email data.';
  } catch {
    return 'Email data unavailable.';
  }
}

// ── Overnight Messages ───────────────────────────────────────

function gatherOvernightMessages(): string {
  const logPath = path.join(getProjectDir(), 'logs/daemon.log');
  try {
    if (!fs.existsSync(logPath)) return 'No overnight messages.';

    const eightHoursAgo = Date.now() - 8 * 60 * 60 * 1000;
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    const messages: string[] = [];

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.ts).getTime() < eightHoursAgo) continue;

        if (entry.module === 'telegram' && entry.msg?.includes('Injected message from')) {
          messages.push(`Telegram: ${entry.msg}`);
        }
        if (entry.module === 'agent-comms' && entry.msg?.includes('Received message from')) {
          messages.push(`Agent: ${entry.msg}`);
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (messages.length === 0) return 'No overnight messages.';
    return [...new Set(messages)].slice(-10).join('\n');
  } catch {
    return 'Message log unavailable.';
  }
}

// ── Delivery ─────────────────────────────────────────────────

async function sendBriefing(
  message: string,
  channels?: string[],
  telegramChatId?: string,
): Promise<void> {
  const config = loadConfig();
  const port = (config as unknown as Record<string, Record<string, unknown>>)?.daemon?.port ?? 3847;

  const payload: Record<string, unknown> = {
    message,
    parse_mode: 'HTML',
  };
  if (channels && channels.length > 0) {
    payload.channels = channels;
  }
  // Allow targeting a specific Telegram chat (e.g., Chrissy's DM vs Dave's group)
  if (telegramChatId) {
    payload.metadata = { chatId: telegramChatId };
  }

  const resp = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error(`Send API returned ${resp.status}`);
  }
}

// ── Main ─────────────────────────────────────────────────────

async function run(config: Record<string, unknown>): Promise<string> {
  // Dedup guard: skip if a briefing was sent in the last hour (prevents
  // accidental duplicates from manual /api/tasks/.../run triggers)
  try {
    const recent = query<{ id: number }>(
      `SELECT id FROM task_results
       WHERE task_name = 'morning-briefing' AND status = 'success'
       AND started_at > datetime('now', '-1 hour')
       LIMIT 1`,
    );
    if (recent.length > 0) {
      log.info('Skipping morning briefing — already sent within the last hour');
      return 'Skipped (duplicate within 1 hour)';
    }
  } catch { /* proceed if check fails */ }

  log.info('Gathering morning briefing data');

  const location = (config.weather_location as string) ?? 'Baltimore';
  const channels = config.channels as string[] | undefined;
  const telegramChatId = config.telegram_chat_id as string | undefined;

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  // Gather data in parallel
  const [weather, calendar, reminders] = await Promise.all([
    gatherWeather(location),
    gatherCalendar(),
    gatherReminders(),
  ]);

  // Synchronous DB/filesystem queries
  const internalCal = gatherInternalCalendar();
  const email = gatherEmailSummary();
  const overnight = gatherOvernightMessages();

  // Format as Telegram-friendly HTML
  const parts: string[] = [
    `<b>Morning Briefing — ${today}</b>`,
    '',
    '<b>Weather</b>',
    weather,
    '',
    '<b>Calendar</b>',
    calendar,
  ];

  parts.push('', '<b>Reminders</b>', reminders);

  if (internalCal) {
    parts.push('', '<b>Agent Notes</b>', internalCal);
  }

  if (email !== 'No recent email data.') {
    parts.push('', '<b>Email</b>', email);
  }

  if (overnight !== 'No overnight messages.') {
    parts.push('', '<b>Overnight</b>', overnight);
  }

  const message = parts.join('\n').trim();

  await sendBriefing(message, channels, telegramChatId);

  const summary = `Sent briefing: weather OK, ` +
    `${calendar === 'No events today.' || calendar === 'Calendar not configured.' ? '0 events' : 'events listed'}, ` +
    `${reminders === 'No reminders.' ? '0 reminders' : 'reminders listed'}`;
  log.info('Morning briefing sent', { summary });
  return summary;
}

// ── Registration ─────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('morning-briefing', async (ctx) => {
    await run(ctx.config);
  });
}
