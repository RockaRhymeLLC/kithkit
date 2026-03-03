/**
 * Morning Briefing — sends the human a daily summary.
 *
 * Gathers: calendar events (icalbuddy + DB), weather (Open-Meteo + wttr.in),
 * open todos (SQLite), overnight messages (log), email summary (adapters),
 * Lindee inbox summary (flat file).
 *
 * If a Claude session is active, injects data as a prompt for a nicely
 * formatted briefing. If no session, sends a plain-text version directly
 * via Telegram so the briefing always arrives on time.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { injectText, sessionExists } from '../../../core/session-bridge.js';
import { createLogger } from '../../../core/logger.js';
import { getProjectDir, loadConfig } from '../../../core/config.js';
import { query } from '../../../core/db.js';
import type { Scheduler } from '../../../automation/scheduler.js';
// TODO: Adapter getters removed in upstream PR #136 refactor. Stubbed for now.
// Morning briefing needs refactoring to use channel router instead.
function getTelegramAdapter(): any { return null; }
function getGraphAdapter(): any { return null; }
function getJmapAdapter(): any { return null; }
function getOutlookAdapter(): any { return null; }
function getHimalayaAdapters(): any[] { return []; }

const log = createLogger('morning-briefing');

// ─── Holidays ────────────────────────────────────────────────────────

const FIXED_HOLIDAYS: Record<string, string> = {
  '1-1': '🎉 Happy New Year!',
  '2-14': '💕 Happy Valentine\'s Day!',
  '3-17': '☘️ Happy St. Patrick\'s Day!',
  '7-4': '🇺🇸 Happy Independence Day!',
  '10-31': '🎃 Happy Halloween!',
  '11-11': '🎖️ Veterans Day — thank a veteran today.',
  '12-24': '🎄 Christmas Eve!',
  '12-25': '🎄 Merry Christmas!',
  '12-31': '🥂 Happy New Year\'s Eve!',
};

function getSpecialDayNote(): string | null {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const dow = now.getDay();

  const key = `${month}-${day}`;
  if (FIXED_HOLIDAYS[key]) return FIXED_HOLIDAYS[key];

  // Floating holidays (nth weekday of month)
  if (month === 1 && dow === 1 && day >= 15 && day <= 21) return '🕊️ Martin Luther King Jr. Day';
  if (month === 2 && dow === 1 && day >= 15 && day <= 21) return '🏛️ Presidents\' Day';
  if (month === 5 && dow === 0 && day >= 8 && day <= 14) return '💐 Happy Mother\'s Day!';
  if (month === 5 && dow === 1 && day >= 25) return '🇺🇸 Memorial Day — remember those who served.';
  if (month === 6 && dow === 0 && day >= 15 && day <= 21) return '👔 Happy Father\'s Day!';
  if (month === 9 && dow === 1 && day <= 7) return '🔨 Happy Labor Day!';
  if (month === 11 && dow === 4 && day >= 22 && day <= 28) return '🦃 Happy Thanksgiving!';

  return null;
}

// ─── Calendar ────────────────────────────────────────────────────────

function gatherCalendar(): string {
  try {
    const output = execSync(
      'icalbuddy -n -nc -nrd -npn -ea -eep notes,url -df "%A, %b %e, %Y" -b "• " -iep title,datetime,attendees eventsToday',
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
    return output || 'No events today.';
  } catch {
    log.warn('icalbuddy failed or not available');
    return 'Calendar unavailable.';
  }
}

function gatherLookahead(): string {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const end = new Date();
    end.setDate(end.getDate() + 7);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const output = execSync(
      `icalbuddy -nc -nrd -npn -ea -eep notes,url -df "%A, %b %e, %Y" -b "• " -iep title,datetime eventsFrom:"${fmt(tomorrow)}" to:"${fmt(end)}"`,
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
    return output || 'Nothing notable in the next 7 days.';
  } catch {
    log.warn('icalbuddy lookahead failed');
    return 'Lookahead unavailable.';
  }
}

function gatherInternalCalendar(): string {
  try {
    const now = new Date();
    const todayStr = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    const tmrw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowStr = [tmrw.getFullYear(), String(tmrw.getMonth() + 1).padStart(2, '0'), String(tmrw.getDate()).padStart(2, '0')].join('-');

    const events = query<{ id: number; title: string; start_time: string; end_time: string | null; all_day: number; description: string | null }>(
      "SELECT * FROM calendar WHERE date(start_time) >= date(?) AND date(start_time) <= date(?) ORDER BY start_time ASC",
      todayStr, tomorrowStr,
    );

    if (events.length === 0) return '';

    const entries: string[] = [];
    for (const ev of events) {
      const label = ev.start_time.slice(0, 10) === todayStr ? 'Today' : 'Tomorrow';
      const time = ev.all_day ? '' : ` ${ev.start_time.slice(11, 16)}`;
      entries.push(`[${label}]${time} ${ev.title}`);
    }

    return entries.join('\n');
  } catch {
    return '';
  }
}

// ─── Weather ─────────────────────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
};

function wmoDescription(code: number): string {
  return WMO_CODES[code] ?? `Unknown (${code})`;
}

function fetchOpenMeteo(location: string): string {
  const geoRaw = execFileSync('/usr/bin/curl', [
    '-s', '--max-time', '5',
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
  ], { encoding: 'utf8', timeout: 8_000 }).trim();

  if (!geoRaw) throw new Error('Empty geocoding response');
  const geo = JSON.parse(geoRaw);
  if (!geo.results?.length) throw new Error(`No geocoding results for "${location}"`);

  const { latitude, longitude, timezone } = geo.results[0];

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&timezone=${encodeURIComponent(timezone)}&forecast_days=3`;

  const raw = execFileSync('/usr/bin/curl', [
    '-s', '--max-time', '8', url,
  ], { encoding: 'utf8', timeout: 12_000 }).trim();

  if (!raw) throw new Error('Empty forecast response');
  const data = JSON.parse(raw);

  const c = data.current;
  const feelsLike = c.apparent_temperature != null ? ` (feels ${Math.round(c.apparent_temperature)}°)` : '';
  const currentLine = `${wmoDescription(c.weather_code)} ${Math.round(c.temperature_2m)}°F${feelsLike} · Humidity ${c.relative_humidity_2m}% · Wind ${Math.round(c.wind_speed_10m)} mph`;

  const days = data.daily;
  const dayNames = ['Today', 'Tomorrow'];
  const forecastLines: string[] = [];
  for (let i = 0; i < days.time.length; i++) {
    const label = dayNames[i] ?? new Date(days.time[i] + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
    const hi = Math.round(days.temperature_2m_max[i]);
    const lo = Math.round(days.temperature_2m_min[i]);
    const precip = days.precipitation_probability_max[i];
    const desc = wmoDescription(days.weather_code[i]);
    const precipStr = precip > 10 ? ` · ${precip}% precip` : '';
    forecastLines.push(`  ${label}: ${desc}, ${hi}°/${lo}°F${precipStr}`);
  }

  return `${currentLine}\n${forecastLines.join('\n')}`;
}

function fetchWttrIn(location: string): string {
  const loc = location ? `/${location.replace(/\s+/g, '+')}` : '';

  const current = execFileSync('/usr/bin/curl', [
    '-s', '--max-time', '8',
    `wttr.in${loc}?format=%c+%t+|+Humidity:+%h+|+Wind:+%w`,
  ], { encoding: 'utf8', timeout: 10_000 }).trim();

  const forecast = execFileSync('/usr/bin/curl', [
    '-s', '--max-time', '8',
    `wttr.in${loc}?format=3`,
  ], { encoding: 'utf8', timeout: 10_000 }).trim();

  if (!current && !forecast) throw new Error('Both wttr.in requests returned empty');
  const parts = [];
  if (current) parts.push(`Now: ${current}`);
  if (forecast) parts.push(`Forecast: ${forecast}`);
  return parts.join('\n');
}

function gatherWeather(): string {
  const config = loadConfig();
  const task = config.scheduler.tasks.find((t: { name: string }) => t.name === 'morning-briefing');
  const location = (task?.config?.weather_location as string) ?? 'Baltimore';

  try {
    return fetchOpenMeteo(location);
  } catch (err) {
    log.warn('Open-Meteo failed, trying wttr.in fallback', { error: err instanceof Error ? err.message : String(err) });
  }

  try {
    return fetchWttrIn(location);
  } catch (err) {
    log.warn('wttr.in also failed', { error: err instanceof Error ? err.message : String(err) });
    return 'Weather unavailable.';
  }
}

// ─── Todos ───────────────────────────────────────────────────────────

function gatherTodos(): string {
  try {
    const rows = query<{ id: number; title: string; priority: string; status: string; due_date: string | null }>(
      "SELECT id, title, priority, status, due_date FROM todos WHERE status NOT IN ('completed', 'cancelled') ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC",
    );

    if (rows.length === 0) return 'No open to-dos.';

    const lines: string[] = [];
    for (const row of rows) {
      const priority = (row.priority ?? 'medium').toUpperCase();
      const due = row.due_date ? ` (due: ${row.due_date})` : '';
      lines.push(`[${row.id}] ${priority} — ${row.title}${due}`);
    }
    return lines.join('\n');
  } catch {
    return 'To-do list unavailable.';
  }
}

// ─── Overnight Messages ──────────────────────────────────────────────

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
        const ts = new Date(entry.ts).getTime();
        if (ts < eightHoursAgo) continue;

        if (entry.module === 'telegram' && entry.msg?.includes('Injected message from')) {
          messages.push(`Telegram: ${entry.msg}`);
        }
        if (entry.module === 'agent-comms' && entry.msg?.includes('Received message from')) {
          messages.push(`Agent: ${entry.msg}`);
        }
        if (entry.module === 'email-check' && entry.msg?.includes('unread')) {
          messages.push(`Email: ${entry.msg}`);
        }
      } catch {
        // skip non-JSON lines
      }
    }

    if (messages.length === 0) return 'No overnight messages.';
    const unique = [...new Set(messages)];
    return unique.slice(-10).join('\n');
  } catch {
    return 'Message log unavailable.';
  }
}

// ─── Lindee Summary ──────────────────────────────────────────────────

function gatherLindeeSummary(): string {
  const summaryFile = path.join(getProjectDir(), '.claude/state/lindee-daily-summary.json');
  try {
    if (!fs.existsSync(summaryFile)) return '';
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    if (summary.date !== yesterdayStr && summary.date !== today) return '';
    if (summary.emailsProcessed === 0) return '';

    const lines: string[] = [];
    lines.push(`${summary.emailsProcessed} emails processed`);

    if (summary.spamRemoved > 0 || summary.phishingRemoved > 0) {
      lines.push(`${summary.spamRemoved} spam + ${summary.phishingRemoved} phishing removed`);
    }
    if (summary.purchases.length > 0) {
      lines.push('Purchases:');
      for (const p of summary.purchases) {
        lines.push(`  - ${p.vendor}: ${p.item} (${p.cost})`);
      }
    }
    if (summary.duplicateAlerts.length > 0) {
      lines.push(`Duplicate alerts: ${summary.duplicateAlerts.length}`);
    }
    if (summary.paymentAlerts.length > 0) {
      lines.push('Payment alerts:');
      for (const a of summary.paymentAlerts) {
        lines.push(`  - ${a}`);
      }
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

// ─── Email Summary ───────────────────────────────────────────────────

async function gatherEmailSummary(): Promise<string> {
  try {
    const emails: string[] = [];
    let totalUnread = 0;

    const graph = getGraphAdapter();
    if (graph) {
      try {
        const inbox = await graph.listInbox(10);
        for (const msg of inbox) {
          if (!msg.isRead) { totalUnread++; emails.push(`[Graph] ${msg.from}: ${msg.subject}`); }
        }
      } catch (err) {
        log.warn('Graph email check failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const jmap = getJmapAdapter();
    if (jmap) {
      try {
        const inbox = await jmap.listInbox(10);
        for (const msg of inbox) {
          if (!msg.isRead) { totalUnread++; emails.push(`[JMAP] ${msg.from}: ${msg.subject}`); }
        }
      } catch (err) {
        log.warn('JMAP email check failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    const outlook = getOutlookAdapter();
    if (outlook) {
      try {
        const inbox = await outlook.listInbox(10);
        for (const msg of inbox) {
          if (!msg.isRead) { totalUnread++; emails.push(`[Outlook] ${msg.from}: ${msg.subject}`); }
        }
      } catch (err) {
        log.warn('Outlook email check failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    for (const hAdapter of getHimalayaAdapters()) {
      try {
        const inbox = await hAdapter.listInbox(10);
        for (const msg of inbox) {
          if (!msg.isRead) { totalUnread++; emails.push(`[${hAdapter.name}] ${msg.from}: ${msg.subject}`); }
        }
      } catch (err) {
        log.warn('Himalaya adapter check failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (totalUnread === 0) return 'No unread emails.';
    return `${totalUnread} unread email(s):\n${emails.slice(0, 10).join('\n')}${totalUnread > 10 ? `\n...and ${totalUnread - 10} more` : ''}`;
  } catch (err) {
    log.warn('Email summary failed', { error: err instanceof Error ? err.message : String(err) });
    return 'Email summary unavailable.';
  }
}

// ─── Telegram Fallback ───────────────────────────────────────────────

async function sendDirectTelegram(text: string): Promise<void> {
  try {
    const adapter = getTelegramAdapter();
    if (!adapter) {
      log.warn('No Telegram adapter available for direct briefing');
      return;
    }
    await adapter.sendDirect(text);
    log.info('Sent briefing directly via Telegram (no session fallback)');
  } catch (err) {
    log.error('Failed to send Telegram fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Formatting ──────────────────────────────────────────────────────

function formatPlainBriefing(sections: {
  today: string;
  weather: string;
  calendar: string;
  internalCal: string;
  lookahead: string;
  todos: string;
  overnight: string;
  emailSummary: string;
  specialDay?: string | null;
  lindeeSummary?: string;
}): string {
  const { today, weather, calendar, internalCal, lookahead, todos, overnight, emailSummary, specialDay, lindeeSummary } = sections;

  const greeting = specialDay
    ? `${specialDay}\nGood morning! Here's your briefing for ${today}.`
    : `Good morning! Here's your briefing for ${today}.`;

  const blocks: string[] = [greeting];

  blocks.push(`\n☁️ Weather\n${weather}`);
  blocks.push(`\n📅 Today\n${calendar}`);

  if (internalCal) {
    blocks.push(`\n🔔 Reminders\n${internalCal}`);
  }

  if (lookahead && !lookahead.includes('Nothing notable') && !lookahead.includes('unavailable')) {
    blocks.push(`\n🗓 Coming Up\n${lookahead}`);
  }

  blocks.push(`\n✅ To-Dos\n${todos}`);

  if (emailSummary && emailSummary !== 'No unread emails.') {
    blocks.push(`\n📧 Email\n${emailSummary}`);
  }

  if (overnight && overnight !== 'No overnight messages.') {
    blocks.push(`\n💬 Overnight\n${overnight}`);
  }

  if (lindeeSummary) {
    blocks.push(`\n👩‍🦳 Lindee's Email\n${lindeeSummary}`);
  }

  return blocks.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log.info('Gathering morning briefing data');

  const calendar = gatherCalendar();
  const weather = gatherWeather();
  const lookahead = gatherLookahead();
  const internalCal = gatherInternalCalendar();
  const todos = gatherTodos();
  const overnight = gatherOvernightMessages();
  const emailSummary = await gatherEmailSummary();
  const lindeeSummary = gatherLindeeSummary();
  const specialDay = getSpecialDayNote();

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  if (sessionExists()) {
    const config = loadConfig();
    const prompt = [
      `[System] Morning briefing time! Today is ${today}.`,
      'Send the human a concise, friendly morning briefing via Telegram with the data below.',
      'Format it nicely but keep it short — a snapshot, not an essay.',
      'Include any notable items and a cheerful greeting.',
      'If the lookahead has anything notable (birthdays, travel, big storms, deadlines), call it out.',
      'IMPORTANT: Calendar data includes day-of-week labels (e.g. "Thursday, Feb 12"). Use those labels exactly — do NOT compute day names from dates yourself.',
      ...(specialDay ? ['', `SPECIAL DAY: ${specialDay}`, 'Weave this into your greeting naturally — make it feel warm and personal, not just tacked on.'] : []),
      '',
      `WEATHER:\n${weather}`,
      '',
      `CALENDAR:\n${calendar}`,
      ...(internalCal ? ['', `${config.agent.name.toUpperCase()}'S REMINDERS:\n${internalCal}`] : []),
      '',
      `COMING UP (next 7 days):\n${lookahead}`,
      '',
      `OPEN TO-DOS:\n${todos}`,
      '',
      `OVERNIGHT MESSAGES:\n${overnight}`,
      '',
      `EMAIL INBOX:\n${emailSummary}`,
      ...(lindeeSummary ? ['', `LINDEE'S EMAIL (Mom's inbox monitoring):\n${lindeeSummary}`] : []),
    ].join('\n');

    log.info('Injecting morning briefing prompt');
    injectText(prompt);
  } else {
    log.warn('No Claude session available — sending plain-text briefing via Telegram');
    const briefing = formatPlainBriefing({
      today, weather, calendar, internalCal, lookahead,
      todos, overnight, emailSummary, specialDay, lindeeSummary,
    });
    await sendDirectTelegram(briefing);
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('morning-briefing', async () => {
    await run();
  });
}
