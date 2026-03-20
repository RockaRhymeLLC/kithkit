/**
 * Pre-task memory injection — augments worker prompts with relevant past learnings
 * before spawn so agents can self-correct known failure patterns.
 *
 * Called by spawnWorkerJob in lifecycle.ts when pre_task_injection.enabled is true.
 */

import { getSelfImprovementConfig } from './config.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pre-task-injector');

// ── Constants ────────────────────────────────────────────────

/** Categories that represent self-improvement learnings (not general knowledge). */
const SI_CATEGORIES = ['api-format', 'behavioral', 'process', 'tool-usage', 'communication'];

// ── Helpers ──────────────────────────────────────────────────

/**
 * Format the age of a memory as a human-readable string.
 */
function formatAge(createdAt: string): string {
  const created = new Date(createdAt);
  const diffMs = Date.now() - created.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}

/**
 * Compute a keyword relevance score (0–1) for a memory against a task description.
 * Score = fraction of non-trivial task words found in the memory content.
 * Returns 0.0 if the task description has no qualifying words (length ≥ 3) — no signal means no injection.
 */
function computeScore(taskWords: string[], content: string): number {
  if (taskWords.length === 0) return 0.0;
  const lower = content.toLowerCase();
  const matched = taskWords.filter(w => lower.includes(w)).length;
  return matched / taskWords.length;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Search memories in self-improvement categories that are relevant to the task.
 *
 * @param taskDescription - The worker's task prompt (used for keyword matching)
 * @param maxResults - Maximum number of results to return
 * @param minScore - Minimum relevance score threshold (0–1)
 * @param db - better-sqlite3 Database instance
 */
export async function searchRelevantLearnings(
  taskDescription: string,
  maxResults: number,
  minScore: number,
  db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const placeholders = SI_CATEGORIES.map(() => '?').join(',');

  interface MemRow {
    id: number;
    content: string;
    category: string | null;
    origin_agent: string | null;
    created_at: string;
    tags: string;
  }

  const rows: MemRow[] = db
    .prepare(
      `SELECT id, content, category, origin_agent, created_at, tags
       FROM memories
       WHERE category IN (${placeholders})
       ORDER BY created_at DESC`,
    )
    .all(...SI_CATEGORIES);

  // Tokenise: split on non-alphanumeric, filter to words ≥ 3 chars
  const taskWords = taskDescription
    .trim()
    .split(/\W+/)
    .filter(w => w.length >= 3)
    .map(w => w.toLowerCase());

  const scored = rows
    .map(row => ({
      ...row,
      _relevance_score: computeScore(taskWords, row.content),
    }))
    .filter(r => r._relevance_score >= minScore)
    .sort((a, b) => b._relevance_score - a._relevance_score)
    .slice(0, maxResults);

  return scored;
}

/**
 * Format a list of memories into a structured markdown injection block.
 *
 * Example output:
 * ```
 * ## Known Issues / Past Learnings
 * - [api-format, from: bmo, 3 days ago] A2A payload uses field text not body
 * - [process, from: skippy, 12 days ago] Always check daemon health before spawning workers
 * ```
 */
export function formatInjection(memories: any[]): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (memories.length === 0) return '';

  const items = memories.map(m => {
    const category = m.category ?? 'unknown';
    const origin = m.origin_agent ? `from: ${m.origin_agent}` : 'from: unknown';
    const age = m.created_at ? formatAge(m.created_at) : 'unknown';
    return `- [${category}, ${origin}, ${age}] ${m.content}`;
  });

  return `## Known Issues / Past Learnings\n${items.join('\n')}`;
}

/**
 * Main entry point — augment a worker prompt with relevant past learnings.
 *
 * Checks config, fetches relevant memories, formats and prepends them to the prompt.
 * Returns the original prompt unchanged if injection is disabled or no memories qualify.
 * Never throws — injection failures must not prevent spawn.
 *
 * @param prompt - Original worker prompt
 * @param profile - Agent profile (may have max_memories_injected override)
 * @param db - better-sqlite3 Database instance
 */
export async function injectLearnings(
  prompt: string,
  profile: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<string> {
  try {
    const cfg = getSelfImprovementConfig();

    if (!cfg.enabled || !cfg.pre_task_injection.enabled) {
      return prompt;
    }

    const maxResults: number =
      (profile.max_memories_injected as number | undefined) ??
      cfg.pre_task_injection.max_memories_injected;
    const minScore = cfg.pre_task_injection.min_relevance_score;

    const memories = await searchRelevantLearnings(prompt, maxResults, minScore, db);

    if (memories.length === 0) {
      return prompt;
    }

    const injection = formatInjection(memories);
    return `${injection}\n\n${prompt}`;
  } catch (err) {
    log.warn(`Pre-task injection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return prompt;
  }
}
