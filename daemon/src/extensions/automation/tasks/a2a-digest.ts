/**
 * A2A Weekly Digest — emails the user a summary of peer agent collaboration.
 *
 * Parses agent-comms.log for the past 7 days, computes stats from heartbeats,
 * formats text messages chronologically by day, and sends a polished HTML email.
 *
 * Runs every Monday at 9am (cron), requiresSession: false (just file read + email).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProjectDir, loadConfig } from '../../../core/config.js';
import { createLogger } from '../../../core/logger.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('a2a-digest');

// ── Types ────────────────────────────────────

interface LogEntry {
  ts: string;
  direction: 'in' | 'out' | 'heartbeat';
  from?: string;
  to?: string;
  type?: string;
  text?: string;
  peer?: string;
  reachable?: boolean;
  latencyMs?: number;
  myStatus?: string;
  peerStatus?: string;
  error?: string;
  messageId?: string;
}

interface DayBucket {
  date: string; // YYYY-MM-DD
  label: string; // "Monday, Feb 3"
  messages: LogEntry[];
}

interface HeartbeatStats {
  total: number;
  reachable: number;
  unreachable: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  uptimePercent: number;
}

interface DigestData {
  weekStart: string;
  weekEnd: string;
  totalMessages: number;
  sentCount: number;
  receivedCount: number;
  days: DayBucket[];
  heartbeat: HeartbeatStats;
  peers: string[];
}

// ── Log Parsing ──────────────────────────────

function parseLog(logPath: string, since: Date): LogEntry[] {
  if (!fs.existsSync(logPath)) {
    log.warn('agent-comms.log not found');
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const entries: LogEntry[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (new Date(entry.ts) >= since) {
        entries.push(entry);
      }
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

function bucketByDay(messages: LogEntry[]): DayBucket[] {
  const buckets = new Map<string, LogEntry[]>();

  for (const msg of messages) {
    const date = new Date(msg.ts);
    const key = date.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(msg);
  }

  // Sort by date
  const sorted = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));

  return sorted.map(([dateStr, msgs]) => {
    const d = new Date(dateStr + 'T12:00:00Z');
    return {
      date: dateStr,
      label: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
      messages: msgs.sort((a, b) => a.ts.localeCompare(b.ts)),
    };
  });
}

function computeHeartbeatStats(heartbeats: LogEntry[]): HeartbeatStats {
  if (heartbeats.length === 0) {
    return { total: 0, reachable: 0, unreachable: 0, avgLatencyMs: 0, maxLatencyMs: 0, uptimePercent: 0 };
  }

  const reachable = heartbeats.filter(h => h.reachable);
  const latencies = reachable.map(h => h.latencyMs ?? 0).filter(l => l > 0);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  return {
    total: heartbeats.length,
    reachable: reachable.length,
    unreachable: heartbeats.length - reachable.length,
    avgLatencyMs: avgLatency,
    maxLatencyMs: maxLatency,
    uptimePercent: Math.round((reachable.length / heartbeats.length) * 100),
  };
}

function buildDigest(entries: LogEntry[], since: Date, until: Date): DigestData {
  const heartbeats = entries.filter(e => e.direction === 'heartbeat');
  const textMessages = entries.filter(e => e.direction !== 'heartbeat' && e.type === 'text' && e.text);
  const sent = textMessages.filter(e => e.direction === 'out');
  const received = textMessages.filter(e => e.direction === 'in');

  // Collect unique peer names
  const peerSet = new Set<string>();
  for (const e of entries) {
    if (e.peer) peerSet.add(e.peer);
    if (e.from && e.direction === 'in') peerSet.add(e.from);
  }
  // Remove self
  const agentName = loadConfig().agent.name;
  peerSet.delete(agentName.toLowerCase());
  peerSet.delete(agentName);

  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return {
    weekStart: fmt(since),
    weekEnd: fmt(until),
    totalMessages: textMessages.length,
    sentCount: sent.length,
    receivedCount: received.length,
    days: bucketByDay(textMessages),
    heartbeat: computeHeartbeatStats(heartbeats),
    peers: [...peerSet],
  };
}

// ── HTML Generation ──────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\\n/g, '<br>')
    .replace(/\\!/g, '!')
    .replace(/\n/g, '<br>');
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

function senderLabel(entry: LogEntry): string {
  if (entry.direction === 'out') return loadConfig().agent.name;
  return entry.from ?? 'Unknown';
}

function senderColor(entry: LogEntry): string {
  return entry.direction === 'out' ? '#0077CC' : '#8B5CF6';
}

function renderMessage(entry: LogEntry): string {
  const time = formatTime(entry.ts);
  const sender = senderLabel(entry);
  const color = senderColor(entry);
  const text = escapeHtml(entry.text ?? '');

  // Truncate very long messages for the digest
  const maxLen = 500;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + '&hellip;' : text;

  return `
    <tr>
      <td style="padding:8px 12px;vertical-align:top;width:70px;color:#999999;font-size:12px;font-family:Arial,Helvetica,sans-serif;">${time}</td>
      <td style="padding:8px 12px;font-family:Arial,Helvetica,sans-serif;">
        <span style="font-weight:bold;color:${color};font-size:13px;">${sender}</span>
        <div style="color:#333333;font-size:14px;line-height:1.5;margin-top:2px;">${truncated}</div>
      </td>
    </tr>`;
}

function renderDaySection(day: DayBucket): string {
  const rows = day.messages.map(renderMessage).join('');
  return `
    <tr>
      <td style="padding:20px 24px 8px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#222222;padding-bottom:8px;border-bottom:2px solid #E5E5E5;">
              ${day.label}
              <span style="font-weight:normal;color:#999999;font-size:12px;margin-left:8px;">${day.messages.length} message${day.messages.length !== 1 ? 's' : ''}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${rows}
        </table>
      </td>
    </tr>`;
}

function renderStatsBox(digest: DigestData): string {
  const hb = digest.heartbeat;
  const uptimeColor = hb.uptimePercent >= 95 ? '#22C55E' : hb.uptimePercent >= 80 ? '#F59E0B' : '#EF4444';

  return `
    <tr>
      <td style="padding:20px 24px 0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8F9FA;border-radius:8px;">
          <tr>
            <td style="padding:16px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#222222;padding-bottom:12px;">
                    Week at a Glance
                  </td>
                </tr>
                <tr>
                  <td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="25%" style="text-align:center;padding:8px;">
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:bold;color:#0077CC;">${digest.totalMessages}</div>
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666666;margin-top:2px;">Messages</div>
                        </td>
                        <td width="25%" style="text-align:center;padding:8px;">
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:bold;color:${uptimeColor};">${hb.uptimePercent}%</div>
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666666;margin-top:2px;">Uptime</div>
                        </td>
                        <td width="25%" style="text-align:center;padding:8px;">
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:bold;color:#333333;">${hb.avgLatencyMs}<span style="font-size:14px;">ms</span></div>
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666666;margin-top:2px;">Avg Latency</div>
                        </td>
                        <td width="25%" style="text-align:center;padding:8px;">
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:bold;color:#333333;">${hb.total}</div>
                          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666666;margin-top:2px;">Heartbeats</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${hb.unreachable > 0 ? `
                <tr>
                  <td style="padding-top:8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#EF4444;">
                    ${hb.unreachable} failed heartbeat${hb.unreachable !== 1 ? 's' : ''} this week (max latency: ${hb.maxLatencyMs}ms)
                  </td>
                </tr>` : ''}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function generateHtml(digest: DigestData, agentName: string): string {
  const preheader = `${agentName} & ${digest.peers.join(', ')} — ${digest.totalMessages} messages, ${digest.heartbeat.uptimePercent}% uptime`;

  const daySections = digest.days.length > 0
    ? digest.days.map(renderDaySection).join('')
    : `<tr><td style="padding:24px;text-align:center;font-family:Arial,Helvetica,sans-serif;color:#999999;font-style:italic;">Quiet week — no messages exchanged.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>A2A Weekly Digest</title>
</head>
<body style="margin:0;padding:0;background:#F4F4F4;">
<!-- Preheader -->
<div style="display:none;font-size:1px;color:#F4F4F4;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
  ${preheader}${'&nbsp;&zwnj;'.repeat(20)}
</div>
<!-- Wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4F4F4;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <!-- Container -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border-radius:8px;max-width:600px;width:100%;">
        <!-- Header -->
        <tr>
          <td style="padding:28px 24px 16px 24px;border-bottom:3px solid #0077CC;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#222222;">
                  A2A Weekly Digest
                </td>
                <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#999999;">
                  ${digest.weekStart} — ${digest.weekEnd}
                </td>
              </tr>
              <tr>
                <td colspan="2" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#666666;padding-top:4px;">
                  ${agentName} &harr; ${digest.peers.join(', ')} &middot; ${digest.sentCount} sent &middot; ${digest.receivedCount} received
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Stats -->
        ${renderStatsBox(digest)}
        <!-- Conversations -->
        <tr>
          <td style="padding:24px 24px 8px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#222222;">
                  Conversations
                </td>
              </tr>
            </table>
          </td>
        </tr>
        ${daySections}
        <!-- Footer -->
        <tr>
          <td style="padding:24px;border-top:1px solid #E5E5E5;margin-top:16px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#999999;text-align:center;">
                  Automated digest from ${agentName}'s A2A comms &middot; Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ── Email Sending ────────────────────────────

function sendEmail(to: string, subject: string, html: string): void {
  const graphScript = path.join(getProjectDir(), 'scripts/email/graph.js');
  try {
    execFileSync('node', [graphScript, 'send', to, subject, html, '--html'], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: getProjectDir(),
    });
    log.info(`Digest email sent to ${to}`);
  } catch (err) {
    log.error('Failed to send digest email', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Main ─────────────────────────────────────

async function run(): Promise<void> {
  const config = loadConfig();
  const agentName = config.agent.name;

  // Look up recipient from task config, fallback to first safe sender email
  const task = config.scheduler.tasks.find(t => t.name === 'a2a-digest');
  let recipient = task?.config?.recipient as string | undefined;

  if (!recipient) {
    // Fall back to safe-senders email list
    const safeSendersPath = path.join(getProjectDir(), '.claude/state/safe-senders.json');
    try {
      const ss = JSON.parse(fs.readFileSync(safeSendersPath, 'utf8'));
      recipient = ss.email?.addresses?.[0];
    } catch { /* ignore */ }
  }

  if (!recipient) {
    log.error('No recipient configured for A2A digest');
    return;
  }

  const logPath = path.join(getProjectDir(), 'logs/agent-comms.log');
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  log.info('Building weekly A2A digest', { since: sevenDaysAgo.toISOString(), recipient });

  const entries = parseLog(logPath, sevenDaysAgo);

  if (entries.length === 0) {
    log.info('No A2A activity in the past week, skipping digest');
    return;
  }

  const digest = buildDigest(entries, sevenDaysAgo, now);
  const subject = `A2A Digest: ${digest.weekStart} — ${digest.weekEnd} (${digest.totalMessages} messages)`;
  const html = generateHtml(digest, agentName);

  sendEmail(recipient, subject, html);
  log.info('Weekly A2A digest sent', {
    messages: digest.totalMessages,
    heartbeats: digest.heartbeat.total,
    uptimePercent: digest.heartbeat.uptimePercent,
  });
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('a2a-digest', async () => {
    await run();
  });
}
