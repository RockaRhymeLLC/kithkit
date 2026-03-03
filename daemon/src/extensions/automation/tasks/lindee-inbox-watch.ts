/**
 * Inbox Watch — AI-powered email guardian for a monitored mailbox.
 *
 * Runs every 15 minutes. For each new email:
 * 1. Reads the email body via Himalaya
 * 2. Sends to Sonnet for classification (spam, phishing, purchase, payment, legit)
 * 3. Moves spam/phishing to junk folder before it's seen
 * 4. Logs purchases to a ledger and checks for duplicates
 * 5. Alerts via Telegram for important items (payments, duplicates, high-cost)
 * 6. Writes a daily summary for the morning briefing
 *
 * Uses Himalaya CLI directly (not the email provider system) since this
 * account is managed separately from the agent's own mailboxes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../../core/logger.js';
import { askClaude } from '../../../core/claude-api.js';
import { getProjectDir } from '../../../core/config.js';
import type { Scheduler } from '../../../automation/scheduler.js';
import { sendMessage } from '../../../agents/message-router.js';

const log = createLogger('lindee-inbox-watch');
const execFileAsync = promisify(execFile);

const HIMALAYA_BIN = '/opt/homebrew/bin/himalaya';
const ACCOUNT = 'yahoo-lindee';

const STATE_DIR = join(getProjectDir(), '.claude', 'state');
const SEEN_FILE = join(STATE_DIR, 'lindee-inbox-last-check.json');
const LEDGER_FILE = join(STATE_DIR, 'lindee-purchase-ledger.json');
const DAILY_SUMMARY_FILE = join(STATE_DIR, 'lindee-daily-summary.json');

// ── Types ──

interface Envelope {
  id: string;
  flags: string[];
  subject: string;
  from: { name: string | null; addr: string };
  date: string;
}

interface SeenState {
  lastCheckedDate: string;
  lastSeenIds: string[];
}

interface PurchaseEntry {
  date: string;
  vendor: string;
  item: string;
  cost: string;
  orderId: string;
  emailId: string;
  emailSubject: string;
}

interface PurchaseLedger {
  purchases: PurchaseEntry[];
}

interface DailySummary {
  date: string;
  emailsProcessed: number;
  spamRemoved: number;
  phishingRemoved: number;
  purchases: PurchaseEntry[];
  paymentAlerts: string[];
  duplicateAlerts: string[];
  errors: number;
}

interface EmailAnalysis {
  category: 'spam' | 'phishing' | 'purchase' | 'payment_alert' | 'legit';
  confidence: number;
  reason: string;
  // Purchase-specific fields
  item?: string;
  cost?: string;
  vendor?: string;
  orderId?: string;
  // Payment-specific fields
  paymentDetail?: string;
}

// ── State helpers ──

function loadSeen(): SeenState {
  try { return JSON.parse(readFileSync(SEEN_FILE, 'utf-8')); }
  catch { return { lastCheckedDate: '', lastSeenIds: [] }; }
}

function saveSeen(state: SeenState): void {
  writeFileSync(SEEN_FILE, JSON.stringify(state, null, 2));
}

function loadLedger(): PurchaseLedger {
  try { return JSON.parse(readFileSync(LEDGER_FILE, 'utf-8')); }
  catch { return { purchases: [] }; }
}

function saveLedger(ledger: PurchaseLedger): void {
  // Keep last 90 days of purchases
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  ledger.purchases = ledger.purchases.filter(p => p.date >= cutoffStr);
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

function loadDailySummary(): DailySummary {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const summary = JSON.parse(readFileSync(DAILY_SUMMARY_FILE, 'utf-8'));
    if (summary.date === today) return summary;
  } catch { /* start fresh */ }
  return {
    date: today,
    emailsProcessed: 0,
    spamRemoved: 0,
    phishingRemoved: 0,
    purchases: [],
    paymentAlerts: [],
    duplicateAlerts: [],
    errors: 0,
  };
}

function saveDailySummary(summary: DailySummary): void {
  writeFileSync(DAILY_SUMMARY_FILE, JSON.stringify(summary, null, 2));
}

// ── Himalaya helpers ──

async function fetchRecentEmails(): Promise<Envelope[]> {
  try {
    const { stdout } = await execFileAsync(HIMALAYA_BIN, [
      '-o', 'json', 'envelope', 'list', '-a', ACCOUNT, '--page-size', '30',
    ], { encoding: 'utf8', timeout: 30000 });

    const cleaned = stdout.split('\n').filter(l => !l.includes(' WARN ')).join('\n').trim();
    if (!cleaned) return [];
    return JSON.parse(cleaned);
  } catch (err: any) {
    log.error('Failed to fetch Lindee inbox', { error: err.stderr || err.message });
    return [];
  }
}

async function readEmailBody(id: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(HIMALAYA_BIN, [
      'message', 'read', '-a', ACCOUNT, id,
    ], { encoding: 'utf8', timeout: 15000 });
    // Truncate to avoid sending huge HTML to the API
    return stdout.slice(0, 3000);
  } catch (err: any) {
    log.warn(`Failed to read email body ${id}`, { error: err.stderr || err.message });
    return '';
  }
}

async function moveToJunk(id: string): Promise<boolean> {
  try {
    await execFileAsync(HIMALAYA_BIN, [
      'message', 'move', '-a', ACCOUNT, 'Bulk', '--', id,
    ], { encoding: 'utf8', timeout: 15000 });
    log.info(`Moved email ${id} to Bulk`);
    return true;
  } catch (err: any) {
    log.warn(`Failed to move email ${id} to Bulk`, { error: err.stderr || err.message });
    return false;
  }
}

// ── AI Analysis ──

function buildAnalysisPrompt(emails: { id: string; subject: string; from: string; body: string }[], recentPurchases: PurchaseEntry[]): string {
  const recentPurchaseContext = recentPurchases.length > 0
    ? `\nRecent purchases (last 7 days) for duplicate detection:\n${recentPurchases.map(p => `- ${p.date}: ${p.vendor} — ${p.item} (${p.cost})`).join('\n')}\n`
    : '\nNo recent purchases on record.\n';

  const emailEntries = emails.map((e, i) =>
    `--- EMAIL ${i + 1} (id: ${e.id}) ---\nFrom: ${e.from}\nSubject: ${e.subject}\nBody (truncated):\n${e.body}\n`
  ).join('\n');

  return `Analyze these emails from an elderly person's inbox. For each email, classify it and extract details.

Categories:
- "spam": Unsolicited marketing, promotions, newsletters she didn't sign up for
- "phishing": Fake alerts, suspicious links, impersonation, scam attempts (err on the side of caution for elderly targets)
- "purchase": Order confirmations, shipping updates, delivery notices, receipts
- "payment_alert": Bills due, missed payments, overdue notices, account warnings
- "legit": Personal messages, appointments, legitimate notifications worth keeping

For purchases: extract item name, cost (with $), vendor, and order ID if available.
For payment alerts: summarize what's due and to whom.

Check purchases against the recent history for possible duplicates (same item ordered again within a few days).
${recentPurchaseContext}
${emailEntries}

Respond with ONLY a JSON array (no markdown fences). Each element:
{"id":"email_id","category":"spam|phishing|purchase|payment_alert|legit","confidence":0.0-1.0,"reason":"brief reason","item":"if purchase","cost":"if purchase","vendor":"if purchase","orderId":"if available","paymentDetail":"if payment_alert","isDuplicate":false,"duplicateOf":"if duplicate, describe what it duplicates"}`;
}

async function analyzeEmails(emails: { id: string; subject: string; from: string; body: string }[], recentPurchases: PurchaseEntry[]): Promise<Map<string, EmailAnalysis & { isDuplicate?: boolean; duplicateOf?: string }>> {
  const results = new Map<string, EmailAnalysis & { isDuplicate?: boolean; duplicateOf?: string }>();

  if (emails.length === 0) return results;

  const prompt = buildAnalysisPrompt(emails, recentPurchases);
  const response = await askClaude(prompt, {
    system: `You are an email security analyst protecting an elderly Yahoo Mail user from scams and helping track their finances. Be aggressive about flagging phishing — false positives are better than missed scams for this demographic.

KEY SCAM PATTERNS TO WATCH FOR:
- Tech support scams: fake Norton/McAfee/Geek Squad invoices ($249-$499), "virus detected", "subscription expired"
- Fake prize/lottery: "You have won", "congratulations", any prize requiring upfront payment
- Account compromise: "suspended", "verify your identity", "unauthorized access", "act now"
- Yahoo-specific: "upgrade your Yahoo Mail", "closing old versions", fake "Yahoo Admin Team" emails
- Government impersonation: fake SSA, Medicare, IRS emails (real SSA uses @ssa.gov only)
- Package delivery: fake USPS/FedEx/UPS "delivery failed" or "tracking update" with suspicious links
- Fake invoices: unsolicited renewal receipts with phone numbers to call
- Romance/charity: emotional manipulation, disaster relief exploitation

DOMAIN RED FLAGS: typosquatting (amaz0n, paypa1), combosquatting (netflix-payments.com), rn-for-m trick (rnicrosoft), free email domains claiming to be companies.

ELDERLY-SPECIFIC TACTICS: authority impersonation, health/Medicare bait, fear/urgency language, gift card payment requests, "keep this confidential" demands.

LEGITIMATE SENDERS (don't flag): Real SSA (@ssa.gov), real Medicare (@cms.hhs.gov, @medicare.gov), real banks use their actual domains (wellsfargo.com, chase.com), healthcare providers, utility companies.

OTP / VERIFICATION CODES (classify as "legit", NOT phishing): One-time passwords, verification codes, and sign-in confirmation emails from known services are routine security measures, not phishing. Legitimate OTP senders include: Hulu (messaging.hulu.com), Disney/Disney+ (noreply@disney.com, disneyplus.com), Netflix, Amazon, Apple, Google, Microsoft, Facebook/Meta, Instagram, PayPal, Venmo, Cash App, streaming services, and major retailers. If the sender domain is the real company domain and the email contains only a short numeric/alphanumeric code, classify as "legit".

Respond with only valid JSON.`,
    maxTokens: 2048,
  });

  if (!response) {
    log.error('Claude API call failed for email analysis');
    return results;
  }

  log.info(`Email analysis: ${response.inputTokens} in, ${response.outputTokens} out tokens`);

  try {
    // Parse JSON from response, handling potential markdown fences
    let jsonStr = response.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const analyses = JSON.parse(jsonStr) as (EmailAnalysis & { id?: string; isDuplicate?: boolean; duplicateOf?: string })[];
    for (const a of analyses) {
      if (a.id) results.set(a.id, a);
    }
  } catch (err) {
    log.error('Failed to parse email analysis response', {
      error: err instanceof Error ? err.message : String(err),
      response: response.content.slice(0, 200),
    });
  }

  return results;
}

// ── Main ──

async function run(): Promise<void> {
  // Ensure state directory exists
  mkdirSync(STATE_DIR, { recursive: true });

  const emails = await fetchRecentEmails();
  if (emails.length === 0) {
    log.info('No emails fetched from Lindee inbox');
    return;
  }

  const seen = loadSeen();
  const seenSet = new Set(seen.lastSeenIds);
  const newEmails = emails.filter(e => !seenSet.has(e.id));

  if (newEmails.length === 0) {
    log.debug('No new emails since last check');
    saveSeen({ lastCheckedDate: new Date().toISOString(), lastSeenIds: emails.map(e => e.id) });
    return;
  }

  log.info(`${newEmails.length} new email(s) to analyze`);

  // Read email bodies for new emails
  const emailsWithBodies: { id: string; subject: string; from: string; body: string }[] = [];
  for (const e of newEmails) {
    const body = await readEmailBody(e.id);
    emailsWithBodies.push({
      id: e.id,
      subject: e.subject,
      from: e.from.name ? `${e.from.name} <${e.from.addr}>` : e.from.addr,
      body,
    });
  }

  // Get recent purchases for duplicate detection
  const ledger = loadLedger();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentPurchases = ledger.purchases.filter(p => p.date >= sevenDaysAgo.toISOString().slice(0, 10));

  // Analyze with Sonnet
  const analyses = await analyzeEmails(emailsWithBodies, recentPurchases);
  const summary = loadDailySummary();
  summary.emailsProcessed += newEmails.length;

  const urgentAlerts: string[] = [];

  for (const email of newEmails) {
    const analysis = analyses.get(email.id);
    if (!analysis) {
      summary.errors++;
      continue;
    }

    const sender = email.from.name || email.from.addr;

    switch (analysis.category) {
      case 'spam':
        if (await moveToJunk(email.id)) {
          summary.spamRemoved++;
          log.info(`Spam removed: ${sender} — ${email.subject}`);
        }
        break;

      case 'phishing':
        if (await moveToJunk(email.id)) {
          summary.phishingRemoved++;
          log.warn(`Phishing removed: ${sender} — ${email.subject} (${analysis.reason})`);
        }
        // Always alert on phishing so the owner knows what's being targeted
        urgentAlerts.push(`🚨 Phishing blocked: "${email.subject}" from ${sender} — ${analysis.reason}`);
        break;

      case 'purchase': {
        // Skip if this email was already logged (prevents re-processing when
        // emails cycle in/out of the 30-message fetch window)
        if (ledger.purchases.some(p => p.emailId === email.id)) {
          log.debug(`Purchase already logged for email ${email.id}, skipping`);
          break;
        }
        const entry: PurchaseEntry = {
          date: new Date().toISOString().slice(0, 10),
          vendor: analysis.vendor || sender,
          item: analysis.item || email.subject,
          cost: analysis.cost || 'unknown',
          orderId: analysis.orderId || '',
          emailId: email.id,
          emailSubject: email.subject,
        };
        ledger.purchases.push(entry);
        summary.purchases.push(entry);

        if (analysis.isDuplicate) {
          const dupMsg = `⚠️ Possible duplicate purchase: ${entry.vendor} — ${entry.item} (${entry.cost}). ${analysis.duplicateOf || 'Similar item ordered recently.'}`;
          summary.duplicateAlerts.push(dupMsg);
          urgentAlerts.push(dupMsg);
        }

        // Flag high-cost purchases (>$100)
        const costNum = parseFloat((analysis.cost || '').replace(/[^0-9.]/g, ''));
        if (costNum > 100) {
          urgentAlerts.push(`💰 High-cost purchase: ${entry.vendor} — ${entry.item} (${entry.cost})`);
        }

        log.info(`Purchase logged: ${entry.vendor} — ${entry.item} (${entry.cost})`);
        break;
      }

      case 'payment_alert':
        summary.paymentAlerts.push(`${sender}: ${analysis.paymentDetail || email.subject}`);
        urgentAlerts.push(`⚠️ Payment alert: ${sender} — ${analysis.paymentDetail || email.subject}`);
        log.warn(`Payment alert: ${sender} — ${email.subject}`);
        break;

      case 'legit':
        log.debug(`Legit email, leaving alone: ${sender} — ${email.subject}`);
        break;
    }
  }

  // Save state
  saveSeen({ lastCheckedDate: new Date().toISOString(), lastSeenIds: emails.map(e => e.id) });
  saveLedger(ledger);
  saveDailySummary(summary);

  // Send urgent alerts to Telegram
  if (urgentAlerts.length > 0) {
    const message = `[Lindee's Email]\n${urgentAlerts.join('\n')}`;
    // Use message router instead of direct Telegram adapter
    try {
      sendMessage({ from: 'system', to: 'comms', type: 'text', body: message });
    } catch {
      log.warn('No Telegram adapter for Lindee alerts');
    }
  }

  const actionsTaken = summary.spamRemoved + summary.phishingRemoved;
  log.info(`Processed ${newEmails.length} emails: ${analyses.size} analyzed, ${actionsTaken} removed, ${summary.purchases.length} purchases logged today`);
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('lindee-inbox-watch', async () => {
    await run();
  });
}
