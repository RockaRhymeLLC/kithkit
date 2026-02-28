/**
 * A2A Message Cleanup — weekly archive and purge of inter-agent messages.
 *
 * Finds messages older than 7 days involving known peer agents (skippy, r2d2, marvbot),
 * emails a readable report to daveh@outlook.com via Microsoft Graph API, then
 * deletes those rows from the database.
 *
 * Scheduled weekly (Sunday 6am) via kithkit.config.yaml.
 */

import { query, exec } from '../../core/db.js';
import { readKeychain } from '../../core/keychain.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('a2a-message-cleanup');

const PEER_AGENTS = ['skippy', 'r2d2', 'marvbot'] as const;
const SENDER_EMAIL = 'bmo@bmobot.ai';
const RECIPIENT_EMAIL = 'daveh@outlook.com';
const DAYS_TO_KEEP = 7;

interface MessageRow {
  id: number;
  from_agent: string;
  to_agent: string;
  type: string | null;
  body: string;
  metadata: string | null;
  processed_at: string | null;
  created_at: string | null;
  read_at: string | null;
}

interface GroupedByDate {
  [date: string]: MessageRow[];
}

/**
 * Format a list of messages into a human-readable report string.
 */
function formatReport(messages: MessageRow[]): string {
  if (messages.length === 0) {
    return 'No A2A messages found older than 7 days. Nothing to archive.';
  }

  const lines: string[] = [];

  lines.push('A2A Message Archive Report');
  lines.push('==========================');
  lines.push(`Total messages archived: ${messages.length}`);
  lines.push(`Agents covered: ${PEER_AGENTS.join(', ')}`);
  lines.push(`Cutoff: messages older than ${DAYS_TO_KEEP} days`);
  lines.push('');

  // Group by date (YYYY-MM-DD from created_at)
  const grouped: GroupedByDate = {};
  for (const msg of messages) {
    const dateKey = msg.created_at
      ? msg.created_at.slice(0, 10)
      : 'unknown-date';
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push(msg);
  }

  // Sort dates descending (most recent archived first)
  const sortedDates = Object.keys(grouped).sort().reverse();

  for (const date of sortedDates) {
    const dayMessages = grouped[date]!;
    lines.push(`--- ${date} (${dayMessages.length} message${dayMessages.length === 1 ? '' : 's'}) ---`);
    lines.push('');

    for (const msg of dayMessages) {
      const type = msg.type ?? 'text';
      const truncatedBody =
        msg.body.length > 200 ? msg.body.slice(0, 200) + '...' : msg.body;
      const timestamp = msg.created_at ?? 'unknown time';

      lines.push(`  [${timestamp}] ${msg.from_agent} → ${msg.to_agent} (${type})`);
      lines.push(`  ${truncatedBody}`);
      if (msg.processed_at) {
        lines.push(`  Processed: ${msg.processed_at}`);
      }
      lines.push('');
    }
  }

  lines.push('==========================');
  lines.push('Messages have been deleted from the database after this report.');

  return lines.join('\n');
}

/**
 * Send the archive report email via Microsoft Graph API.
 */
async function sendReportEmail(reportText: string, count: number): Promise<void> {
  const [tenantId, clientId, clientSecret] = await Promise.all([
    readKeychain('credential-azure-tenant-id'),
    readKeychain('credential-azure-client-id'),
    readKeychain('credential-azure-secret-value'),
  ]);

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Missing Azure credentials in Keychain — cannot send report email');
  }

  // Acquire OAuth token
  const tokenResp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(clientId)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    },
  );

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    throw new Error(`Failed to acquire Graph API token: ${tokenResp.status} ${body}`);
  }

  const tokenData = (await tokenResp.json()) as { access_token: string };

  // Send the email
  const subject =
    count > 0
      ? `A2A Message Archive Report — ${count} message${count === 1 ? '' : 's'} archived`
      : 'A2A Message Archive Report — Nothing to archive';

  const mailResp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_EMAIL)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: reportText },
          toRecipients: [{ emailAddress: { address: RECIPIENT_EMAIL } }],
        },
      }),
    },
  );

  if (!mailResp.ok) {
    const body = await mailResp.text();
    throw new Error(`Failed to send report email: ${mailResp.status} ${body}`);
  }
}

/**
 * Main task logic: query, report, email, delete.
 */
async function run(): Promise<void> {
  log.info('A2A message cleanup starting');

  // Build the cutoff timestamp (SQLite datetime string, 7 days ago)
  const cutoff = new Date(Date.now() - DAYS_TO_KEEP * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const agentList = PEER_AGENTS.map(() => '?').join(', ');

  const messages = query<MessageRow>(
    `SELECT * FROM messages
     WHERE created_at < ?
       AND (from_agent IN (${agentList}) OR to_agent IN (${agentList}))
     ORDER BY created_at ASC`,
    cutoff,
    ...PEER_AGENTS,
    ...PEER_AGENTS,
  );

  log.info(`Found ${messages.length} messages older than ${DAYS_TO_KEEP} days to archive`);

  const reportText = formatReport(messages);

  // Always send the email — even if empty, so Dave knows the task ran
  try {
    await sendReportEmail(reportText, messages.length);
    log.info('Archive report emailed successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Failed to send archive report email', { error: msg });
    // Do not delete messages if we couldn't email the report
    return;
  }

  // Delete the archived messages
  if (messages.length > 0) {
    const ids = messages.map(m => m.id);
    const placeholders = ids.map(() => '?').join(', ');
    const result = exec(
      `DELETE FROM messages WHERE id IN (${placeholders})`,
      ...ids,
    );
    log.info(`Deleted ${result.changes} messages from database`);
  }

  log.info('A2A message cleanup complete');
}

/**
 * Register the a2a-message-cleanup task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('a2a-message-cleanup', async () => {
    await run();
  });
}
