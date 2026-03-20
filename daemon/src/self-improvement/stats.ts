/**
 * Self-improvement statistics aggregator.
 * Queries memories and task activity to produce a snapshot of learning health.
 */

import type Database from 'better-sqlite3';
import { getSelfImprovementConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────

export interface SelfImprovementStats {
  enabled: boolean;
  learnings: {
    total: number;
    by_category: Record<string, number>;
    by_trigger: Record<string, number>;
    by_origin: Record<string, number>;
    created_last_7d: number;
    synced_last_7d: number;
  };
  retros: {
    triggered_last_7d: number;
    learnings_extracted_last_7d: number;
  };
  transcript_reviews: {
    run_last_7d: number;
    learnings_extracted_last_7d: number;
  };
}

// ── Self-improvement trigger list ────────────────────────────

const SI_TRIGGERS = ['retro', 'transcript', 'correction', 'sync', 'manual'];

// ── Stats query ──────────────────────────────────────────────

// TODO: This function uses 9 sequential DB queries. Performance can be improved by
// consolidating into fewer queries using CASE WHEN grouping or CTEs. Deferred for now
// since stats are infrequently requested.
export async function getSelfImprovementStats(db: Database.Database): Promise<SelfImprovementStats> {
  const config = getSelfImprovementConfig();

  const triggerPlaceholders = SI_TRIGGERS.map(() => '?').join(', ');

  // Total learnings: memories with a self-improvement trigger
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories WHERE trigger IN (${triggerPlaceholders})`,
    )
    .get(...SI_TRIGGERS) as { cnt: number };
  const total = totalRow.cnt;

  // By category
  const categoryRows = db
    .prepare(
      `SELECT category, COUNT(*) AS cnt FROM memories
       WHERE trigger IN (${triggerPlaceholders})
       GROUP BY category`,
    )
    .all(...SI_TRIGGERS) as Array<{ category: string | null; cnt: number }>;
  const by_category: Record<string, number> = {};
  for (const row of categoryRows) {
    by_category[row.category ?? ''] = row.cnt;
  }

  // By trigger
  const triggerRows = db
    .prepare(
      `SELECT trigger, COUNT(*) AS cnt FROM memories
       WHERE trigger IN (${triggerPlaceholders})
       GROUP BY trigger`,
    )
    .all(...SI_TRIGGERS) as Array<{ trigger: string | null; cnt: number }>;
  const by_trigger: Record<string, number> = {};
  for (const row of triggerRows) {
    by_trigger[row.trigger ?? ''] = row.cnt;
  }

  // By origin agent
  const originRows = db
    .prepare(
      `SELECT origin_agent, COUNT(*) AS cnt FROM memories
       WHERE trigger IN (${triggerPlaceholders})
       GROUP BY origin_agent`,
    )
    .all(...SI_TRIGGERS) as Array<{ origin_agent: string | null; cnt: number }>;
  const by_origin: Record<string, number> = {};
  for (const row of originRows) {
    by_origin[row.origin_agent ?? ''] = row.cnt;
  }

  // Created last 7 days
  const created7dRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories
       WHERE trigger IN (${triggerPlaceholders})
         AND created_at >= datetime('now', '-7 days')`,
    )
    .get(...SI_TRIGGERS) as { cnt: number };
  const created_last_7d = created7dRow.cnt;

  // Synced last 7 days
  const synced7dRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories
       WHERE trigger = 'sync'
         AND created_at >= datetime('now', '-7 days')`,
    )
    .get() as { cnt: number };
  const synced_last_7d = synced7dRow.cnt;

  // Retros triggered last 7 days: activity entries with stage = 'retro'
  let retros_triggered_7d = 0;
  try {
    const retroRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM orchestrator_task_activity
         WHERE stage = 'retro'
           AND created_at >= datetime('now', '-7 days')`,
      )
      .get() as { cnt: number };
    retros_triggered_7d = retroRow.cnt;
  } catch {
    // Table may not exist in test DBs without full migrations
    retros_triggered_7d = 0;
  }

  // Learnings extracted by retros in last 7 days: memories with trigger='retro' in last 7d
  const retroLearnings7dRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories
       WHERE trigger = 'retro'
         AND created_at >= datetime('now', '-7 days')`,
    )
    .get() as { cnt: number };
  const retro_learnings_7d = retroLearnings7dRow.cnt;

  // Transcript reviews run last 7 days: activity entries with stage = 'transcript_review'
  let transcript_reviews_7d = 0;
  try {
    const txRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM orchestrator_task_activity
         WHERE stage = 'transcript_review'
           AND created_at >= datetime('now', '-7 days')`,
      )
      .get() as { cnt: number };
    transcript_reviews_7d = txRow.cnt;
  } catch {
    transcript_reviews_7d = 0;
  }

  // Transcript review learnings last 7 days
  const txLearnings7dRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM memories
       WHERE trigger = 'transcript'
         AND created_at >= datetime('now', '-7 days')`,
    )
    .get() as { cnt: number };
  const tx_learnings_7d = txLearnings7dRow.cnt;

  return {
    enabled: config.enabled,
    learnings: {
      total,
      by_category,
      by_trigger,
      by_origin,
      created_last_7d,
      synced_last_7d,
    },
    retros: {
      triggered_last_7d: retros_triggered_7d,
      learnings_extracted_last_7d: retro_learnings_7d,
    },
    transcript_reviews: {
      run_last_7d: transcript_reviews_7d,
      learnings_extracted_last_7d: tx_learnings_7d,
    },
  };
}
