/**
 * Memory Consolidation — nightly curation of the memory database.
 *
 * Runs on cron (default 5am daily). Three operations:
 *
 * 1. **Merge duplicates**: Find memory clusters with vector similarity > 0.85,
 *    merge each cluster into a single well-written memory, delete originals.
 *
 * 2. **Archive stale episodic memories**: Episodic memories not accessed in 30 days
 *    are deleted (they're session-specific and not worth keeping indefinitely).
 *
 * 3. **Log summary**: Record what was done in task_results.
 *
 * Cost control:
 * - Max 20 merge operations per run
 * - Skip if < 5 memories total
 * - Snapshot IDs at start — new memories inserted during run are ignored
 */

import { query, getDatabase } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';
import { generateEmbedding, embeddingToBuffer, bufferToEmbedding } from '../../../memory/embeddings.js';
import { indexEmbedding } from '../../../memory/vector-search.js';
import { isVectorSearchEnabled } from '../../../api/memory.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('memory-consolidation');

const SIMILARITY_THRESHOLD = 0.85;
const MAX_MERGES_PER_RUN = 20;
const STALE_DAYS = 30;
const MIN_MEMORIES_TO_RUN = 5;

// ── Types ────────────────────────────────────────────────────

interface MemoryRow {
  id: number;
  content: string;
  type: string;
  category: string | null;
  tags: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
  last_accessed: string | null;
}

interface MergeCluster {
  members: MemoryRow[];
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
function buildClusters(memories: MemoryRow[]): MergeCluster[] {
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

        // Check similarity with any existing cluster member
        const sim = cosineSimilarity(withEmbeddings[i]!.vec, withEmbeddings[j]!.vec);
        if (sim >= SIMILARITY_THRESHOLD) {
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

/**
 * Merge a cluster of similar memories into one.
 * Keeps the earliest created_at. Combines all unique tags.
 * Content is the longest member's content (simplest merge strategy).
 */
function mergeCluster(cluster: MergeCluster): {
  content: string;
  type: string;
  category: string | null;
  tags: string[];
  source: string;
  created_at: string;
} {
  const members = cluster.members;

  // Use the longest content as the canonical version
  const longest = members.reduce((a, b) =>
    a.content.length >= b.content.length ? a : b,
  );

  // Collect all unique tags
  const allTags = new Set<string>();
  for (const m of members) {
    const tags: string[] = JSON.parse(m.tags || '[]');
    tags.forEach(t => allTags.add(t));
  }

  // Earliest created_at
  const earliest = members.reduce((a, b) =>
    a.created_at < b.created_at ? a : b,
  );

  return {
    content: longest.content,
    type: longest.type,
    category: longest.category,
    tags: [...allTags],
    source: 'consolidation',
    created_at: earliest.created_at,
  };
}

// ── Stale cleanup ────────────────────────────────────────────

/**
 * Delete episodic memories not accessed in STALE_DAYS days.
 * Returns count of deleted memories.
 */
function cleanStaleEpisodic(): number {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const stale = query<{ id: number }>(
    `SELECT id FROM memories
     WHERE type = 'episodic'
       AND created_at < ?
       AND (last_accessed IS NULL OR last_accessed < ?)`,
    cutoff, cutoff,
  );

  if (stale.length === 0) return 0;

  const ids = stale.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);

  log.info(`Cleaned ${ids.length} stale episodic memories`);
  return ids.length;
}

// ── Main task ────────────────────────────────────────────────

async function run(): Promise<void> {
  if (!isVectorSearchEnabled()) {
    log.info('Vector search not available, skipping consolidation');
    return;
  }

  // Snapshot: get all memories with embeddings at this point in time
  const allMemories = query<MemoryRow>(
    'SELECT id, content, type, category, tags, source, embedding, created_at, last_accessed FROM memories WHERE embedding IS NOT NULL',
  );

  if (allMemories.length < MIN_MEMORIES_TO_RUN) {
    log.info(`Only ${allMemories.length} memories, below threshold of ${MIN_MEMORIES_TO_RUN}. Skipping.`);
    return;
  }

  log.info(`Memory consolidation starting: ${allMemories.length} memories`);

  // 1. Build clusters of similar memories
  const clusters = buildClusters(allMemories);
  log.info(`Found ${clusters.length} merge clusters`);

  // 2. Merge clusters (up to MAX_MERGES_PER_RUN)
  let merged = 0;
  let deleted = 0;
  const db = getDatabase();

  for (const cluster of clusters.slice(0, MAX_MERGES_PER_RUN)) {
    try {
      const result = mergeCluster(cluster);

      // Store merged memory in a transaction
      const tx = db.transaction(() => {
        // Insert merged memory
        const stmt = db.prepare(
          `INSERT INTO memories (content, type, category, tags, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        );
        const insertResult = stmt.run(
          result.content,
          result.type,
          result.category,
          JSON.stringify(result.tags),
          result.source,
          result.created_at,
        );

        const newId = Number(insertResult.lastInsertRowid);

        // Delete originals
        const memberIds = cluster.members.map(m => m.id);
        const placeholders = memberIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...memberIds);

        return { newId, deletedCount: memberIds.length };
      });

      const txResult = tx();
      merged++;
      deleted += txResult.deletedCount;

      // Generate embedding for the merged memory (async, outside transaction)
      try {
        const embedding = await generateEmbedding(result.content);
        const buf = embeddingToBuffer(embedding);
        db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf, txResult.newId);
        indexEmbedding(txResult.newId, embedding);
      } catch {
        log.warn(`Failed to generate embedding for merged memory ${txResult.newId}`);
      }

      log.info(`Merged cluster: ${cluster.members.length} memories → 1 (category: ${result.category})`);
    } catch (err) {
      log.error(`Failed to merge cluster`, {
        memberIds: cluster.members.map(m => m.id),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Clean stale episodic memories
  const staleDeleted = cleanStaleEpisodic();

  // 4. Log summary
  log.info('Memory consolidation complete', {
    totalMemories: allMemories.length,
    clustersFound: clusters.length,
    mergesMade: merged,
    memoriesDeletedViaMerge: deleted,
    staleEpisodicDeleted: staleDeleted,
  });
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('memory-consolidation', async () => {
    await run();
  });
}
