/**
 * Memory Consolidation — nightly curation of the memory database.
 *
 * Runs on cron (default 5am daily). Four operations:
 *
 * 1. **Decay enforcement**: Archive memories based on decay_policy and last_accessed age.
 *
 * 2. **Category cap pruning**: Archive least-important memories when a category
 *    exceeds the configured cap.
 *
 * 3. **Merge duplicates**: Find memory clusters with vector similarity >= threshold,
 *    merge each cluster. 2-member clusters: create new merged record, delete originals.
 *    3+ member clusters: keep highest-importance record, archive the rest.
 *
 * 4. **Log summary**: Record what was done.
 *
 * Cost control:
 * - Max 20 merge operations per run
 * - Skip merge if < 5 active memories with embeddings
 * - Snapshot IDs at start — new memories inserted during run are ignored
 */

import { query, getDatabase } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';
import { generateEmbedding, embeddingToBuffer, bufferToEmbedding } from '../../../memory/embeddings.js';
import { indexEmbedding } from '../../../memory/vector-search.js';
import { isVectorSearchEnabled } from '../../../api/memory.js';
import { getSelfImprovementConfig } from '../../../self-improvement/config.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('memory-consolidation');

const MAX_MERGES_PER_RUN = 20;
const MIN_MEMORIES_TO_RUN = 5;

// ── Types ────────────────────────────────────────────────────

interface MemoryRow {
  id: number;
  content: string;
  category: string | null;
  tags: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
  last_accessed: string | null;
  importance: number;
  expires_at: string | null;
  decay_policy: string | null;
}

interface MergeCluster {
  members: MemoryRow[];
}

interface MergeResult {
  content: string;
  category: string | null;
  tags: string[];
  source: string;
  created_at: string;
  importance: number;
  decay_policy: string;
}

// ── Similarity computation ───────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Clustering ───────────────────────────────────────────────

/**
 * Build clusters of similar memories within the same category.
 * Uses greedy single-linkage: each memory joins the first cluster
 * where it has similarity >= threshold with any member.
 */
function buildClusters(memories: MemoryRow[], threshold: number): MergeCluster[] {
  // Group by category first (only compare within same category)
  const byCategory = new Map<string, MemoryRow[]>();
  for (const m of memories) {
    const cat = m.category ?? '__none__';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(m);
  }

  const clusters: MergeCluster[] = [];

  for (const [, catMemories] of byCategory) {
    if (catMemories.length < 2) continue;

    // Parse embeddings
    const withEmbeddings = catMemories
      .filter(m => m.embedding !== null)
      .map(m => ({ memory: m, vec: bufferToEmbedding(m.embedding!) }));

    if (withEmbeddings.length < 2) continue;

    const assigned = new Set<number>();

    for (let i = 0; i < withEmbeddings.length; i++) {
      if (assigned.has(withEmbeddings[i]!.memory.id)) continue;

      const cluster: MemoryRow[] = [withEmbeddings[i]!.memory];
      assigned.add(withEmbeddings[i]!.memory.id);

      for (let j = i + 1; j < withEmbeddings.length; j++) {
        if (assigned.has(withEmbeddings[j]!.memory.id)) continue;

        const sim = cosineSimilarity(withEmbeddings[i]!.vec, withEmbeddings[j]!.vec);
        if (sim >= threshold) {
          cluster.push(withEmbeddings[j]!.memory);
          assigned.add(withEmbeddings[j]!.memory.id);
        }
      }

      if (cluster.length >= 2) {
        clusters.push({ members: cluster });
      }
    }
  }

  return clusters;
}

// ── Merge logic ──────────────────────────────────────────────

/** Decay policy priority: higher = more durable. */
function decayPriority(policy: string | null): number {
  if (policy === 'evergreen') return 3;
  if (policy === 'short') return 1;
  return 2; // 'default' or null
}

/**
 * Compute the merged result for a 2-member cluster.
 * - Content: from highest-importance member (ties broken by newest created_at)
 * - created_at: newest among members
 * - importance: highest among members
 * - decay_policy: most specific (evergreen > default > short)
 * - tags: union of all tags
 */
function mergeCluster(cluster: MergeCluster): MergeResult {
  const members = cluster.members;

  // Highest importance member (ties: newest created_at)
  const base = members.reduce((a, b) => {
    if (a.importance !== b.importance) return a.importance > b.importance ? a : b;
    return a.created_at > b.created_at ? a : b;
  });

  // Collect all unique tags
  const allTags = new Set<string>();
  for (const m of members) {
    const tags: string[] = JSON.parse(m.tags || '[]');
    tags.forEach(t => allTags.add(t));
  }

  // Most specific decay policy (evergreen > default > short)
  const bestPolicy = members.reduce<string>((best, m) => {
    const curr = m.decay_policy ?? 'default';
    return decayPriority(curr) > decayPriority(best) ? curr : best;
  }, members[0]!.decay_policy ?? 'default');

  // Newest created_at
  const newest = members.reduce((a, b) => (a.created_at > b.created_at ? a : b));

  return {
    content: base.content,
    category: base.category,
    tags: [...allTags],
    source: 'consolidation',
    created_at: newest.created_at,
    importance: base.importance,
    decay_policy: bestPolicy,
  };
}

// ── Archive helper ────────────────────────────────────────────

function archiveMemories(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE memories SET expires_at = datetime('now') WHERE id IN (${placeholders})`,
  ).run(...ids);
}

// ── Process a single cluster ─────────────────────────────────

interface ClusterProcessResult {
  merged: boolean;
  archivedCount: number;
}

/**
 * Process a merge cluster.
 * - 2-member: create new merged record with enhanced field rules, delete originals.
 * - 3+ member: keep highest-importance memory, archive the rest.
 */
async function processCluster(cluster: MergeCluster): Promise<ClusterProcessResult> {
  const db = getDatabase();

  if (cluster.members.length >= 3) {
    // Find highest-importance base (ties: newest created_at)
    const base = cluster.members.reduce((a, b) => {
      if (a.importance !== b.importance) return a.importance > b.importance ? a : b;
      return a.created_at > b.created_at ? a : b;
    });

    const otherIds = cluster.members.filter(m => m.id !== base.id).map(m => m.id);
    archiveMemories(otherIds);

    log.info(
      `3+ member merge: kept base memory ${base.id} (importance=${base.importance}), ` +
      `archived ${otherIds.length} others (category: ${base.category})`,
    );
    return { merged: true, archivedCount: otherIds.length };
  }

  // 2-member merge: create new merged record, delete originals
  const result = mergeCluster(cluster);

  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO memories (content, category, tags, source, created_at, updated_at, importance, decay_policy)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`,
    );
    const insertResult = stmt.run(
      result.content,
      result.category,
      JSON.stringify(result.tags),
      result.source,
      result.created_at,
      result.importance,
      result.decay_policy,
    );

    const newId = Number(insertResult.lastInsertRowid);

    // Delete originals
    const memberIds = cluster.members.map(m => m.id);
    const placeholders = memberIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...memberIds);

    return { newId, deletedCount: memberIds.length };
  });

  const txResult = tx();

  // Generate embedding for the merged memory (async, outside transaction)
  try {
    const embedding = await generateEmbedding(result.content);
    const buf = embeddingToBuffer(embedding);
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, txResult.newId);
    indexEmbedding(txResult.newId, embedding);
  } catch {
    log.warn(`Failed to generate embedding for merged memory ${txResult.newId}`);
  }

  log.info(
    `Merged 2-member cluster → new memory ${txResult.newId} ` +
    `(importance=${result.importance}, decay_policy=${result.decay_policy}, category: ${result.category})`,
  );
  return { merged: true, archivedCount: 0 };
}

// ── Decay enforcement ─────────────────────────────────────────

function parseDays(val: string): number | null {
  if (val === 'never') return null;
  const m = /^(\d+)d$/.exec(val);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Archive memories based on decay_policy and last_accessed age.
 * - "default" policy: archive if last_accessed > 30 days ago (or configured days)
 * - "short" policy: archive if last_accessed > 7 days ago (or configured days)
 * - "evergreen" policy: skip (never decays)
 * Returns count of archived memories.
 */
function enforceDecay(decayConfig: Record<string, string>): number {
  let archived = 0;
  const db = getDatabase();

  for (const [policy, val] of Object.entries(decayConfig)) {
    if (val === 'never') continue;

    const days = parseDays(val);
    if (days === null) continue;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // NULL decay_policy is treated as 'default'.
    // Use COALESCE(last_accessed, created_at) so memories with null last_accessed
    // use their creation date as the effective access time — prevents newly-created
    // memories from being archived just because they've never been read.
    const stale = query<{ id: number }>(
      `SELECT id FROM memories
       WHERE (decay_policy = ? OR (decay_policy IS NULL AND ? = 'default'))
         AND expires_at IS NULL
         AND COALESCE(last_accessed, created_at) < ?`,
      policy, policy, cutoff,
    );

    if (stale.length === 0) continue;

    const ids = stale.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memories SET expires_at = datetime('now') WHERE id IN (${placeholders})`,
    ).run(...ids);

    archived += ids.length;
    log.info(`Decay enforcement (${policy}): archived ${ids.length} memories (cutoff: ${cutoff})`);
  }

  return archived;
}

// ── Category cap pruning ──────────────────────────────────────

/**
 * Archive least-important memories when a category exceeds the cap.
 * Archives by importance ASC (least important first), then created_at ASC (oldest first).
 * Returns count of archived memories.
 */
function enforceCategoryCap(cap: number): number {
  const db = getDatabase();
  let capEnforced = 0;

  const overCap = query<{ category: string; cnt: number }>(
    `SELECT category, COUNT(*) as cnt FROM memories
     WHERE expires_at IS NULL AND category IS NOT NULL
     GROUP BY category
     HAVING cnt > ?`,
    cap,
  );

  for (const { category, cnt } of overCap) {
    const excess = cnt - cap;

    const toArchive = query<{ id: number }>(
      `SELECT id FROM memories
       WHERE expires_at IS NULL AND category = ?
       ORDER BY importance ASC, created_at ASC
       LIMIT ?`,
      category, excess,
    );

    if (toArchive.length === 0) continue;

    const ids = toArchive.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memories SET expires_at = datetime('now') WHERE id IN (${placeholders})`,
    ).run(...ids);

    capEnforced += ids.length;
    log.info(
      `Category cap enforced for "${category}": archived ${ids.length} memories ` +
      `(was ${cnt}, cap ${cap})`,
    );
  }

  return capEnforced;
}

// ── Main task ────────────────────────────────────────────────

async function run(): Promise<void> {
  const config = getSelfImprovementConfig();
  const { lifecycle } = config;

  // 1. Decay enforcement (runs regardless of vector search)
  const archivedByDecay = enforceDecay(lifecycle.decay);

  // 2. Category cap pruning (runs regardless of vector search)
  const capEnforced = enforceCategoryCap(lifecycle.category_cap);

  if (!isVectorSearchEnabled()) {
    log.info('Vector search not available, skipping merge step');
    log.info('Memory consolidation complete', {
      archivedByDecay,
      capEnforced,
      mergesMade: 0,
      memoriesArchivedViaMerge: 0,
    });
    return;
  }

  // Snapshot: get all active memories with embeddings
  const allMemories = query<MemoryRow>(
    `SELECT id, content, category, tags, source, embedding, created_at, last_accessed,
            importance, expires_at, decay_policy
     FROM memories
     WHERE embedding IS NOT NULL AND expires_at IS NULL`,
  );

  if (allMemories.length < MIN_MEMORIES_TO_RUN) {
    log.info(
      `Only ${allMemories.length} active memories with embeddings, ` +
      `below threshold of ${MIN_MEMORIES_TO_RUN}. Skipping merge.`,
    );
    log.info('Memory consolidation complete', {
      archivedByDecay,
      capEnforced,
      mergesMade: 0,
      memoriesArchivedViaMerge: 0,
    });
    return;
  }

  log.info(`Memory consolidation starting merge: ${allMemories.length} active memories`);

  // 3. Build clusters of similar memories
  const clusters = buildClusters(allMemories, lifecycle.consolidation_threshold);
  log.info(`Found ${clusters.length} merge clusters`);

  // 4. Process clusters (up to MAX_MERGES_PER_RUN)
  let mergesMade = 0;
  let memoriesArchivedViaMerge = 0;

  for (const cluster of clusters.slice(0, MAX_MERGES_PER_RUN)) {
    try {
      const result = await processCluster(cluster);
      if (result.merged) {
        mergesMade++;
        memoriesArchivedViaMerge += result.archivedCount;
      }
    } catch (err) {
      log.error('Failed to process cluster', {
        memberIds: cluster.members.map(m => m.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Log summary
  log.info('Memory consolidation complete', {
    totalMemories: allMemories.length,
    clustersFound: clusters.length,
    mergesMade,
    memoriesArchivedViaMerge,
    archivedByDecay,
    capEnforced,
  });
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('memory-consolidation', async () => {
    await run();
  });
}

// ── Test exports ─────────────────────────────────────────────

export {
  enforceDecay as _enforceDecayForTesting,
  enforceCategoryCap as _enforceCategoryCapForTesting,
  processCluster as _processClusterForTesting,
  buildClusters as _buildClustersForTesting,
  mergeCluster as _mergeClusterForTesting,
  cosineSimilarity as _cosineSimilarityForTesting,
  run as _runForTesting,
};
export type { MemoryRow as _MemoryRowForTesting, MergeCluster as _MergeClusterForTesting };
