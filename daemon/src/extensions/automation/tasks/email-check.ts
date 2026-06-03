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
 * Adapters are instantiated directly — the old comms/index.js getters
 * (getGraphAdapter, getJmapAdapter, etc.) were removed in PR #136.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../core/logger.js';
import { loadConfig, getProjectDir } from '../../../core/config.js';
import { askClaude } from '../../../core/claude-api.js';
import { injectText, sessionExists } from '../../../core/session-bridge.js';
import type { Scheduler } from '../../../automation/scheduler.js';
import { GraphAdapter as BmoGraphAdapter, type EmailMessage } from '../../comms/adapters/email/graph-provider.js';
import { JmapAdapter as BmoJmapAdapter } from '../../comms/adapters/email/jmap-provider.js';
import { HimalayaAdapter as BmoHimalayaAdapter } from '../../comms/adapters/email/himalaya-provider.js';
import { OutlookAdapter as BmoOutlookAdapter } from '../../comms/adapters/email/outlook-provider.js';

const log = createLogger('email-check');

// ── Triage Seen Cache ─────────────────────────────────────────

/** 60-day rolling window for seen-state pruning. */
const TRIAGE_SEEN_TTL_DAYS = 60;
/** Fallback count cap (safety net, normally pruned by age first). */
const TRIAGE_SEEN_MAX = 500;

/** Structured entry stored in the seen-state file. */
interface TriageSeenEntry {
  id: string;
  seenAt: string; // ISO 8601
}

function getTriageSeenPath(accountName: string): string {
  const stateDir = path.join(getProjectDir(), '.kithkit', 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, `email-triage-seen-${accountName}.json`);
}

/**
 * Load triaged IDs for a shared account.
 *
 * Backward-compatible: reads both the legacy bare-string-array format
 * (written before this fix) and the new {id, seenAt} object format.
 * Returns a Map<id, seenAt> so the caller can both check membership and
 * persist timestamps.
 */
function loadTriagedEntries(accountName: string): Map<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(getTriageSeenPath(accountName), 'utf8')) as unknown;
    const map = new Map<string, string>();
    if (!Array.isArray(data)) return map;
    const cutoff = Date.now() - TRIAGE_SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of data as unknown[]) {
      if (typeof entry === 'string') {
        // Legacy format — no timestamp, treat as "seen now" so it stays for 60 days
        map.set(entry, new Date().toISOString());
      } else if (entry && typeof entry === 'object' && 'id' in entry && 'seenAt' in entry) {
        const e = entry as TriageSeenEntry;
        // Only include entries within the 60-day window
        const age = new Date(e.seenAt).getTime();
        if (!isNaN(age) && age >= cutoff) {
          map.set(e.id, e.seenAt);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/** Thin wrapper for callers that only need Set membership. */
function loadTriagedIds(accountName: string): Set<string> {
  return new Set(loadTriagedEntries(accountName).keys());
}

function saveTriagedIds(accountName: string, ids: Set<string>): void {
  // Load existing entries with timestamps so we preserve seenAt for old entries
  const existing = loadTriagedEntries(accountName);
  const now = new Date().toISOString();

  // Merge: new IDs get current timestamp; existing keep theirs
  const merged = new Map<string, string>(existing);
  for (const id of ids) {
    if (!merged.has(id)) merged.set(id, now);
  }

  // Prune: 60-day window first, then cap at TRIAGE_SEEN_MAX for safety
  const cutoff = Date.now() - TRIAGE_SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  let entries: TriageSeenEntry[] = [];
  for (const [id, seenAt] of merged) {
    const age = new Date(seenAt).getTime();
    if (!isNaN(age) && age >= cutoff) {
      entries.push({ id, seenAt });
    }
  }
  // Sort by seenAt ascending; trim to cap if somehow still over limit
  entries.sort((a, b) => a.seenAt.localeCompare(b.seenAt));
  if (entries.length > TRIAGE_SEEN_MAX) {
    entries = entries.slice(entries.length - TRIAGE_SEEN_MAX);
  }

  try {
    fs.writeFileSync(getTriageSeenPath(accountName), JSON.stringify(entries));
  } catch (err) {
    log.warn(`Failed to save triaged IDs for ${accountName}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Types ────────────────────────────────────────────────────

interface TriageRules {
  vip: string[];
  junk: string[];
  newsletters: string[];
  receipts: string[];
  auto_read: string[];
}

interface AdapterEntry {
  name: string;
  shared: boolean;
  adapter: {
    listInbox(limit: number, unreadOnly: boolean): Promise<EmailMessage[]>;
    readEmail?(id: string): Promise<EmailMessage | null>;
    markAsRead(id: string): Promise<void>;
    markAsUnread?(id: string): Promise<void>;
    moveEmail?(id: string, folder: string): Promise<void>;
  };
}

interface EmailForAnalysis {
  id: string;
  from: string;
  subject: string;
  body: string;
  provider: string;
  isVip: boolean;
  shared: boolean;
  adapter: AdapterEntry['adapter'];
}

interface SubAgentRecommendation {
  id: string;
  action: 'notify' | 'add_rule' | 'file' | 'ignore';
  urgency?: 'high' | 'normal';
  reason?: string;
  ruleCategory?: 'junk' | 'newsletters' | 'receipts' | 'auto_read';
  rulePattern?: string;
  folder?: string;
}

// ── Triage Helpers ────────────────────────────────────────────

function loadTriageRules(): TriageRules {
  const appConfig = loadConfig();
  const raw = appConfig as unknown as Record<string, unknown>;
  const channels = raw.channels as Record<string, unknown> | undefined;
  const email = channels?.email as Record<string, unknown> | undefined;
  const triage = email?.triage as Record<string, unknown> | undefined;
  return {
    vip: (triage?.vip as string[]) ?? [],
    junk: (triage?.junk as string[]) ?? [],
    newsletters: (triage?.newsletters as string[]) ?? [],
    receipts: (triage?.receipts as string[]) ?? [],
    auto_read: (triage?.auto_read as string[]) ?? [],
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

export type TriageCategory = 'vip' | 'junk' | 'newsletter' | 'receipt' | 'auto_read' | 'unknown';

/**
 * Classify an email into a triage category.
 *
 * Precedence rules (fixes issue #640/#1786/#1762):
 *   1. Sender-scoped suppression first — if the SENDER (msg.from) explicitly
 *      matches auto_read, junk, or newsletters, return that category immediately.
 *      This prevents a VIP keyword in the subject from promoting a known service
 *      account (e.g. internal@service-now.com) to 'vip'.
 *   2. VIP/keyword promotion — only applied when no explicit sender suppression
 *      matched. Checks the combined from+subject string so VIP keywords in either
 *      field are honoured for genuine VIP senders.
 */
export function triageEmail(msg: EmailMessage, config: TriageRules): TriageCategory {
  const sender = msg.from;
  const text = `${msg.from} ${msg.subject}`;

  // Sender-scoped suppression rules take precedence over keyword/VIP promotion.
  // A service-account sender explicitly listed in auto_read/junk/newsletters is
  // never promoted to VIP even when the subject contains a VIP keyword.
  if (matchesAny(sender, config.auto_read)) return 'auto_read';
  if (matchesAny(sender, config.junk)) return 'junk';
  if (matchesAny(sender, config.newsletters)) return 'newsletter';

  // VIP / keyword promotion — only when no explicit sender suppression matched.
  if (matchesAny(text, config.vip)) return 'vip';
  if (matchesAny(text, config.junk)) return 'junk';
  if (matchesAny(text, config.newsletters)) return 'newsletter';
  if (matchesAny(text, config.receipts)) return 'receipt';
  if (matchesAny(text, config.auto_read)) return 'auto_read';
  return 'unknown';
}

/**
 * Move email to folder, falling back to mark-as-read if moveEmail isn't available.
 */
async function moveAndMark(adapter: AdapterEntry['adapter'], id: string, folder: string): Promise<void> {
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
    try {
      await adapter.markAsRead(id);
    } catch (markErr) {
      log.warn(`Also failed to mark email ${id} as read`, {
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }
}

// ── Memory Dedup Check ─────────────────────────────────────────

type MemoryDedupResult = 'exact' | 'broader_covers' | 'narrower_conflict' | 'ok';

/** Stat counters for the dedup check (reset per run). */
const dedupStats = { seen: 0, emitted: 0, nlFallback: 0 };

/**
 * Append a line to the dedup decision log for post-hoc debugging.
 * Log is gitignored (logs/*.log) and capped informally by log rotation.
 */
function logDedupDecision(
  account: string,
  pattern: string,
  category: string,
  decision: MemoryDedupResult | 'ok_config_dup',
  reason: string,
): void {
  try {
    const logDir = path.join(getProjectDir(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      account,
      pattern,
      category,
      decision,
      reason,
    }) + '\n';
    fs.appendFileSync(path.join(logDir, 'email-triage-dedup.log'), line);
  } catch {
    // Non-fatal — don't let logging failures break triage
  }
}

/** Extract (storedPattern, category) pairs from a memory content string.
 *
 *  Handles two formats:
 *  1. Structured: "some.pattern → category"  (Unicode right-arrow U+2192)
 *  2. Natural language fallback: if no arrows found, returns an empty array
 *     and the caller's NL heuristic takes over.
 */
function extractRulePairs(content: string): Array<{ stored: string; cat: string }> {
  const results: Array<{ stored: string; cat: string }> = [];
  // Unicode right arrow U+2192; 'i' flag so category case is folded
  const re = /([a-z0-9@._-]+)\s*\u2192\s*([a-z_]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    results.push({ stored: m[1].toLowerCase(), cat: m[2].toLowerCase() });
  }
  return results;
}

/**
 * Natural-language category keywords.
 * Used when a memory has no → arrows to check if it describes a routing rule.
 */
const NL_CATEGORY_KEYWORDS: Record<string, string[]> = {
  junk: ['junk', 'spam', 'unsubscribe', 'marketing', 'promotional'],
  newsletters: ['newsletter', 'mailing list', 'subscription'],
  receipts: ['receipt', 'order', 'purchase', 'transaction', 'confirmation'],
  auto_read: ['auto-read', 'auto read', 'mark as read', 'mark.*read'],
};

/** TLDs to exclude when tokenising a pattern for NL content matching. */
const STOP_TLDS = new Set(['com', 'org', 'net', 'edu', 'gov', 'co', 'io', 'us', 'uk', 'ca']);

async function fetchMemoriesByQuery(query: string): Promise<Array<{ content: string; category: string }>> {
  try {
    const res = await fetch('http://localhost:3847/api/memory/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Use hybrid mode for broader semantic matching (keyword-only missed NL-phrased memories)
      body: JSON.stringify({ query, mode: 'hybrid', limit: 15 }),
    });
    if (!res.ok) return [];
    const json = await res.json() as { data?: Array<{ content: string; category: string }> };
    return (json.data ?? []).filter(m =>
      ['procedural', 'preference', 'reference'].includes(m.category),
    );
  } catch {
    return [];
  }
}

/**
 * Check whether a proposed triage rule is already covered by a memory-stored rule.
 *
 * Returns:
 *  - 'exact'            — identical pattern+category already in memory → skip
 *  - 'broader_covers'   — a stored pattern is a suffix of the proposed pattern → skip
 *                         (e.g. stored "mystore.cvs.com", proposed "photo@mystore.cvs.com")
 *                         Also fires for NL memories that describe the same sender+category.
 *  - 'narrower_conflict'— proposed and stored share the same domain root → warn but emit
 *                         (e.g. proposed "foo@bar.com", stored "baz@bar.com")
 *  - 'ok'               — no matching memory rule found → emit normally
 *
 * Fails open: any fetch/parse error returns 'ok' so the proposal is not silently dropped.
 *
 * ROOT-CAUSE FIX (todo #514):
 *  The original classify() only called extractRulePairs() which only matched memories
 *  containing the Unicode → arrow. Natural-language memories like "Shutterfly emails
 *  are configured to route to junk/spam folder" were found by the search but never
 *  matched, so the rule was re-proposed. The NL fallback below catches these cases.
 */
async function checkMemoryDedup(pattern: string, category: string, account = 'unknown'): Promise<MemoryDedupResult> {
  const patternLower = pattern.toLowerCase();
  const categoryLower = category.toLowerCase();

  // Tokenise the pattern for NL matching: split on @ and . → keep meaningful tokens
  const patternTokens = patternLower
    .split(/[@.]/)
    .map(t => t.trim())
    .filter(t => t.length > 2 && !STOP_TLDS.has(t));

  const classify = (memories: Array<{ content: string; category: string }>): MemoryDedupResult => {
    for (const mem of memories) {
      const pairs = extractRulePairs(mem.content);

      if (pairs.length > 0) {
        // ── Structured path (→ arrows present) ────────────────
        for (const { stored, cat } of pairs) {
          if (cat !== categoryLower) continue;

          // Case 1: exact match
          if (stored === patternLower) return 'exact';

          // Case 2: proposed ends with stored → stored (broader) subsumes proposed
          //   e.g. proposed "photo@mystore.cvs.com", stored "mystore.cvs.com"
          if (patternLower.endsWith(stored)) return 'broader_covers';

          // Case 3: same domain root → narrower conflict; warn but let comms decide
          const proposedDomain = patternLower.includes('@') ? patternLower.split('@')[1] : patternLower;
          const storedDomain = stored.includes('@') ? stored.split('@')[1] : stored;
          if (
            proposedDomain && storedDomain && (
              proposedDomain === storedDomain ||
              storedDomain.endsWith('.' + proposedDomain) ||
              proposedDomain.endsWith('.' + storedDomain)
            )
          ) {
            return 'narrower_conflict';
          }
        }
      } else if (
        mem.category === 'procedural' ||
        mem.category === 'preference' ||
        mem.category === 'reference'
      ) {
        // ── NL fallback (no → arrows in memory) ───────────────
        // Original bug: extractRulePairs() returned [] for NL memories so classify()
        // always returned 'ok', causing re-proposals for already-covered rules.
        //
        // Fix: if the memory content mentions a meaningful token from the proposed
        // pattern AND contains a category-related keyword, treat as broader_covers.
        const contentLower = mem.content.toLowerCase();
        const patternInContent = patternTokens.some(t => contentLower.includes(t));
        const categoryKeywords = NL_CATEGORY_KEYWORDS[categoryLower] ?? [];
        const categoryInContent = categoryKeywords.some(kw => contentLower.includes(kw));

        if (patternInContent && categoryInContent) {
          dedupStats.nlFallback++;
          return 'broader_covers';
        }
      }
    }
    return 'ok';
  };

  // Search 1: full pattern string
  const exactResults = await fetchMemoriesByQuery(pattern);
  const res1 = classify(exactResults);
  if (res1 !== 'ok') {
    logDedupDecision(account, pattern, category, res1, `search1:pattern matched ${res1}`);
    dedupStats.seen++;
    return res1;
  }

  // Search 2: domain-only (catches broader stored rules that share a domain with proposed pattern)
  const proposedDomain = patternLower.includes('@') ? patternLower.split('@')[1] : null;
  if (proposedDomain) {
    const domainResults = await fetchMemoriesByQuery(proposedDomain);
    // Deduplicate against results from search 1 to avoid double-processing
    const newResults = domainResults.filter(d => !exactResults.some(e => e.content === d.content));
    const res2 = classify(newResults);
    if (res2 !== 'ok') {
      logDedupDecision(account, pattern, category, res2, `search2:domain matched ${res2}`);
      dedupStats.seen++;
      return res2;
    }
  }

  logDedupDecision(account, pattern, category, 'ok', 'no matching memory found');
  dedupStats.emitted++;
  return 'ok';
}

// ── Sub-Agent Analysis ────────────────────────────────────────

async function analyzeWithSubAgent(emails: EmailForAnalysis[]): Promise<SubAgentRecommendation[]> {
  if (emails.length === 0) return [];

  const emailList = emails.map((e, i) =>
    `--- EMAIL ${i + 1} (id: ${e.id}, provider: ${e.provider}${e.isVip ? ', VIP sender' : ''}) ---\n` +
    `From: ${e.from}\nSubject: ${e.subject}\nBody (truncated):\n${e.body.slice(0, 2000)}\n`,
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

Respond with ONLY a JSON array (no markdown fences). Keep each "reason" to under 10 words to save space:
[{"id":"email_id","action":"notify|add_rule|file|ignore","urgency":"high|normal","reason":"brief reason","ruleCategory":"junk|newsletters|receipts|auto_read","rulePattern":"pattern","folder":"folder_name"}]`,
    maxTokens: 4096,
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

    // Detect truncation — JSON array must end with ]
    if (!jsonStr.endsWith(']')) {
      log.warn('Sub-agent response appears truncated (no closing ]). Attempting repair...');
      // Try to salvage: find the last complete object and close the array
      const lastBrace = jsonStr.lastIndexOf('}');
      if (lastBrace > 0) {
        jsonStr = jsonStr.slice(0, lastBrace + 1) + ']';
      } else {
        log.error('Cannot repair truncated response');
        return [];
      }
    }

    return JSON.parse(jsonStr) as SubAgentRecommendation[];
  } catch (err) {
    log.error('Failed to parse sub-agent response', {
      error: err instanceof Error ? err.message : String(err),
      response: response.content.slice(0, 300),
    });
    return [];
  }
}

// ── Session Injection ─────────────────────────────────────────

function injectToSession(body: string): void {
  const message = `[email-triage] ${body}`;
  if (sessionExists()) {
    injectText(message);
    log.info('Recommendations injected into session');
  } else {
    log.info(`No session available. Recommendations:\n${body}`);
  }
}

// ── Adapter Setup ─────────────────────────────────────────────

/**
 * Build the list of configured email adapters from the kithkit config.
 * Only adapters that are available/configured are included.
 */
async function buildAdapters(): Promise<AdapterEntry[]> {
  const appConfig = loadConfig();
  const raw = appConfig as unknown as Record<string, unknown>;
  const channels = raw.channels as Record<string, unknown> | undefined;
  const email = channels?.email as Record<string, unknown> | undefined;
  const providers = (email?.providers as Array<{ type: string; account?: string; shared?: boolean }>) ?? [];

  const adapters: AdapterEntry[] = [];

  for (const p of providers) {
    const shared = p.shared ?? false;
    try {
      if (p.type === 'graph') {
        const a = new BmoGraphAdapter();
        if (await a.isConfigured()) {
          adapters.push({ name: 'graph', shared, adapter: a });
          log.debug('Graph adapter ready');
        }
      } else if (p.type === 'jmap') {
        const a = new BmoJmapAdapter();
        if (await a.isConfigured()) {
          adapters.push({ name: 'jmap', shared, adapter: a });
          log.debug('JMAP adapter ready');
        }
      } else if (p.type === 'outlook') {
        const a = new BmoOutlookAdapter();
        if (a.isConfigured()) {
          adapters.push({ name: 'outlook', shared, adapter: a });
          log.debug('Outlook adapter ready');
        }
      } else if (p.type === 'himalaya') {
        const account = p.account ?? 'gmail';
        const a = new BmoHimalayaAdapter(account);
        if (a.isConfigured()) {
          adapters.push({ name: `himalaya-${account}`, shared, adapter: a });
          log.debug(`Himalaya adapter ready (${account})`);
        }
      }
    } catch (err) {
      log.warn(`Failed to initialize ${p.type} adapter`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return adapters;
}

// ── Main ──────────────────────────────────────────────────────

async function run(): Promise<void> {
  const appConfig = loadConfig();
  const raw = appConfig as unknown as Record<string, unknown>;
  const channels = raw.channels as Record<string, unknown> | undefined;
  const email = channels?.email as Record<string, unknown> | undefined;
  const triageEnabled = (email?.triage as Record<string, unknown> | undefined)?.enabled;

  const adapters = await buildAdapters();

  if (adapters.length === 0) {
    log.debug('No email adapters configured — skipping email check');
    return;
  }

  if (!triageEnabled) {
    await legacyCheck(adapters);
    return;
  }

  const triageRules = loadTriageRules();

  let junkCount = 0;
  let newsletterCount = 0;
  let receiptCount = 0;
  let autoReadCount = 0;
  const needsAnalysis: EmailForAnalysis[] = [];

  for (const { name, adapter, shared } of adapters) {
    let messages: EmailMessage[];
    try {
      messages = await adapter.listInbox(20, true);
    } catch (err) {
      log.warn(`${name} email check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // For shared accounts, load previously-triaged IDs and skip them to avoid
    // re-triaging messages that were left unread for the human account owner.
    const triagedIds = shared ? loadTriagedIds(name) : new Set<string>();
    const untriaged = shared ? messages.filter(m => !triagedIds.has(m.id)) : messages;

    if (shared && untriaged.length < messages.length) {
      log.debug(`${name}: skipping ${messages.length - untriaged.length} already-triaged message(s)`);
    }

    for (const msg of untriaged) {
      const category = triageEmail(msg, triageRules);
      switch (category) {
        case 'junk':
          await moveAndMark(adapter, msg.id, 'Unsubscribe');
          if (shared && adapter.markAsUnread) {
            try { await adapter.markAsUnread(msg.id); } catch { /* ignore */ }
          }
          if (shared) triagedIds.add(msg.id);
          junkCount++;
          break;

        case 'newsletter':
          await moveAndMark(adapter, msg.id, 'Newsletters');
          if (shared && adapter.markAsUnread) {
            try { await adapter.markAsUnread(msg.id); } catch { /* ignore */ }
          }
          if (shared) triagedIds.add(msg.id);
          newsletterCount++;
          break;

        case 'receipt':
          await moveAndMark(adapter, msg.id, 'Receipts');
          if (shared && adapter.markAsUnread) {
            try { await adapter.markAsUnread(msg.id); } catch { /* ignore */ }
          }
          if (shared) triagedIds.add(msg.id);
          receiptCount++;
          break;

        case 'auto_read':
          try { await adapter.markAsRead(msg.id); } catch { /* ignore */ }
          if (shared && adapter.markAsUnread) {
            try { await adapter.markAsUnread(msg.id); } catch { /* ignore */ }
          }
          if (shared) triagedIds.add(msg.id);
          autoReadCount++;
          break;

        case 'vip':
        case 'unknown': {
          let body = '';
          if (adapter.readEmail) {
            try {
              const full = await adapter.readEmail(msg.id);
              body = full?.body ?? '';
            } catch (err) {
              log.warn(`Failed to read email body for ${msg.id}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          try { await adapter.markAsRead(msg.id); } catch { /* ignore */ }
          if (shared && adapter.markAsUnread) {
            try { await adapter.markAsUnread(msg.id); } catch { /* ignore */ }
          }
          if (shared) triagedIds.add(msg.id);
          needsAnalysis.push({
            id: msg.id,
            from: msg.from,
            subject: msg.subject,
            body,
            provider: name,
            isVip: category === 'vip',
            shared,
            adapter,
          });
          break;
        }
      }
    }

    // Persist the updated triaged ID set for shared accounts
    if (shared) saveTriagedIds(name, triagedIds);
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

  log.info(`Sending ${needsAnalysis.length} email(s) to sub-agent for analysis`);
  const recommendations = await analyzeWithSubAgent(needsAnalysis);

  if (recommendations.length === 0) {
    log.warn('Sub-agent returned no recommendations — falling back to raw list');
    const fallbackLines = needsAnalysis.map(e => `• ${e.from} — "${e.subject}" [${e.provider}]`);
    injectToSession(`Sub-agent analysis failed. ${needsAnalysis.length} email(s) need manual review:\n${fallbackLines.join('\n')}`);
    return;
  }

  const notifyItems: string[] = [];
  const ruleItems: string[] = [];
  const fileItems: string[] = [];
  let ignoredCount = 0;

  for (const rec of recommendations) {
    const emailItem = needsAnalysis.find(e => e.id === rec.id);
    switch (rec.action) {
      case 'notify': {
        const urgencyTag = rec.urgency === 'high' ? ' [urgent]' : '';
        notifyItems.push(`• ${emailItem?.from ?? 'unknown'} — "${emailItem?.subject ?? '?'}"${urgencyTag} — ${rec.reason ?? ''} [${emailItem?.provider ?? '?'}]`);
        break;
      }
      case 'add_rule': {
        if (emailItem) {
          const folder = rec.ruleCategory === 'junk' ? 'Unsubscribe'
            : rec.ruleCategory === 'newsletters' ? 'Newsletters'
            : rec.ruleCategory === 'receipts' ? 'Receipts'
            : null;
          if (folder) {
            await moveAndMark(emailItem.adapter, emailItem.id, folder);
            if (emailItem.shared && emailItem.adapter.markAsUnread) {
              try { await emailItem.adapter.markAsUnread(emailItem.id); } catch { /* ignore */ }
            }
          }
        }
        // Dedup check: skip injecting the rule suggestion if the pattern is already
        // covered by an existing rule in this category. Checks case-insensitively
        // for exact match or substring overlap in either direction (e.g., "prusa3d"
        // won't be re-suggested if "prusa3d" or "prusa3d.com" already exists).
        if (rec.rulePattern && rec.ruleCategory) {
          const existingPatterns: string[] = triageRules[rec.ruleCategory] ?? [];
          const patternLower = rec.rulePattern.toLowerCase();
          const isDuplicate = existingPatterns.some(p => {
            const pLower = p.toLowerCase();
            return pLower === patternLower || pLower.includes(patternLower) || patternLower.includes(pLower);
          });
          if (isDuplicate) {
            log.debug(`Skipping duplicate rule suggestion: "${rec.rulePattern}" already covered in ${rec.ruleCategory}`);
            logDedupDecision(emailItem?.provider ?? 'unknown', rec.rulePattern, rec.ruleCategory, 'ok_config_dup', 'config pattern match');
            dedupStats.seen++;
            break;
          }
        }
        // Memory-search dedup: check against previously stored triage rules
        if (rec.rulePattern && rec.ruleCategory) {
          let memResult: MemoryDedupResult = 'ok';
          try {
            memResult = await checkMemoryDedup(rec.rulePattern, rec.ruleCategory, emailItem?.provider ?? 'unknown');
          } catch (err) {
            log.warn('Memory dedup check threw unexpectedly — proceeding with emit', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          if (memResult === 'exact') {
            log.info(`[triage-dedup] Skipping — exact rule already in memory: "${rec.rulePattern}" → ${rec.ruleCategory}`);
            break;
          }
          if (memResult === 'broader_covers') {
            log.info(`[triage-dedup] Skipping — broader memory rule subsumes: "${rec.rulePattern}" → ${rec.ruleCategory}`);
            break;
          }
          if (memResult === 'narrower_conflict') {
            log.warn(`[triage-dedup] Narrower-pattern conflict for "${rec.rulePattern}" → ${rec.ruleCategory} — emitting for human review`);
          }
        }
        ruleItems.push(`• "${rec.rulePattern ?? emailItem?.from ?? 'unknown'}" → ${rec.ruleCategory ?? 'junk'} (${rec.reason ?? ''})`);
        break;
      }
      case 'file': {
        if (emailItem && rec.folder) {
          await moveAndMark(emailItem.adapter, emailItem.id, rec.folder);
          if (emailItem.shared && emailItem.adapter.markAsUnread) {
            try { await emailItem.adapter.markAsUnread(emailItem.id); } catch { /* ignore */ }
          }
        }
        fileItems.push(`• ${emailItem?.from ?? 'unknown'} — "${emailItem?.subject ?? '?'}" → ${rec.folder ?? '?'}`);
        break;
      }
      case 'ignore':
        ignoredCount++;
        break;
    }
  }

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

  // Dedup stats: seen = suppressed rules, emitted = proposed rules, nlFallback = NL-matched suppressed
  const totalChecked = dedupStats.seen + dedupStats.emitted;
  if (totalChecked > 0) {
    log.info(`[triage-dedup] stats: ${dedupStats.seen} suppressed / ${dedupStats.emitted} emitted (${dedupStats.nlFallback} via NL fallback)`);
  }
  // Reset for next run
  dedupStats.seen = 0;
  dedupStats.emitted = 0;
  dedupStats.nlFallback = 0;
}

/** Legacy check for when triage is disabled — just counts unread. */
async function legacyCheck(adapters: AdapterEntry[]): Promise<void> {
  let totalUnread = 0;
  const details: string[] = [];

  for (const { name, adapter } of adapters as AdapterEntry[]) {
    try {
      const inbox = await adapter.listInbox(20, true);
      if (inbox.length > 0) {
        totalUnread += inbox.length;
        details.push(`${inbox.length} on ${name}`);
      }
    } catch (err) {
      log.warn(`${name} email check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
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
