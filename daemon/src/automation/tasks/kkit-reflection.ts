/**
 * Kkit Reflection — nightly self-improvement loop.
 *
 * Reviews retro memories from the past 24h (or since last run),
 * categorizes learnings, and applies actions (skill updates, memory
 * cleanup, todo creation). Ships as a core scheduler task.
 *
 * Default mode is dry-run — logs what would happen without making changes.
 * Operator sets dry_run: false in config to enable live actions.
 */

import { query, exec } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('kkit-reflection');

/** Base path for skill reference files, relative to project root. */
export const SKILLS_REL_PATH = '.claude/skills';

// ── Config ──────────────────────────────────────────────────

interface ReflectionConfig {
  dry_run?: boolean;
  lookback_hours?: number;
  max_memories_per_run?: number;
  batch_size?: number;
  max_deletes_per_run?: number;
  enabled_actions?: string[];
  pattern_detection?: {
    enabled?: boolean;
    window_days?: number;
    threshold?: number;
  };
  skill_mapping?: Record<string, string | null>;
}

const DEFAULTS: Required<Omit<ReflectionConfig, 'skill_mapping' | 'pattern_detection'>> & {
  pattern_detection: Required<NonNullable<ReflectionConfig['pattern_detection']>>;
  skill_mapping: Record<string, string | null>;
} = {
  dry_run: true,
  lookback_hours: 24,
  max_memories_per_run: 100,
  batch_size: 20,
  max_deletes_per_run: 10,
  enabled_actions: ['skill-update', 'memory-keep', 'memory-consolidate', 'memory-expire', 'todo-create'],
  pattern_detection: { enabled: true, window_days: 7, threshold: 3 },
  skill_mapping: {
    'api-format': 'daemon-api',
    'behavioral': '',
    'process': '',
    'tool-usage': '',
    'communication': '',
  },
};

// ── Types ───────────────────────────────────────────────────

interface MemoryRow {
  id: number;
  content: string;
  category: string | null;
  tags: string | null;
  trigger: string | null;
  source: string | null;
  importance: number | null;
  created_at: string;
}

interface TaskResultRow {
  started_at: string;
}

// ── Helpers ─────────────────────────────────────────────────

function resolveConfig(raw: Record<string, unknown>): ReflectionConfig & typeof DEFAULTS {
  return {
    dry_run: (raw.dry_run as boolean | undefined) ?? DEFAULTS.dry_run,
    lookback_hours: (raw.lookback_hours as number | undefined) ?? DEFAULTS.lookback_hours,
    max_memories_per_run: (raw.max_memories_per_run as number | undefined) ?? DEFAULTS.max_memories_per_run,
    batch_size: (raw.batch_size as number | undefined) ?? DEFAULTS.batch_size,
    max_deletes_per_run: (raw.max_deletes_per_run as number | undefined) ?? DEFAULTS.max_deletes_per_run,
    enabled_actions: (raw.enabled_actions as string[] | undefined) ?? DEFAULTS.enabled_actions,
    pattern_detection: {
      enabled: ((raw.pattern_detection as Record<string, unknown> | undefined)?.enabled as boolean | undefined) ?? DEFAULTS.pattern_detection.enabled,
      window_days: ((raw.pattern_detection as Record<string, unknown> | undefined)?.window_days as number | undefined) ?? DEFAULTS.pattern_detection.window_days,
      threshold: ((raw.pattern_detection as Record<string, unknown> | undefined)?.threshold as number | undefined) ?? DEFAULTS.pattern_detection.threshold,
    },
    skill_mapping: (raw.skill_mapping as Record<string, string | null> | undefined) ?? DEFAULTS.skill_mapping,
  };
}

/**
 * Get the timestamp of the last successful reflection run.
 * Returns null if no previous run exists.
 */
function getLastRunTimestamp(): string | null {
  const rows = query<TaskResultRow>(
    `SELECT started_at FROM task_results
     WHERE task_name = 'kkit-reflection' AND status = 'success'
     ORDER BY started_at DESC LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].started_at : null;
}

/**
 * Gather retro memories since the given timestamp (or lookback window).
 * Filters client-side for trigger='retro' or self-improvement tags,
 * since the memory search API does not support server-side trigger filtering.
 */
function gatherMemories(since: string, limit: number): MemoryRow[] {
  const rows = query<MemoryRow>(
    `SELECT id, content, category, tags, trigger, source, importance, created_at
     FROM memories
     WHERE created_at > ?
     ORDER BY created_at ASC
     LIMIT ?`,
    since,
    limit * 3, // over-fetch to allow for client-side filtering
  );

  // Client-side filter: retro trigger OR self-improvement tag
  return rows.filter((m) => {
    if (m.trigger === 'retro') return true;
    if (m.tags) {
      try {
        const parsed = JSON.parse(m.tags);
        if (Array.isArray(parsed) && parsed.includes('self-improvement')) return true;
      } catch { /* ignore malformed tags */ }
    }
    return false;
  }).slice(0, limit);
}

/**
 * Record the reflection run result in task_results.
 */
function recordRun(status: 'success' | 'failure', output: string, startedAt: string): void {
  exec(
    `INSERT INTO task_results (task_name, status, output, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?)`,
    'kkit-reflection',
    status,
    output,
    startedAt,
    new Date().toISOString(),
  );
}

// ── Main ────────────────────────────────────────────────────

async function run(rawConfig: Record<string, unknown>): Promise<string> {
  const config = resolveConfig(rawConfig);
  const startedAt = new Date().toISOString();
  const dryRunLabel = config.dry_run ? ' [DRY RUN]' : '';

  log.info(`kkit-reflection: starting${dryRunLabel}`, {
    dry_run: config.dry_run,
    lookback_hours: config.lookback_hours,
    max_memories: config.max_memories_per_run,
    max_deletes: config.max_deletes_per_run,
  });

  // Determine lookback window
  const lastRun = getLastRunTimestamp();
  const since = lastRun ?? new Date(Date.now() - config.lookback_hours * 3600_000).toISOString();

  log.info('kkit-reflection: lookback window', {
    since,
    source: lastRun ? 'last successful run' : `${config.lookback_hours}h fallback`,
  });

  // Gather memories
  const memories = gatherMemories(since, config.max_memories_per_run);

  if (memories.length === 0) {
    log.info('kkit-reflection: no retro memories to process');
    const summary = 'No retro memories found in lookback window.';
    recordRun('success', summary, startedAt);
    return summary;
  }

  log.info(`kkit-reflection: found ${memories.length} retro memor${memories.length === 1 ? 'y' : 'ies'} to process`);

  // Log what we found (Story 1 stops here — categorization and action execution come in later stories)
  for (const m of memories) {
    log.debug('kkit-reflection: memory', {
      id: m.id,
      category: m.category,
      trigger: m.trigger,
      content: m.content.slice(0, 100),
      created_at: m.created_at,
    });
  }

  // TODO (Story 3): Categorize memories
  // TODO (Story 4): Execute actions
  // TODO (Story 5): Generate summary + deliver to comms
  // TODO (Story 6): Pattern detection

  const summary = `${dryRunLabel.trim()} Gathered ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} for reflection (categorization and execution pending — Story 1 skeleton only).`;
  recordRun('success', summary, startedAt);
  return summary;
}

// ── Register ────────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('kkit-reflection', async (ctx) => {
    return run(ctx.config ?? {});
  });
}
