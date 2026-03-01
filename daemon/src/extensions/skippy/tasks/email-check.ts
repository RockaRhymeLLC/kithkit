/**
 * Email Check with Smart Triage + AI Sub-Agent
 *
 * Checks unread emails across all providers every 15 minutes:
 * 1. Rule-based triage auto-sorts obvious junk/newsletters/receipts (no API cost)
 * 2. Remaining emails (VIP + unknown) go to a Sonnet sub-agent for analysis
 * 3. Sub-agent reads the email body and recommends an action:
 *    - notify: Important, tell the owner (with context)
 *    - add_rule: Suggest a new triage rule for this sender
 *    - file: Move to a specific folder
 *    - ignore: Not worth bothering anyone about
 * 4. Recommendations are injected into the assistant's session for human-like follow-through
 *
 * The assistant decides what to relay to the owner and how to phrase it.
 * No more canned [Email] notifications — the assistant speaks naturally.
 *
 * Ported from CC4Me-BMO, adapted for KKit-BMO adapter interfaces.
 */

import { createLogger } from '../../../core/logger.js';
import { loadConfig } from '../../../core/config.js';
import { askClaude } from '../../../core/claude-api.js';
import { injectText, sessionExists } from '../../../core/session-bridge.js';
import type { Scheduler } from '../../../automation/scheduler.js';
import {
  getGraphAdapter,
  getJmapAdapter,
  getOutlookAdapter,
  getHimalayaAdapters,
} from '../../comms/index.js';
import type { BmoGraphAdapter } from '../../comms/adapters/email/graph-provider.js';
import type { BmoJmapAdapter } from '../../comms/adapters/email/jmap-provider.js';
import type { BmoOutlookAdapter } from '../../comms/adapters/email/outlook-provider.js';
import type { BmoHimalayaAdapter } from '../../comms/adapters/email/himalaya-provider.js';
import type { EmailMessage } from '../../comms/adapters/email/graph-provider.js';

const log = createLogger('email-check');

// ── Types ──

/** Union of all BMO email adapters. */
type EmailAdapter = BmoGraphAdapter | BmoJmapAdapter | BmoOutlookAdapter | BmoHimalayaAdapter;

interface TriageRules {
  vip: string[];
  junk: string[];
  newsletters: string[];
  receipts: string[];
  auto_read: string[];
}

interface EmailRecommendation {
  id: string;
  action: 'notify' | 'add_rule' | 'file' | 'ignore';
  urgency?: 'high' | 'normal';
  reason: string;
  ruleCategory?: 'junk' | 'newsletters' | 'receipts' | 'auto_read';
  rulePattern?: string;
  folder?: string;
}

// ── Triage Helpers ──

function loadTriageRules(): TriageRules {
  const appConfig = loadConfig();
  const raw = appConfig as unknown as Record<string, unknown>;
  const channels = raw.channels as Record<string, unknown> | undefined;
  const email = channels?.email as Record<string, unknown> | undefined;
  const triage = email?.triage as (TriageRules & { enabled?: boolean }) | undefined;
  return {
    vip: triage?.vip ?? [],
    junk: triage?.junk ?? [],
    newsletters: triage?.newsletters ?? [],
    receipts: triage?.receipts ?? [],
    auto_read: triage?.auto_read ?? [],
  };
}

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some(p => {
    if (p.includes('*') || p.includes('(') || p.includes('[')) {
      try {
        return new RegExp(p, 'i').test(lower);
      } catch {
        return lower.includes(p.toLowerCase());
      }
    }
    return lower.includes(p.toLowerCase());
  });
}

function triageEmail(
  msg: EmailMessage,
  config: TriageRules,
): 'vip' | 'junk' | 'newsletter' | 'receipt' | 'auto_read' | 'unknown' {
  const text = `${msg.from} ${msg.subject}`;

  if (matchesAny(text, config.vip)) return 'vip';
  if (matchesAny(text, config.junk)) return 'junk';
  if (matchesAny(text, config.newsletters)) return 'newsletter';
  if (matchesAny(text, config.receipts)) return 'receipt';
  if (matchesAny(text, config.auto_read)) return 'auto_read';

  return 'unknown';
}

/**
 * Move email to folder, falling back to mark-as-read if moveEmail isn't available.
 * Graph and JMAP adapters don't have moveEmail — only Himalaya and Outlook do.
 */
async function moveAndMark(adapter: EmailAdapter, id: string, folder: string): Promise<void> {
  try {
    if ('moveEmail' in adapter && typeof adapter.moveEmail === 'function') {
      await adapter.moveEmail(id, folder);
    } else {
      await adapter.markAsRead(id);
    }
  } catch (err) {
    log.warn(`Failed to move email ${id} to ${folder}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    try { await adapter.markAsRead(id); } catch (markErr) {
      log.warn(`Also failed to mark email ${id} as read`, {
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }
}

// ── Sub-Agent Analysis ──

async function analyzeWithSubAgent(
  emails: { id: string; from: string; subject: string; body: string; provider: string; isVip: boolean }[],
): Promise<EmailRecommendation[]> {
  if (emails.length === 0) return [];

  const emailList = emails.map((e, i) =>
    `--- EMAIL ${i + 1} (id: ${e.id}, provider: ${e.provider}${e.isVip ? ', VIP sender' : ''}) ---\nFrom: ${e.from}\nSubject: ${e.subject}\nBody (truncated):\n${e.body.slice(0, 2000)}\n`,
  ).join('\n');

  const response = await askClaude(emailList, {
    system: `You are an email triage sub-agent. Your job is to analyze emails and recommend what the assistant should do with each one.

For each email, recommend ONE action:

- "notify": The owner should know about this. Use for: personal messages, important account alerts, school/sports notifications, financial matters, anything time-sensitive or requiring action.
  - Set urgency "high" for: security alerts, payment issues, time-sensitive deadlines, messages from family/friends
  - Set urgency "normal" for: informational VIP emails, routine updates from important senders

- "add_rule": This sender should be added to a triage rule so similar emails are auto-sorted in the future. Use for: marketing, promotions, coupons, loyalty programs, social media notifications, app notifications.
  - Specify ruleCategory: "junk" (spam/promos), "newsletters" (regular content), "receipts" (order/shipping), "auto_read" (security alerts from known services)
  - Specify rulePattern: a simple lowercase pattern to match (e.g., "bestbuy", "doordash", "target.com")

- "file": Move to a specific folder without notifying. Use for: receipts that don't need attention, routine automated messages.
  - Specify folder: "Receipts", "Newsletters", or "Unsubscribe"

- "ignore": Mark as read, do nothing. Use for: emails that don't fit other categories but aren't worth acting on.

Respond with ONLY a JSON array (no markdown fences):
[{"id":"email_id","action":"notify|add_rule|file|ignore","urgency":"high|normal","reason":"brief reason","ruleCategory":"junk|newsletters|receipts|auto_read","rulePattern":"pattern","folder":"folder_name"}]`,
    maxTokens: 1024,
  });

  if (!response) {
    log.error('Sub-agent analysis failed — Claude API returned null');
    return [];
  }

  log.info(`Sub-agent analysis: ${response.inputTokens} in, ${response.outputTokens} out`);

  try {
    let jsonStr = response.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(jsonStr) as EmailRecommendation[];
  } catch (err) {
    log.error('Failed to parse sub-agent response', {
      error: err instanceof Error ? err.message : String(err),
      response: response.content.slice(0, 300),
    });
    return [];
  }
}

// ── Session Injection ──

function injectToSession(body: string): void {
  const message = `[email-triage] ${body}`;

  if (sessionExists()) {
    injectText(message);
    log.info('Recommendations injected into session');
  } else {
    log.info(`No session available. Recommendations:\n${body}`);
  }
}

// ── Main ──

async function run(): Promise<void> {
  const appConfig = loadConfig();
  const raw = appConfig as unknown as Record<string, unknown>;
  const channels = raw.channels as Record<string, unknown> | undefined;
  const email = channels?.email as Record<string, unknown> | undefined;
  const triageEnabled = (email?.triage as { enabled?: boolean } | undefined)?.enabled;

  if (!triageEnabled) {
    return legacyCheck();
  }

  const triageRules = loadTriageRules();

  // Collect all adapters with provider names
  const adapters: { name: string; adapter: EmailAdapter }[] = [];
  const graph = getGraphAdapter();
  if (graph) adapters.push({ name: 'graph', adapter: graph });
  const jmap = getJmapAdapter();
  if (jmap) adapters.push({ name: 'jmap', adapter: jmap });
  const outlook = getOutlookAdapter();
  if (outlook) adapters.push({ name: 'outlook', adapter: outlook });
  for (const h of getHimalayaAdapters()) {
    adapters.push({ name: h.name, adapter: h });
  }

  let junkCount = 0;
  let newsletterCount = 0;
  let receiptCount = 0;
  let autoReadCount = 0;
  const needsAnalysis: {
    id: string; from: string; subject: string; body: string;
    provider: string; isVip: boolean; adapter: EmailAdapter;
  }[] = [];

  for (const { name, adapter } of adapters) {
    let messages: EmailMessage[];
    try {
      messages = await adapter.listInbox(20, true);
    } catch (err) {
      log.warn(`${name} email check failed`, { error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const msg of messages) {
      const category = triageEmail(msg, triageRules);

      switch (category) {
        case 'junk':
          await moveAndMark(adapter, msg.id, 'Unsubscribe');
          junkCount++;
          break;
        case 'newsletter':
          await moveAndMark(adapter, msg.id, 'Newsletters');
          newsletterCount++;
          break;
        case 'receipt':
          await moveAndMark(adapter, msg.id, 'Receipts');
          receiptCount++;
          break;
        case 'auto_read':
          try { await adapter.markAsRead(msg.id); } catch { /* ignore */ }
          autoReadCount++;
          break;
        case 'vip':
        case 'unknown': {
          // Read the email body for sub-agent analysis
          let body = '';
          try {
            const full = await adapter.readEmail(msg.id);
            body = full?.body ?? '';
          } catch (err) {
            log.warn(`Failed to read email body for ${msg.id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // Mark as read regardless
          try { await adapter.markAsRead(msg.id); } catch { /* ignore */ }
          needsAnalysis.push({
            id: msg.id,
            from: msg.from,
            subject: msg.subject,
            body,
            provider: name,
            isVip: category === 'vip',
            adapter,
          });
          break;
        }
      }
    }
  }

  const sorted = junkCount + newsletterCount + receiptCount + autoReadCount;
  if (sorted > 0) {
    log.info(`Auto-sorted: ${sorted} (${junkCount} junk, ${newsletterCount} newsletters, ${receiptCount} receipts, ${autoReadCount} auto-read)`);
  }

  if (needsAnalysis.length === 0) {
    if (sorted > 0) {
      log.info('No emails need attention — all auto-sorted');
    } else {
      log.debug('No unread emails');
    }
    return;
  }

  // Pass remaining emails to sub-agent for analysis
  log.info(`Sending ${needsAnalysis.length} email(s) to sub-agent for analysis`);
  const recommendations = await analyzeWithSubAgent(needsAnalysis);

  if (recommendations.length === 0) {
    log.warn('Sub-agent returned no recommendations — falling back to raw list');
    const fallbackLines = needsAnalysis.map(e => `• ${e.from} — "${e.subject}" [${e.provider}]`);
    injectToSession(`Sub-agent analysis failed. ${needsAnalysis.length} email(s) need manual review:\n${fallbackLines.join('\n')}`);
    return;
  }

  // Act on recommendations
  const notifyItems: string[] = [];
  const ruleItems: string[] = [];
  const fileItems: string[] = [];
  let ignoredCount = 0;

  for (const rec of recommendations) {
    const email = needsAnalysis.find(e => e.id === rec.id);

    switch (rec.action) {
      case 'notify': {
        const urgencyTag = rec.urgency === 'high' ? ' [urgent]' : '';
        notifyItems.push(`• ${email?.from ?? 'unknown'} — "${email?.subject ?? '?'}"${urgencyTag} — ${rec.reason} [${email?.provider ?? '?'}]`);
        break;
      }
      case 'add_rule': {
        if (email) {
          const folder = rec.ruleCategory === 'junk' ? 'Unsubscribe'
            : rec.ruleCategory === 'newsletters' ? 'Newsletters'
            : rec.ruleCategory === 'receipts' ? 'Receipts'
            : null;
          if (folder) {
            await moveAndMark(email.adapter, email.id, folder);
          }
        }
        ruleItems.push(`• "${rec.rulePattern ?? email?.from}" → ${rec.ruleCategory ?? 'junk'} (${rec.reason})`);
        break;
      }
      case 'file': {
        if (email && rec.folder) {
          await moveAndMark(email.adapter, email.id, rec.folder);
        }
        fileItems.push(`• ${email?.from ?? 'unknown'} — "${email?.subject ?? '?'}" → ${rec.folder}`);
        break;
      }
      case 'ignore':
        ignoredCount++;
        break;
    }
  }

  // Build session injection message
  const parts: string[] = [];

  if (notifyItems.length > 0) {
    parts.push(`NOTIFY OWNER (${notifyItems.length}):\n${notifyItems.join('\n')}`);
  }
  if (ruleItems.length > 0) {
    parts.push(`ADD TRIAGE RULES (${ruleItems.length}):\n${ruleItems.join('\n')}`);
  }
  if (fileItems.length > 0) {
    parts.push(`FILED (${fileItems.length}):\n${fileItems.join('\n')}`);
  }
  if (ignoredCount > 0) {
    parts.push(`IGNORED: ${ignoredCount}`);
  }
  if (sorted > 0) {
    parts.push(`AUTO-SORTED: ${sorted} (${junkCount} junk, ${newsletterCount} newsletters, ${receiptCount} receipts, ${autoReadCount} auto-read)`);
  }

  if (parts.length > 0) {
    injectToSession(parts.join('\n\n'));
  }

  log.info(`Recommendations: ${notifyItems.length} notify, ${ruleItems.length} rules, ${fileItems.length} filed, ${ignoredCount} ignored`);
}

/** Legacy check for when triage is disabled — just counts unread. */
async function legacyCheck(): Promise<void> {
  const adapters: { name: string; adapter: EmailAdapter }[] = [];
  const graph = getGraphAdapter();
  if (graph) adapters.push({ name: 'graph', adapter: graph });
  const jmap = getJmapAdapter();
  if (jmap) adapters.push({ name: 'jmap', adapter: jmap });
  const outlook = getOutlookAdapter();
  if (outlook) adapters.push({ name: 'outlook', adapter: outlook });
  for (const h of getHimalayaAdapters()) {
    adapters.push({ name: h.name, adapter: h });
  }

  let totalUnread = 0;
  const details: string[] = [];

  for (const { name, adapter } of adapters) {
    try {
      const inbox = await adapter.listInbox(20, true);
      if (inbox.length > 0) {
        totalUnread += inbox.length;
        details.push(`${inbox.length} on ${name}`);
      }
    } catch (err) {
      log.warn(`${name} email check failed`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (totalUnread === 0) {
    log.debug('No unread emails');
    return;
  }

  const detailStr = details.join(', ');
  log.info(`${totalUnread} unread email(s) (${detailStr})`);

  if (sessionExists()) {
    injectText(`[email-triage] ${totalUnread} unread email(s) (${detailStr}). Check inbox when you get a chance.`);
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('email-check', async () => {
    await run();
  });
}
