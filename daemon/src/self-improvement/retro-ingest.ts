/**
 * Retro Learnings Ingest — closes the retro → memory → injection feedback loop.
 *
 * The retro worker profile is deliberately sandboxed (tools: [Read, Grep];
 * Bash/Edit/Write disallowed), so it cannot store its own learnings. Its
 * profile says it outputs JSON learnings "for the caller to store" — but no
 * caller existed: the orchestrator that nominally spawned it is often already
 * dead (retros frequently fire precisely BECAUSE the orchestrator died), and
 * nothing in the daemon parsed completed retro jobs. Every learning the retro
 * loop produced sat unread in worker_jobs.result and the pre-task injector
 * never saw it. This module is the missing ingestion step.
 *
 * Registered at daemon startup via registerRetroIngest() (addOnJobComplete).
 * When a retro-profile job completes, the listener parses the JSON learnings
 * block from the result (tolerant of code fences and surrounding prose),
 * validates each learning against the self-improvement categories, caps the
 * count at retro.max_learnings_per_retro, and persists them via
 * storeMemoryInternal — making them visible to pre-task injection.
 *
 * Never throws — ingestion failure must not affect the job lifecycle.
 */

import { addOnJobComplete } from '../agents/lifecycle.js';
import type { JobRecord } from '../agents/lifecycle.js';
import { query } from '../core/db.js';
import { storeMemoryInternal } from '../api/memory.js';
import { getSelfImprovementConfig } from './config.js';
import { SI_CATEGORIES } from './pre-task-injector.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('retro-ingest');

// ── Constants ────────────────────────────────────────────────

/** Profiles whose completed output is treated as retro learnings JSON. */
const RETRO_PROFILES = ['retro', 'retro-light'];

/** Hard ceiling on a single learning's length (chars). Longer entries are
 * truncated — unbounded content would bloat every injected worker prompt. */
const MAX_LEARNING_LENGTH = 500;

/** Hard ceiling on learnings parsed from one retro, regardless of config —
 * defense against a malformed/hostile result flooding the memory store. */
const ABSOLUTE_MAX_LEARNINGS = 20;

// ── Types ────────────────────────────────────────────────────

export interface RetroLearning {
  content: string;
  category: string;
  tags: string[];
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Extract a JSON object from free-form worker output.
 * Tries, in order:
 *   1. fenced ```json ... ``` (or bare ``` ... ```) blocks
 *   2. the whole trimmed text
 *   3. the substring from the first '{' to the last '}'
 * Returns null if nothing parses.
 */
function extractJsonObject(text: string): unknown {
  const candidates: string[] = [];

  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    candidates.push(m[1]!.trim());
  }

  candidates.push(text.trim());

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(text.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Parse and validate retro learnings from a worker's result text.
 * Invalid items (missing content, unknown category) are skipped with a log
 * line — a bad item must not block valid siblings.
 */
export function parseRetroLearnings(resultText: string): RetroLearning[] {
  const obj = extractJsonObject(resultText);
  if (!obj || typeof obj !== 'object') return [];

  const learningsRaw = (obj as Record<string, unknown>)['learnings'];
  if (!Array.isArray(learningsRaw)) return [];

  const learnings: RetroLearning[] = [];

  for (const item of learningsRaw.slice(0, ABSOLUTE_MAX_LEARNINGS)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;

    const contentRaw = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!contentRaw) {
      log.warn('parseRetroLearnings: skipping learning with empty/missing content');
      continue;
    }
    const content = contentRaw.length > MAX_LEARNING_LENGTH
      ? `${contentRaw.slice(0, MAX_LEARNING_LENGTH - 1)}…`
      : contentRaw;

    const category = typeof rec.category === 'string' ? rec.category.trim() : '';
    if (!SI_CATEGORIES.includes(category)) {
      log.warn('parseRetroLearnings: skipping learning with invalid category', {
        category: category || '(missing)',
        contentPreview: content.slice(0, 80),
      });
      continue;
    }

    const providedTags = Array.isArray(rec.tags)
      ? rec.tags.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 10)
      : [];
    const tags = [...new Set(['retro', 'self-improvement', ...providedTags])];

    learnings.push({ content, category, tags });
  }

  return learnings;
}

// ── Ingestion ────────────────────────────────────────────────

/**
 * Ingest learnings from a terminal retro job. Returns the number of memories
 * stored. Exported for testing; registered callers go through
 * registerRetroIngest(). Never throws.
 */
export async function ingestRetroResult(job: JobRecord): Promise<number> {
  try {
    if (!RETRO_PROFILES.includes(job.profile)) return 0;

    const cfg = getSelfImprovementConfig();
    if (!cfg.enabled || !cfg.retro.enabled) return 0;

    if (job.status !== 'completed') {
      // failed/timeout retro output is untrustworthy — log so the gap is visible
      log.warn('Retro job ended non-completed — learnings not ingested', {
        jobId: job.id,
        status: job.status,
        error: job.error ?? undefined,
      });
      return 0;
    }

    if (!job.result || job.result.trim() === '') {
      log.warn('Retro job completed with empty result — no learnings to ingest', { jobId: job.id });
      return 0;
    }

    const parsed = parseRetroLearnings(job.result);
    if (parsed.length === 0) {
      // This was the old silent-failure mode — make it loud.
      log.warn('Retro job completed but no valid learnings could be parsed from its result', {
        jobId: job.id,
        resultPreview: job.result.slice(0, 200),
      });
      return 0;
    }

    const capped = parsed.slice(0, cfg.retro.max_learnings_per_retro);

    let stored = 0;
    for (const learning of capped) {
      try {
        await storeMemoryInternal({
          content: learning.content,
          category: learning.category,
          tags: learning.tags,
          source: `retro:${job.id}`,
          origin_agent: 'retro',
          // trigger drives /api/self-improvement/stats (it counts learnings
          // by memories.trigger) — without it, ingested learnings are
          // invisible to the stats surface and the loop looks dead even
          // when it is working.
          trigger: 'retro',
          dedup: true,
        });
        stored++;
      } catch (err) {
        log.warn('Failed to store retro learning', {
          jobId: job.id,
          error: String(err),
          contentPreview: learning.content.slice(0, 80),
        });
      }
    }

    log.info('Retro learnings ingested', {
      jobId: job.id,
      parsed: parsed.length,
      stored,
      capped: parsed.length > capped.length,
    });
    return stored;
  } catch (err) {
    log.warn('Retro ingestion failed (non-fatal)', { jobId: job.id, error: String(err) });
    return 0;
  }
}

// ── Backfill ─────────────────────────────────────────────────

export interface BackfillResult {
  scanned: number;
  already_ingested: number;
  ingested_jobs: number;
  stored_learnings: number;
  no_learnings: number;
  dry_run: boolean;
}

/**
 * Backfill-ingest historical retro jobs whose learnings were never stored.
 *
 * Before the ingest listener existed (retro-ingest.ts, Round 3), every retro
 * worker's JSON learnings sat unread in worker_jobs.result. This walks those
 * completed retro jobs (oldest first, so memory chronology mirrors reality)
 * and runs the same ingestion path over each.
 *
 * Idempotent: jobs that already produced at least one memory (matched by
 * source = 'retro:<jobId>') are skipped — the 5-minute dedup window inside
 * storeMemoryInternal is far too short to protect a backfill re-run.
 *
 * dryRun parses and counts without storing. `limit` bounds one invocation so
 * a large backlog can be chewed in batches.
 */
export async function backfillRetroLearnings(opts: {
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? false;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));

  const placeholders = RETRO_PROFILES.map(() => '?').join(',');
  const jobs = query<JobRecord>(
    `SELECT * FROM worker_jobs
     WHERE profile IN (${placeholders})
       AND status = 'completed'
       AND result IS NOT NULL AND result != ''
     ORDER BY created_at ASC
     LIMIT ?`,
    ...RETRO_PROFILES,
    limit,
  );

  const result: BackfillResult = {
    scanned: jobs.length,
    already_ingested: 0,
    ingested_jobs: 0,
    stored_learnings: 0,
    no_learnings: 0,
    dry_run: dryRun,
  };

  for (const job of jobs) {
    const existing = query<{ id: number }>(
      `SELECT id FROM memories WHERE source = ? LIMIT 1`,
      `retro:${job.id}`,
    );
    if (existing.length > 0) {
      result.already_ingested++;
      continue;
    }

    if (dryRun) {
      const parsed = parseRetroLearnings(job.result ?? '');
      const cap = getSelfImprovementConfig().retro.max_learnings_per_retro;
      if (parsed.length > 0) {
        result.ingested_jobs++;
        result.stored_learnings += Math.min(parsed.length, cap);
      } else {
        result.no_learnings++;
      }
      continue;
    }

    const stored = await ingestRetroResult(job);
    if (stored > 0) {
      result.ingested_jobs++;
      result.stored_learnings += stored;
    } else {
      result.no_learnings++;
    }
  }

  log.info('Retro backfill complete', { ...result });
  return result;
}

/**
 * Register the retro-learnings ingest as a job-complete listener.
 * Call once at daemon startup, AFTER any setOnJobComplete() call (that
 * back-compat shim clears the listener list).
 */
export function registerRetroIngest(): void {
  addOnJobComplete((job: JobRecord) => {
    void ingestRetroResult(job);
  });
  log.info('retro-ingest: registered');
}
