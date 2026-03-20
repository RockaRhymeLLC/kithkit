/**
 * Cross-agent memory synchronization.
 *
 * Three main functions:
 *   syncToPeers   — outbound: send shareable memories to configured peers
 *   handleMemorySync — inbound: store a synced learning, resolving conflicts
 *   pullFromPeers — offline catch-up: pull memories newer than last sync timestamp
 */

import { getDatabase } from '../core/db.js';
import { loadConfig } from '../core/config.js';
import { getSelfImprovementConfig } from './config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('self-improvement:memory-sync');

// ── Testability hooks ─────────────────────────────────────────

type SendA2AFn = (body: Record<string, unknown>) => Promise<void>;
let _sendA2AFn: SendA2AFn | null = null;

export function _setSendA2AFnForTesting(fn: SendA2AFn | null): void {
  _sendA2AFn = fn;
}

// ── A2A send (default: HTTP to localhost) ─────────────────────

async function sendA2A(body: Record<string, unknown>): Promise<void> {
  if (_sendA2AFn) {
    return _sendA2AFn(body);
  }
  const config = loadConfig() as unknown as Record<string, unknown>;
  const daemonConfig = config.daemon as { port?: number } | undefined;
  const port = daemonConfig?.port ?? 3847;
  const response = await fetch(`http://127.0.0.1:${port}/api/a2a/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`A2A send failed: ${response.status} ${text}`);
  }
}

// ── Sync timestamp state (stored in feature_state DB table) ──

const SYNC_STATE_FEATURE = 'memory-sync-timestamps';

function loadSyncTimestamps(): Record<string, string> {
  try {
    const db = getDatabase();
    const row = db
      .prepare(`SELECT state FROM feature_state WHERE feature = ?`)
      .get(SYNC_STATE_FEATURE) as { state: string } | undefined;
    if (!row) return {};
    return JSON.parse(row.state) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSyncTimestamps(timestamps: Record<string, string>): void {
  try {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO feature_state (feature, state, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(feature) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ).run(SYNC_STATE_FEATURE, JSON.stringify(timestamps), now);
  } catch (err) {
    log.warn('Failed to save sync timestamps', { error: String(err) });
  }
}

// ── Similarity ────────────────────────────────────────────────

const CONFLICT_THRESHOLD = 0.85;

/**
 * Simple keyword overlap similarity between two strings.
 * Only considers words of 3+ characters.
 * Returns a score in [0, 1].
 *
 * NOTE (v1 limitation): This keyword-overlap approach can miss semantic duplicates
 * (e.g. "restart the process" vs "reboot the service"). A future improvement would
 * use vector embeddings (all-MiniLM-L6-v2) for conflict detection instead.
 */
export function computeSimilarity(a: string, b: string): number {
  const toWords = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length >= 3));
  const wordsA = toWords(a);
  const wordsB = toWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ── Conflict priority ─────────────────────────────────────────

const TRIGGER_PRIORITY: Record<string, number> = {
  correction: 4,
  retro: 3,
  transcript: 2,
  sync: 1,
};

function getTriggerPriority(trigger: string | null): number {
  return TRIGGER_PRIORITY[trigger ?? ''] ?? 0;
}

// ── Outbound sync ─────────────────────────────────────────────

/**
 * Sync a newly stored memory to all configured peers.
 * Fire-and-forget: errors are logged but not thrown.
 *
 * @param memory  The memory row (from DB insert or API response)
 */
export async function syncToPeers(memory: Record<string, unknown>): Promise<void> {
  const cfg = getSelfImprovementConfig();
  if (!cfg.memory_sync.enabled) return;

  // Must be shareable (stored as 1 in DB, or true from caller)
  const shareable = memory.shareable;
  if (shareable === 0 || shareable === false || shareable === null) return;

  // Never re-sync memories that arrived via sync — prevents relay loops in 3+ agent topologies
  const triggerValue = (memory.trigger as string | null | undefined)?.toLowerCase() ?? '';
  if (triggerValue === 'sync') {
    log.debug('Skipping sync — memory trigger is "sync" to prevent relay amplification loops');
    return;
  }

  const config = loadConfig() as unknown as Record<string, unknown>;
  const agentConfig = config.agent as { name?: string } | undefined;
  const agentName = agentConfig?.name?.toLowerCase() ?? 'unknown';

  const peers = cfg.memory_sync.peers;
  for (const peer of peers) {
    // Don't echo back to the originating agent
    const originAgent = (memory.origin_agent as string | null | undefined)?.toLowerCase() ?? '';
    if (originAgent && originAgent === peer.toLowerCase()) {
      log.debug(`Skipping sync to ${peer} — memory originated from that peer`);
      continue;
    }

    let tags: string[];
    try {
      const rawTags = memory.tags;
      if (Array.isArray(rawTags)) {
        tags = rawTags as string[];
      } else if (typeof rawTags === 'string') {
        tags = JSON.parse(rawTags) as string[];
      } else {
        tags = [];
      }
    } catch {
      tags = [];
    }

    const syncBody = {
      to: peer,
      payload: {
        type: 'memory-sync',
        text: `Memory sync: ${String(memory.content).slice(0, 100)}`,
        learning: {
          content: memory.content,
          category: memory.category ?? null,
          tags,
          importance: memory.importance ?? 1,
          origin_agent: memory.origin_agent ?? agentName,
          trigger: memory.trigger ?? null,
          decay_policy: memory.decay_policy ?? 'default',
          created_at: memory.created_at ?? new Date().toISOString(),
        },
      },
    };

    try {
      await sendA2A(syncBody);
      log.info(`Synced memory to peer ${peer}`);
    } catch (err) {
      log.warn(`Failed to sync memory to peer ${peer}`, { error: String(err) });
    }
  }
}

// ── Inbound sync ──────────────────────────────────────────────

interface MemoryRow {
  id: number;
  content: string;
  created_at: string;
  origin_agent: string | null;
  trigger: string | null;
}

/**
 * Handle an inbound memory-sync payload from a peer.
 * Resolves conflicts and stores the learning if appropriate.
 */
export async function handleMemorySync(payload: Record<string, unknown>): Promise<void> {
  const learning = payload.learning as Record<string, unknown> | undefined;
  if (!learning || typeof learning.content !== 'string' || !learning.content) {
    log.warn('handleMemorySync: invalid payload — missing or empty learning.content');
    return;
  }

  const content = learning.content;
  const category = (learning.category as string | null) ?? null;
  const tags = Array.isArray(learning.tags) ? (learning.tags as string[]) : [];
  const originAgent = (learning.origin_agent as string | null) ?? null;
  const trigger = (learning.trigger as string | null) ?? 'sync';
  const decayPolicy = (learning.decay_policy as string | null) ?? 'default';
  const incomingCreatedAt = learning.created_at as string | undefined;

  const db = getDatabase();

  // Find candidates in same category (or all if no category)
  let candidates: MemoryRow[];
  if (category) {
    candidates = db
      .prepare(`SELECT id, content, created_at, origin_agent, trigger FROM memories WHERE category = ?`)
      .all(category) as MemoryRow[];
  } else {
    candidates = db
      .prepare(`SELECT id, content, created_at, origin_agent, trigger FROM memories LIMIT 500`)
      .all() as MemoryRow[];
  }

  // Exact match → deduplicate silently
  const exactMatch = candidates.find((c) => c.content === content);
  if (exactMatch) {
    log.debug('handleMemorySync: exact duplicate — skipping');
    return;
  }

  // High-similarity conflict check
  const conflict = candidates.find((c) => computeSimilarity(c.content, content) >= CONFLICT_THRESHOLD);

  if (!conflict) {
    // No conflict — store
    db.prepare(
      `INSERT INTO memories (content, category, tags, origin_agent, trigger, decay_policy, shareable)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(content, category, JSON.stringify(tags), originAgent, 'sync', decayPolicy);

    log.info('handleMemorySync: stored synced memory', { origin: originAgent, category });
    return;
  }

  // Conflict found
  const existingOrigin = conflict.origin_agent?.toLowerCase() ?? null;
  const incomingOrigin = originAgent?.toLowerCase() ?? null;

  if (existingOrigin === incomingOrigin) {
    // Same-origin: newer timestamp wins
    const existingTs = new Date(conflict.created_at).getTime();
    const incomingTs = incomingCreatedAt ? new Date(incomingCreatedAt).getTime() : Date.now();

    if (incomingTs > existingTs) {
      db.prepare(
        `UPDATE memories SET content = ?, trigger = ?, decay_policy = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(content, 'sync', decayPolicy, conflict.id);
      log.info('handleMemorySync: same-origin conflict — replaced with newer incoming', { id: conflict.id });
    } else {
      log.info('handleMemorySync: same-origin conflict — existing is newer, skipping incoming', { id: conflict.id });
    }
  } else {
    // Cross-agent conflict: keep both with source attribution
    // Lower-priority incoming gets attribution prefix
    const incomingPriority = getTriggerPriority(trigger);
    const attributedContent =
      incomingPriority < getTriggerPriority(conflict.trigger)
        ? `[sync from ${originAgent ?? 'unknown'}] ${content}`
        : content;

    db.prepare(
      `INSERT INTO memories (content, category, tags, origin_agent, trigger, decay_policy, shareable)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(attributedContent, category, JSON.stringify(tags), originAgent, 'sync', decayPolicy);

    log.info('handleMemorySync: cross-agent conflict — kept both with attribution', {
      existingId: conflict.id,
      incomingOrigin,
      existingOrigin,
    });
  }
}

// ── Offline catch-up ──────────────────────────────────────────

interface SinceResponse {
  memories?: Array<Record<string, unknown>>;
}

/**
 * Pull memories from peers that were created after the last successful sync.
 * Updates last_sync_timestamp per peer on success.
 *
 * TODO: This function is implemented but not yet called or scheduled. It is
 * intended as an offline catch-up mechanism for agents that rejoin after downtime.
 * When ready, schedule it as a periodic daemon task (e.g. every 30 minutes).
 */
export async function pullFromPeers(): Promise<void> {
  const cfg = getSelfImprovementConfig();
  if (!cfg.memory_sync.enabled) return;

  const timestamps = loadSyncTimestamps();
  const config = loadConfig() as unknown as Record<string, unknown>;
  const agentComms = config['agent-comms'] as
    | { peers?: Array<{ name: string; host: string; port: number }> }
    | undefined;
  const peerConfigs = agentComms?.peers ?? [];

  const peers = cfg.memory_sync.peers;
  for (const peer of peers) {
    const lastSync = timestamps[peer] ?? new Date(0).toISOString();
    const peerConfig = peerConfigs.find((p) => p.name.toLowerCase() === peer.toLowerCase());

    if (!peerConfig) {
      log.debug(`pullFromPeers: no host config for peer '${peer}' — skipping catch-up`);
      continue;
    }

    const url = `http://${peerConfig.host}:${peerConfig.port}/api/memory/since/${encodeURIComponent(lastSync)}`;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        log.warn(`pullFromPeers: peer ${peer} returned ${response.status}`);
        continue;
      }

      const data = (await response.json()) as SinceResponse;
      const memories = data.memories ?? [];

      for (const m of memories) {
        await handleMemorySync({ learning: m });
      }

      timestamps[peer] = new Date().toISOString();
      log.info(`pullFromPeers: pulled ${memories.length} memories from ${peer}`, { peer, lastSync });
    } catch (err) {
      log.warn(`pullFromPeers: failed to pull from ${peer}`, { error: String(err) });
    }
  }

  saveSyncTimestamps(timestamps);
}

// ── Exports for testing ───────────────────────────────────────

export { CONFLICT_THRESHOLD };
export { loadSyncTimestamps, saveSyncTimestamps };
