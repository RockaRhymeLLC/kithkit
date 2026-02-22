/**
 * Memory Sync task — periodic knowledge exchange with A2A peers.
 *
 * Sends non-private memories to peers and handles incoming memories.
 * Rules:
 *   - source:user always wins (never overwritten by peer data)
 *   - Peer memories are additive (never overwrite, only add new)
 *   - Conflicts flagged for the user
 *   - Private memories (PII, accounts, credentials) excluded
 *   - Provenance tracked: "Source: received from <peer> on DATE"
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig, resolveProjectPath } from '../../../core/config.js';
import { createLogger } from '../../../core/logger.js';
import { readKeychain } from '../../../core/keychain.js';
import { getPeerState } from '../../comms/agent-comms.js';
import { injectText } from '../../../core/session-bridge.js';
import type { Scheduler } from '../../../automation/scheduler.js';
import { asBmoConfig, type PeerConfig } from '../../config.js';

const log = createLogger('memory-sync');

// ── Types ─────────────────────────────────────────────────────

interface MemoryFrontmatter {
  date?: string;
  category?: string;
  importance?: number;
  subject?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  consolidated_from?: string[];
  related_todos?: string[];
}

/** A single memory in the sync payload. */
export interface SyncMemoryPayload {
  filename: string;
  subject: string;
  category: string;
  content: string;  // Full file content including frontmatter
}

/** Incoming sync request from a peer. */
export interface IncomingSyncRequest {
  from: string;
  memories: SyncMemoryPayload[];
}

/** Result detail for a single memory. */
interface SyncResultDetail {
  subject: string;
  action: 'accepted' | 'skipped' | 'updated' | 'conflict';
  reason?: string;
}

/** Response from the /agent/memory-sync endpoint. */
export interface SyncResponse {
  ok: boolean;
  accepted: number;
  skipped: number;
  updated: number;
  conflicts: number;
  details: SyncResultDetail[];
}

/** A tracked conflict between local and peer memory. */
interface SyncConflict {
  subject: string;
  detectedAt: string;   // ISO timestamp
  direction: 'inbound' | 'outbound';  // inbound = we received, outbound = we sent
  reason?: string;
}

/** Persistent sync state per peer. */
interface SyncState {
  [peerName: string]: {
    lastSentAt: string;      // ISO timestamp of newest file mtime we sent
    lastReceivedAt: string;  // ISO timestamp of last receive
    sentCount: number;       // Lifetime count of memories sent
    receivedCount: number;   // Lifetime count of memories accepted
    conflicts?: SyncConflict[];  // Unresolved conflicts awaiting human review
  };
}

// ── Constants ─────────────────────────────────────────────────

const PRIVATE_TAGS = new Set(['pii', 'credential', 'financial', 'ssn', 'keychain', 'password']);
const PRIVATE_CATEGORIES = new Set(['account']);
const SYNC_STATE_FILE = '.claude/state/memory/sync-state.json';
const MEMORIES_DIR = '.claude/state/memory/memories';

// ── Frontmatter Parsing ──────────────────────────────────────

/**
 * Parse YAML frontmatter from a memory file.
 * Simple line-by-line parser — avoids pulling in a YAML library.
 */
function parseFrontmatter(content: string): { frontmatter: MemoryFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fmText = match[1]!;
  const body = match[2]!;
  const fm: MemoryFrontmatter = {};

  for (const line of fmText.split('\n')) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();

    switch (key) {
      case 'subject': fm.subject = value; break;
      case 'category': fm.category = value; break;
      case 'importance': fm.importance = parseInt(value, 10); break;
      case 'source': fm.source = value; break;
      case 'date': fm.date = value; break;
      case 'confidence': fm.confidence = parseFloat(value); break;
      case 'tags': {
        const tagMatch = value.match(/\[([^\]]*)\]/);
        if (tagMatch) {
          fm.tags = tagMatch[1]!.split(',').map(t => t.trim()).filter(Boolean);
        }
        break;
      }
    }
  }

  return { frontmatter: fm, body };
}

// ── Privacy Check ────────────────────────────────────────────

/** Returns true if a memory should NOT be synced to peers. */
function isPrivateMemory(fm: MemoryFrontmatter, body: string): boolean {
  // Category-based exclusion
  if (fm.category && PRIVATE_CATEGORIES.has(fm.category)) return true;

  // Tag-based exclusion
  if (fm.tags?.some(t => PRIVATE_TAGS.has(t.toLowerCase()))) return true;

  // Body contains keychain references — likely sensitive
  if (body.includes('Keychain:') || body.includes('keychain:')) return true;

  return false;
}

// ── Sync State ───────────────────────────────────────────────

function loadSyncState(): SyncState {
  const statePath = resolveProjectPath(SYNC_STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSyncState(state: SyncState): void {
  const statePath = resolveProjectPath(SYNC_STATE_FILE);
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ── Local Memory Index ───────────────────────────────────────

interface LocalMemoryIndex {
  filename: string;
  subject: string;
  category: string;
  source: string;
}

/**
 * Build an index of local memories for quick matching.
 * Only loads frontmatter (first ~10 lines), not full content.
 */
function buildLocalIndex(): LocalMemoryIndex[] {
  const dir = resolveProjectPath(MEMORIES_DIR);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const index: LocalMemoryIndex[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file), 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    if (frontmatter.subject) {
      index.push({
        filename: file,
        subject: frontmatter.subject,
        category: frontmatter.category ?? 'other',
        source: frontmatter.source ?? 'unknown',
      });
    }
  }

  return index;
}

/**
 * Find a local memory matching a given subject (case-insensitive).
 * Returns the matching entry or undefined.
 */
function findMatchingMemory(
  index: LocalMemoryIndex[],
  subject: string,
  category: string,
): LocalMemoryIndex | undefined {
  const subjectLower = subject.toLowerCase();
  // Exact subject match (case-insensitive) within same category
  return index.find(m =>
    m.category === category && m.subject.toLowerCase() === subjectLower,
  );
}

/**
 * Strip provenance line from body for comparison.
 * Provenance lines look like: "> Source: received from X on DATE"
 */
function stripProvenance(body: string): string {
  return body.replace(/^> Source: received from .*\n\n?/, '').trim();
}

// ── Slug & Subject Helpers ───────────────────────────────────

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Subjects that carry no real information. */
const UNINFORMATIVE_SUBJECTS = new Set(['unknown', '(empty)', '(no subject)', 'untitled', '']);

/**
 * Derive a meaningful subject from a memory's body content.
 * Tries: first markdown heading, first sentence, or first N words.
 */
function deriveSubjectFromBody(body: string): string | null {
  const cleaned = body
    .replace(/^> Source:.*\n\n?/, '') // Strip provenance
    .trim();

  if (!cleaned) return null;

  // Try first markdown heading
  const heading = cleaned.match(/^#+\s+(.+)/m);
  if (heading) {
    const h = heading[1]!.replace(/[*_`#]/g, '').trim();
    if (h.length >= 5) return h.slice(0, 80);
  }

  // Try first non-empty line as sentence
  const firstLine = cleaned.split('\n').find(l => l.trim().length > 5);
  if (firstLine) {
    const sentence = firstLine.replace(/^[-*•]\s*/, '').replace(/\*\*/g, '').trim();
    if (sentence.length >= 5) return sentence.slice(0, 80);
  }

  return null;
}

/**
 * Ensure a filename is unique in the directory by appending -2, -3, etc.
 */
function ensureUniqueFilename(dir: string, filename: string): string {
  if (!fs.existsSync(path.join(dir, filename))) return filename;

  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let counter = 2;
  while (fs.existsSync(path.join(dir, `${base}-${counter}${ext}`))) {
    counter++;
  }
  return `${base}-${counter}${ext}`;
}

// ── Receive Handler (called from main.ts) ────────────────────

/**
 * Handle an incoming memory sync request from a peer.
 * Called by the HTTP endpoint POST /agent/memory-sync.
 */
export async function handleMemorySync(
  authToken: string | null,
  body: unknown,
): Promise<{ status: number; body: SyncResponse | { error: string } }> {
  // Auth check
  const secret = await readKeychain('credential-agent-comms-secret');
  if (!authToken || !secret || authToken !== secret) {
    log.warn('Memory sync rejected: invalid auth');
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  // Validate payload
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'Request body must be a JSON object' } };
  }

  const req = body as IncomingSyncRequest;
  if (!req.from || typeof req.from !== 'string') {
    return { status: 400, body: { error: "'from' is required" } };
  }
  if (!Array.isArray(req.memories)) {
    return { status: 400, body: { error: "'memories' must be an array" } };
  }

  log.info(`Incoming memory sync from ${req.from}`, { count: req.memories.length });

  const peerSource = `peer-${req.from}`;
  const index = buildLocalIndex();
  const memoriesDir = resolveProjectPath(MEMORIES_DIR);
  const details: SyncResultDetail[] = [];
  let accepted = 0;
  let skipped = 0;
  let updated = 0;
  let conflicts = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const mem of req.memories) {
    if (!mem.content) {
      details.push({ subject: mem.subject ?? '(empty)', action: 'skipped', reason: 'missing-content' });
      skipped++;
      continue;
    }

    // Fix uninformative subjects by deriving from content
    let effectiveSubject = mem.subject?.trim() || '';
    if (!effectiveSubject || UNINFORMATIVE_SUBJECTS.has(effectiveSubject.toLowerCase())) {
      const { body: memBody } = parseFrontmatter(mem.content);
      const derived = deriveSubjectFromBody(memBody);
      if (derived) {
        effectiveSubject = derived;
        log.info(`Derived subject for memory from ${req.from}: "${derived}" (was "${mem.subject ?? ''}")`);
      } else {
        details.push({ subject: mem.subject ?? '(empty)', action: 'skipped', reason: 'no-subject-derivable' });
        skipped++;
        continue;
      }
    }

    const match = findMatchingMemory(index, effectiveSubject, mem.category);

    if (!match) {
      // New memory — accept and store
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const slug = toSlug(effectiveSubject);
      const candidateFilename = `${ts}-${slug}.md`;
      const filename = ensureUniqueFilename(memoriesDir, candidateFilename);

      // Rewrite frontmatter with peer source and inject subject if missing
      const newContent = rewriteForPeer(mem.content, peerSource, req.from, today, effectiveSubject);
      fs.writeFileSync(path.join(memoriesDir, filename), newContent);

      // Add to index so subsequent memories in this batch can match
      index.push({ filename, subject: effectiveSubject, category: mem.category, source: peerSource });

      details.push({ subject: effectiveSubject, action: 'accepted' });
      accepted++;
      log.info(`Accepted memory from ${req.from}: ${effectiveSubject}`);
      continue;
    }

    // Match found — check source priority
    if (match.source === 'user') {
      // Our user-stated fact is canonical — skip
      details.push({ subject: effectiveSubject, action: 'skipped', reason: 'user-source-canonical' });
      skipped++;
      continue;
    }

    if (match.source === peerSource) {
      // Same peer sent this before — check if content changed
      const localContent = fs.readFileSync(path.join(memoriesDir, match.filename), 'utf-8');
      const { body: localBody } = parseFrontmatter(localContent);
      const { body: incomingBody } = parseFrontmatter(mem.content);

      if (stripProvenance(localBody) === stripProvenance(incomingBody)) {
        details.push({ subject: effectiveSubject, action: 'skipped', reason: 'unchanged' });
        skipped++;
      } else {
        // Peer updated their version — update ours
        const newContent = rewriteForPeer(mem.content, peerSource, req.from, today, effectiveSubject);
        fs.writeFileSync(path.join(memoriesDir, match.filename), newContent);
        details.push({ subject: effectiveSubject, action: 'updated' });
        updated++;
        log.info(`Updated peer memory from ${req.from}: ${effectiveSubject}`);
      }
      continue;
    }

    // Different non-user source — flag as conflict
    details.push({
      subject: effectiveSubject,
      action: 'conflict',
      reason: `local-source:${match.source}`,
    });
    conflicts++;
    log.warn(`Memory conflict from ${req.from}: "${effectiveSubject}" (local source: ${match.source})`);
  }

  // Update receive state
  const syncState = loadSyncState();
  if (!syncState[req.from]) {
    syncState[req.from] = { lastSentAt: '', lastReceivedAt: '', sentCount: 0, receivedCount: 0 };
  }
  syncState[req.from]!.lastReceivedAt = new Date().toISOString();
  syncState[req.from]!.receivedCount += accepted;

  // Track inbound conflicts and only notify about NEW ones (dedup)
  if (conflicts > 0) {
    const now = new Date().toISOString();
    const existing = syncState[req.from]!.conflicts ?? [];
    const existingSubjects = new Set(existing.map(c => c.subject));
    const newConflicts = details
      .filter(d => d.action === 'conflict' && !existingSubjects.has(d.subject))
      .map(d => ({
        subject: d.subject,
        detectedAt: now,
        direction: 'inbound' as const,
        reason: d.reason,
      }));
    syncState[req.from]!.conflicts = [...existing, ...newConflicts];

    // Only notify about truly new conflicts — don't re-flag known ones every cycle
    if (newConflicts.length > 0) {
      const conflictSubjects = newConflicts
        .map(c => `"${c.subject}"`)
        .join(', ');
      injectText(`[Memory Sync] ${newConflicts.length} new conflict(s) from ${req.from}: ${conflictSubjects}. Review needed.`);
    } else {
      log.debug(`${conflicts} known conflict(s) from ${req.from} still unresolved — suppressing notification`);
    }
  }

  saveSyncState(syncState);

  log.info(`Memory sync from ${req.from} complete`, { accepted, skipped, updated, conflicts });

  return {
    status: 200,
    body: { ok: true, accepted, skipped, updated, conflicts, details },
  };
}

/**
 * Rewrite a memory file's frontmatter for peer storage.
 * Changes source to peer-{name}, adds provenance line, injects subject if missing.
 */
function rewriteForPeer(content: string, peerSource: string, peerName: string, date: string, effectiveSubject?: string): string {
  const { frontmatter, body } = parseFrontmatter(content);

  // Rebuild frontmatter with peer source
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return content;

  let fmText = fm[1]!;

  // Replace or add source field
  if (fmText.includes('source:')) {
    fmText = fmText.replace(/^source:.*$/m, `source: ${peerSource}`);
  } else {
    fmText += `\nsource: ${peerSource}`;
  }

  // Inject subject if missing or uninformative
  if (effectiveSubject) {
    if (fmText.match(/^subject:/m)) {
      const existingSubject = fmText.match(/^subject:\s*(.*)$/m)?.[1]?.trim() ?? '';
      if (!existingSubject || UNINFORMATIVE_SUBJECTS.has(existingSubject.toLowerCase())) {
        fmText = fmText.replace(/^subject:.*$/m, `subject: ${effectiveSubject}`);
      }
    } else {
      fmText += `\nsubject: ${effectiveSubject}`;
    }
  }

  // Add provenance line to body
  const displayName = peerName;
  const provenance = `> Source: received from ${displayName} on ${date}\n\n`;
  const newBody = body.trimStart().startsWith('> Source:')
    ? body.replace(/^> Source:.*\n\n?/, provenance)  // Update existing provenance
    : provenance + body;

  return `---\n${fmText}\n---\n${newBody}`;
}

// ── Send Logic (scheduler task) ──────────────────────────────

/**
 * Collect non-private memories modified since the last sync.
 */
function collectMemoriesToSync(lastSentAt: string): { memories: SyncMemoryPayload[]; newestMtime: string } {
  const dir = resolveProjectPath(MEMORIES_DIR);
  if (!fs.existsSync(dir)) return { memories: [], newestMtime: '' };

  const cutoff = lastSentAt ? new Date(lastSentAt).getTime() : 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const memories: SyncMemoryPayload[] = [];
  let newestMtime = cutoff;

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;

    // Skip files not modified since last sync
    if (mtime <= cutoff) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Skip private memories
    if (isPrivateMemory(frontmatter, body)) continue;

    // Skip memories we received from peers (don't echo back)
    if (frontmatter.source?.startsWith('peer-')) continue;

    if (!frontmatter.subject) continue;

    memories.push({
      filename: file,
      subject: frontmatter.subject,
      category: frontmatter.category ?? 'other',
      content,
    });

    if (mtime > newestMtime) newestMtime = mtime;
  }

  return {
    memories,
    newestMtime: newestMtime > cutoff ? new Date(newestMtime).toISOString() : lastSentAt,
  };
}

/**
 * Send memories to a peer via HTTP POST to /agent/memory-sync.
 * Uses curl (not Node.js http) due to macOS LAN networking issues.
 */
async function sendToPeer(
  peer: PeerConfig,
  memories: SyncMemoryPayload[],
): Promise<{ ok: boolean; response?: SyncResponse; error?: string }> {
  const config = loadConfig();
  const secret = await readKeychain('credential-agent-comms-secret');
  if (!secret) return { ok: false, error: 'No agent-comms secret' };

  const payload = JSON.stringify({
    from: config.agent.name.toLowerCase(),
    memories,
  });

  // Write payload to temp file for large payloads (avoid arg length limits)
  const tmpFile = `/tmp/memory-sync-${Date.now()}.json`;
  fs.writeFileSync(tmpFile, payload);

  const hosts = [peer.host];
  if (peer.ip && peer.ip !== peer.host) hosts.push(peer.ip);

  return new Promise((resolve) => {
    const tryHost = (hostIdx: number) => {
      if (hostIdx >= hosts.length) {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        resolve({ ok: false, error: 'All hosts exhausted' });
        return;
      }

      const host = hosts[hostIdx]!;
      const url = `http://${host}:${peer.port}/agent/memory-sync`;
      const args = [
        '-s', '--connect-timeout', '10', '--max-time', '30',
        '-w', '\n%{http_code}',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-H', `Authorization: Bearer ${secret}`,
        '-d', `@${tmpFile}`,
      ];

      execFile('curl', args, { timeout: 35000 }, (err, stdout, stderr) => {
        if (err) {
          log.info(`Memory sync to ${peer.name} (${host}) failed, ${hostIdx < hosts.length - 1 ? 'trying fallback' : 'giving up'}`, {
            error: stderr?.trim() || err.message,
          });
          tryHost(hostIdx + 1);
          return;
        }

        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

        const lines = stdout.trimEnd().split('\n');
        const httpStatus = parseInt(lines.pop() ?? '', 10) || 0;
        const responseBody = lines.join('\n');

        if (httpStatus >= 200 && httpStatus < 300) {
          try {
            const response = JSON.parse(responseBody) as SyncResponse;
            resolve({ ok: true, response });
          } catch {
            resolve({ ok: false, error: `Invalid response: ${responseBody.slice(0, 200)}` });
          }
        } else if (httpStatus === 404) {
          // Peer doesn't have the endpoint yet — not an error
          log.info(`Peer ${peer.name} doesn't support memory-sync yet (404)`);
          resolve({ ok: false, error: 'Peer does not support memory-sync (404)' });
        } else {
          log.warn(`Memory sync to ${peer.name}: HTTP ${httpStatus}`, { body: responseBody.slice(0, 200) });
          tryHost(hostIdx + 1);
        }
      });
    };

    tryHost(0);
  });
}

// ── Scheduler Task ───────────────────────────────────────────

async function run(): Promise<void> {
  const config = asBmoConfig(loadConfig());
  const agentComms = config['agent-comms'];

  if (!agentComms?.enabled) {
    log.debug('Agent comms disabled, skipping memory sync');
    return;
  }

  const peers = agentComms.peers || [];
  if (peers.length === 0) {
    log.debug('No peers configured, skipping memory sync');
    return;
  }

  const syncState = loadSyncState();

  for (const peer of peers) {
    // Only sync with reachable peers
    const peerState = getPeerState(peer.name);
    if (peerState && peerState.status === 'unknown') {
      log.debug(`Skipping memory sync with ${peer.name} — unreachable`);
      continue;
    }

    const peerKey = peer.name.toLowerCase();
    const peerSync = syncState[peerKey] ?? {
      lastSentAt: '',
      lastReceivedAt: '',
      sentCount: 0,
      receivedCount: 0,
    };

    const { memories, newestMtime } = collectMemoriesToSync(peerSync.lastSentAt);

    if (memories.length === 0) {
      log.debug(`No new memories to sync with ${peer.name}`);
      continue;
    }

    log.info(`Syncing ${memories.length} memories to ${peer.name}`);

    const result = await sendToPeer(peer, memories);

    if (result.ok && result.response) {
      const r = result.response;
      log.info(`Memory sync to ${peer.name} complete`, {
        accepted: r.accepted,
        skipped: r.skipped,
        updated: r.updated,
        conflicts: r.conflicts,
      });

      peerSync.lastSentAt = newestMtime;
      peerSync.sentCount += memories.length;

      // Track outbound conflicts from peer's response
      if (r.conflicts > 0) {
        const rawDetails: unknown[] = (r as unknown as Record<string, unknown>).details as unknown[] ?? [];
        const now = new Date().toISOString();
        const existingSubjects = new Set((peerSync.conflicts ?? []).map(c => c.subject));

        // Parse details — peer may return structured objects or plain strings
        const newConflicts: SyncConflict[] = [];
        for (const d of rawDetails) {
          let subject: string | undefined;
          let reason: string | undefined;

          if (typeof d === 'object' && d !== null) {
            const obj = d as Record<string, unknown>;
            if (obj.action !== 'conflict') continue;
            subject = String(obj.subject ?? '');
            reason = obj.reason ? String(obj.reason) : undefined;
          } else if (typeof d === 'string') {
            // Parse string format: "Conflict: filename.md (reason)"
            const m = (d as string).match(/^Conflict:\s*(.+?)(?:\s*\((.+)\))?$/);
            if (!m) continue;
            subject = m[1]!.trim();
            reason = m[2]?.trim();
          }

          if (subject && !existingSubjects.has(subject)) {
            newConflicts.push({ subject, detectedAt: now, direction: 'outbound', reason });
          }
        }

        if (newConflicts.length > 0) {
          peerSync.conflicts = [...(peerSync.conflicts ?? []), ...newConflicts];
          log.info(`Tracked ${newConflicts.length} outbound conflict(s) with ${peer.name}`, {
            subjects: newConflicts.map(c => c.subject),
          });
        }
      }

      syncState[peerKey] = peerSync;
      saveSyncState(syncState);
    } else {
      log.warn(`Memory sync to ${peer.name} failed`, { error: result.error });
      // Don't advance the watermark — retry next cycle
    }
  }
}

/** Clear resolved conflicts for a peer (or all peers). */
export function clearMemoryConflicts(peer?: string): number {
  const syncState = loadSyncState();
  let cleared = 0;

  for (const key of Object.keys(syncState)) {
    if (peer && key !== peer.toLowerCase()) continue;
    const conflicts = syncState[key]?.conflicts ?? [];
    cleared += conflicts.length;
    if (syncState[key]) {
      syncState[key]!.conflicts = [];
    }
  }

  if (cleared > 0) saveSyncState(syncState);
  return cleared;
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('memory-sync', async () => {
    await run();
  });
}
