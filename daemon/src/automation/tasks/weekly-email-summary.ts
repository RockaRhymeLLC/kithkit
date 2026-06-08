/**
 * Weekly Email Summary — Saturday 9am action items report.
 *
 * Runs every Saturday at 9am (cron: 0 9 * * 6).
 * Fetches the past week's inbox and sent items from M365,
 * extracts action items and commitments Will made,
 * then delivers a summary via:
 * - Telegram (via POST /api/send)
 * - Email to wloving@servos.io (via POST /api/m365/send)
 *
 * Data sources:
 * - GET /api/m365/messages?folder=inbox&top=50 (received mail)
 * - GET /api/m365/messages?folder=sentItems&top=50 (sent mail)
 *
 * Configuration (kithkit.config.yaml scheduler task config):
 *   recipient_email: wloving@servos.io    # email delivery target
 *   inbox_top: 50                          # max inbox messages
 *   sent_top: 50                           # max sent messages
 */

import { loadConfig } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('weekly-email-summary');

// ── Types ────────────────────────────────────────────────────

interface EmailMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
}

interface MessageList {
  value: EmailMessage[];
}

// ── Helpers ──────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getPort(): number {
  const config = loadConfig();
  return (config as unknown as Record<string, Record<string, unknown>>)?.daemon?.port as number ?? 3847;
}

/**
 * Fetch messages from M365 via the daemon API.
 * Returns empty list on failure rather than throwing.
 */
async function fetchMessages(folder: string, top: number): Promise<EmailMessage[]> {
  const port = getPort();
  const url = `http://127.0.0.1:${port}/api/m365/messages?folder=${encodeURIComponent(folder)}&top=${top}&select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,isRead`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log.warn(`Failed to fetch ${folder} messages`, { status: resp.status });
      return [];
    }
    const data = await resp.json() as MessageList;
    return data.value ?? [];
  } catch (err) {
    log.warn(`Error fetching ${folder} messages`, { error: errMsg(err) });
    return [];
  }
}

// ── Action Item Extraction ────────────────────────────────────

/**
 * Keyword patterns that suggest action items or commitments in email subjects/previews.
 * This is a lightweight heuristic — no LLM call needed for basic extraction.
 */
const ACTION_KEYWORDS = [
  'please', 'can you', 'could you', 'would you', 'need you',
  'action required', 'action item', 'follow up', 'follow-up',
  'deadline', 'due', 'by eod', 'by end of day', 'by monday',
  'by tuesday', 'by wednesday', 'by thursday', 'by friday',
  'asap', 'urgent', 'reminder', 'reminder:', 're:', 'fwd:',
  'meeting', 'call', 'review', 'approve', 'sign off', 'sign-off',
  'feedback', 'response needed', 'reply needed', 'waiting on you',
  'confirm', 'schedule', 'let me know', 'get back to me',
  'task', 'deliverable', 'milestone',
];

const COMMITMENT_KEYWORDS = [
  'i will', "i'll", 'i can', 'i would', 'i plan to',
  'we will', "we'll", 'we can', 'we plan to',
  'will send', 'will review', 'will follow up', 'will get back',
  'will schedule', 'will confirm', 'will provide', 'will share',
  'will complete', 'will finish', 'will deliver',
  'sending over', 'attaching', 'attached', 'as promised',
];

function scoreMessage(msg: EmailMessage, isInbox: boolean): number {
  const text = [msg.subject ?? '', msg.bodyPreview ?? ''].join(' ').toLowerCase();
  let score = 0;

  if (isInbox) {
    for (const kw of ACTION_KEYWORDS) {
      if (text.includes(kw)) score++;
    }
  } else {
    for (const kw of COMMITMENT_KEYWORDS) {
      if (text.includes(kw)) score++;
    }
    // Also check if sent item has action keywords (replies that include original)
    for (const kw of ACTION_KEYWORDS) {
      if (text.includes(kw)) score += 0.5;
    }
  }

  return score;
}

interface ActionItem {
  type: 'inbox' | 'sent';
  from: string;
  subject: string;
  preview: string;
  date: string;
  score: number;
}

/**
 * Extract action items from inbox (things requiring Will's attention)
 * and commitments from sent items (things Will said he'd do).
 */
function extractActionItems(
  inbox: EmailMessage[],
  sent: EmailMessage[],
): ActionItem[] {
  const items: ActionItem[] = [];

  for (const msg of inbox) {
    const score = scoreMessage(msg, true);
    if (score > 0) {
      const fromName = msg.from?.emailAddress?.name ?? msg.from?.emailAddress?.address ?? 'Unknown';
      const date = msg.receivedDateTime ? new Date(msg.receivedDateTime).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) : '';
      items.push({
        type: 'inbox',
        from: fromName,
        subject: msg.subject ?? '(no subject)',
        preview: (msg.bodyPreview ?? '').slice(0, 120),
        date,
        score,
      });
    }
  }

  for (const msg of sent) {
    const score = scoreMessage(msg, false);
    if (score > 0) {
      const toName = msg.toRecipients?.[0]?.emailAddress?.name ??
        msg.toRecipients?.[0]?.emailAddress?.address ?? 'Unknown';
      const date = msg.sentDateTime ? new Date(msg.sentDateTime).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      }) : '';
      items.push({
        type: 'sent',
        from: toName,
        subject: msg.subject ?? '(no subject)',
        preview: (msg.bodyPreview ?? '').slice(0, 120),
        date,
        score,
      });
    }
  }

  // Sort by score descending, then by date (most recent first)
  items.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));

  return items;
}

// ── Formatting ───────────────────────────────────────────────

/**
 * Format the weekly summary as Telegram-friendly HTML.
 */
function formatTelegramSummary(
  actionItems: ActionItem[],
  inbox: EmailMessage[],
  sent: EmailMessage[],
  weekRange: string,
): string {
  const parts: string[] = [];
  parts.push(`<b>Weekly Email Summary — ${weekRange}</b>`);
  parts.push('');
  parts.push(`<b>Volume</b>`);
  parts.push(`Inbox: ${inbox.length} messages | Sent: ${sent.length} messages`);

  const inboxItems = actionItems.filter(i => i.type === 'inbox').slice(0, 8);
  const sentItems = actionItems.filter(i => i.type === 'sent').slice(0, 5);

  if (inboxItems.length > 0) {
    parts.push('');
    parts.push('<b>Needs Your Attention</b>');
    for (const item of inboxItems) {
      parts.push(`• <b>${item.subject}</b>`);
      parts.push(`  From: ${item.from} | ${item.date}`);
      if (item.preview) {
        const short = item.preview.length > 80 ? item.preview.slice(0, 77) + '...' : item.preview;
        parts.push(`  ${short}`);
      }
    }
  } else {
    parts.push('');
    parts.push('<b>Needs Your Attention</b>');
    parts.push('No high-priority action items detected.');
  }

  if (sentItems.length > 0) {
    parts.push('');
    parts.push('<b>Commitments You Made</b>');
    for (const item of sentItems) {
      parts.push(`• <b>${item.subject}</b>`);
      parts.push(`  To: ${item.from} | ${item.date}`);
      if (item.preview) {
        const short = item.preview.length > 80 ? item.preview.slice(0, 77) + '...' : item.preview;
        parts.push(`  ${short}`);
      }
    }
  }

  return parts.join('\n').trim();
}

/**
 * Format the summary as plain-text email body.
 */
function formatEmailBody(
  actionItems: ActionItem[],
  inbox: EmailMessage[],
  sent: EmailMessage[],
  weekRange: string,
): string {
  const lines: string[] = [];
  lines.push(`Weekly Email Summary — ${weekRange}`);
  lines.push('='.repeat(50));
  lines.push('');
  lines.push(`Volume: ${inbox.length} received | ${sent.length} sent this week`);

  const inboxItems = actionItems.filter(i => i.type === 'inbox').slice(0, 10);
  const sentItems = actionItems.filter(i => i.type === 'sent').slice(0, 7);

  lines.push('');
  lines.push('NEEDS YOUR ATTENTION');
  lines.push('-'.repeat(30));
  if (inboxItems.length > 0) {
    for (const item of inboxItems) {
      lines.push(`Subject: ${item.subject}`);
      lines.push(`From:    ${item.from}  |  ${item.date}`);
      if (item.preview) {
        lines.push(`Preview: ${item.preview}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No high-priority action items detected.');
    lines.push('');
  }

  lines.push('COMMITMENTS YOU MADE');
  lines.push('-'.repeat(30));
  if (sentItems.length > 0) {
    for (const item of sentItems) {
      lines.push(`Subject: ${item.subject}`);
      lines.push(`To:      ${item.from}  |  ${item.date}`);
      if (item.preview) {
        lines.push(`Preview: ${item.preview}`);
      }
      lines.push('');
    }
  } else {
    lines.push('No commitment-related sent items detected.');
    lines.push('');
  }

  lines.push('---');
  lines.push('Generated by Marvbot weekly email summary task.');

  return lines.join('\n');
}

// ── Delivery ─────────────────────────────────────────────────

/**
 * Send the summary via Telegram using the daemon channel router.
 */
async function sendTelegram(message: string): Promise<void> {
  const port = getPort();
  const resp = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      parse_mode: 'HTML',
    }),
  });

  if (!resp.ok) {
    throw new Error(`Telegram send failed (${resp.status})`);
  }
}

/**
 * Send the summary via M365 email.
 */
async function sendEmail(
  subject: string,
  body: string,
  recipientEmail: string,
): Promise<void> {
  const port = getPort();
  const resp = await fetch(`http://127.0.0.1:${port}/api/m365/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: recipientEmail,
      subject,
      body,
      contentType: 'Text',
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Email send failed (${resp.status}): ${text}`);
  }
}

// ── Main ─────────────────────────────────────────────────────

async function run(config: Record<string, unknown>): Promise<string> {
  const startMs = Date.now();
  const recipientEmail = (config.recipient_email as string) ?? 'wloving@servos.io';
  const inboxTop = (config.inbox_top as number) ?? 50;
  const sentTop = (config.sent_top as number) ?? 50;

  // Calculate week range (past 7 days)
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRange = `${weekAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
  const emailSubject = `Weekly Email Summary — ${weekRange}`;

  log.info('Running weekly email summary', { recipientEmail, inboxTop, sentTop, weekRange });

  // Fetch inbox and sent items in parallel
  const [inbox, sent] = await Promise.all([
    fetchMessages('inbox', inboxTop),
    fetchMessages('sentItems', sentTop),
  ]);

  log.info('Fetched messages', { inboxCount: inbox.length, sentCount: sent.length });

  // Extract action items
  const actionItems = extractActionItems(inbox, sent);
  log.info('Extracted action items', {
    totalActionItems: actionItems.length,
    inboxItems: actionItems.filter(i => i.type === 'inbox').length,
    sentItems: actionItems.filter(i => i.type === 'sent').length,
  });

  // Format messages
  const telegramMsg = formatTelegramSummary(actionItems, inbox, sent, weekRange);
  const emailBody = formatEmailBody(actionItems, inbox, sent, weekRange);

  // Deliver in parallel
  const results = await Promise.allSettled([
    sendTelegram(telegramMsg),
    sendEmail(emailSubject, emailBody, recipientEmail),
  ]);

  const telegramResult = results[0];
  const emailResult = results[1];

  if (telegramResult.status === 'rejected') {
    log.error('Telegram delivery failed', { error: errMsg(telegramResult.reason) });
  } else {
    log.info('Telegram summary delivered');
  }

  if (emailResult.status === 'rejected') {
    log.error('Email delivery failed', { error: errMsg(emailResult.reason) });
  } else {
    log.info('Email summary delivered', { to: recipientEmail });
  }

  const durationMs = Date.now() - startMs;
  const summary = `Weekly summary sent: ${inbox.length} inbox, ${sent.length} sent, ` +
    `${actionItems.length} action items detected, ` +
    `telegram=${telegramResult.status === 'fulfilled' ? 'ok' : 'failed'}, ` +
    `email=${emailResult.status === 'fulfilled' ? 'ok' : 'failed'}`;

  log.info('Weekly email summary complete', { durationMs });
  return summary;
}

// ── Registration ─────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('weekly-email-summary', async (ctx) => {
    return await run(ctx.config);
  });
}
