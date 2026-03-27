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

import * as path from 'node:path';
import * as fs from 'node:fs';
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

// ── Story 2: Path Validation + Skill File Writes ─────────────

/** Maximum content size for a single skill reference append (2KB). */
const MAX_APPEND_SIZE = 2048;

/**
 * Validate and resolve a skill write target path.
 * Returns the absolute path to reference.md if valid, null if rejected.
 * All rejections are logged at warn level.
 */
export function validateSkillWritePath(targetSkill: string, projectRoot: string): string | null {
  // 1. Skill name regex: lowercase alphanumeric + hyphens only
  if (!/^[a-z0-9][a-z0-9-]*$/.test(targetSkill)) {
    log.warn('Rejected skill write: invalid skill name', { targetSkill });
    return null;
  }

  // 2. Construct and resolve path
  const targetPath = path.resolve(projectRoot, SKILLS_REL_PATH, targetSkill, 'reference.md');

  // 3. Allowlist prefix check
  const allowedPrefix = path.resolve(projectRoot, SKILLS_REL_PATH) + path.sep;
  if (!targetPath.startsWith(allowedPrefix)) {
    log.warn('Rejected skill write: path escapes skills directory', { targetSkill, targetPath });
    return null;
  }

  // 4. Filename restriction
  if (path.basename(targetPath) !== 'reference.md') {
    log.warn('Rejected skill write: wrong filename', { targetSkill, targetPath });
    return null;
  }

  // 5. Symlink check on skill directory
  const skillDir = path.dirname(targetPath);
  try {
    if (fs.existsSync(skillDir)) {
      const stat = fs.lstatSync(skillDir);
      if (stat.isSymbolicLink()) {
        log.warn('Rejected skill write: skill directory is a symlink', { targetSkill, skillDir });
        return null;
      }
    }
  } catch { /* directory doesn't exist yet — OK, will be created */ }

  return targetPath;
}

/**
 * Append a learned entry to a skill's reference.md file.
 * Creates the file and directory if they don't exist.
 * Entries are added under a `## Learned` section with date.
 */
export function appendToSkillReference(filePath: string, content: string, date: string): boolean {
  // Enforce size cap
  if (content.length > MAX_APPEND_SIZE) {
    log.warn('Skill reference append too large, truncating', {
      path: filePath,
      size: content.length,
      max: MAX_APPEND_SIZE,
    });
    content = content.slice(0, MAX_APPEND_SIZE) + '...';
  }

  const entry = `- **${date}**: ${content}`;
  const learnedHeader = '## Learned';

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (existing.includes(learnedHeader)) {
        // Find the ## Learned section and append after the last entry
        const lines = existing.split('\n');
        const headerIdx = lines.findIndex(l => l.trim() === learnedHeader);
        // Find the end of the Learned section (next ## header or EOF)
        let insertIdx = lines.length;
        for (let i = headerIdx + 1; i < lines.length; i++) {
          if (lines[i].startsWith('## ') && lines[i].trim() !== learnedHeader) {
            insertIdx = i;
            break;
          }
        }
        // Insert before the next section (or at end), with blank line padding
        lines.splice(insertIdx, 0, entry, '');
        fs.writeFileSync(filePath, lines.join('\n'));
      } else {
        // Append a new ## Learned section at the end
        const suffix = existing.endsWith('\n') ? '' : '\n';
        fs.appendFileSync(filePath, `${suffix}\n${learnedHeader}\n\n${entry}\n`);
      }
    } else {
      // Create new file
      fs.writeFileSync(filePath, `# Learned Patterns\n\nAuto-generated by kkit-reflection.\n\n${learnedHeader}\n\n${entry}\n`);
    }

    log.info('Skill reference updated', { path: filePath });
    return true;
  } catch (err) {
    log.warn('Failed to write skill reference', {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Resolve a memory category to a skill directory name using config mapping.
 * Falls back to 'learned-patterns' catch-all for unmapped categories.
 */
function resolveSkillTarget(category: string, mapping: Record<string, string | null>): string {
  const mapped = mapping[category];
  if (mapped) return mapped;
  // null or empty string in mapping = explicitly unmapped, use catch-all
  return 'learned-patterns';
}

// ── Story 3: Action Types + Heuristic Categorizer ───────────

/** Valid action types for reflection categorization. */
const VALID_ACTIONS = ['skill-update', 'memory-keep', 'memory-consolidate', 'memory-expire', 'todo-create', 'no-action'] as const;
type ActionType = typeof VALID_ACTIONS[number];

interface ReflectionAction {
  memory_id: number;
  action: ActionType;
  target_skill?: string;
  content?: string;
  title?: string;
  description?: string;
  priority?: string;
  reason: string;
}

interface CategorizationResult {
  actions: ReflectionAction[];
  patterns: Array<{ theme: string; count: number; recommendation: string }>;
  summary: string;
}

/** Keywords that suggest procedural/how-to knowledge (→ skill-update). */
const PROCEDURAL_KEYWORDS = [
  'always', 'never', 'must', 'use', "don't", 'instead', 'correct format',
  'should be', 'not', 'requires', 'make sure', 'remember to', 'workaround',
];

/** Keywords that suggest transient/one-time events (→ memory-expire). */
const TRANSIENT_KEYWORDS = [
  'tried', 'attempted', 'got error', 'connection refused', 'timed out',
  'was down', 'fixed now', 'resolved', 'one-time', 'temporary',
];

/** Parse a JSON tags string into an array. Returns [] on failure. */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Heuristic categorizer for the scheduler (daemon) path.
 * Uses keyword matching and tag analysis — no LLM needed.
 * The /kkit-reflection skill path uses full LLM categorization instead.
 */
function categorizeMemories(memories: MemoryRow[], config: ReflectionConfig & typeof DEFAULTS): CategorizationResult {
  const actions: ReflectionAction[] = [];
  const contentMap = new Map<string, MemoryRow[]>();

  // Group by normalized content for duplicate detection
  for (const m of memories) {
    const key = m.content.toLowerCase().trim().slice(0, 100);
    const group = contentMap.get(key) ?? [];
    group.push(m);
    contentMap.set(key, group);
  }

  // Detect duplicates/near-duplicates
  const consolidateIds = new Set<number>();
  for (const [, group] of contentMap) {
    if (group.length > 1) {
      // Sort by created_at descending — keep newest
      group.sort((a, b) => b.created_at.localeCompare(a.created_at));
      for (let i = 1; i < group.length; i++) {
        consolidateIds.add(group[i].id);
        actions.push({
          memory_id: group[i].id,
          action: 'memory-consolidate',
          reason: `Near-duplicate of memory ${group[0].id} (keeping newer)`,
        });
      }
    }
  }

  // Categorize remaining memories
  for (const m of memories) {
    if (consolidateIds.has(m.id)) continue; // already handled as consolidation target

    const lower = m.content.toLowerCase();
    const tags = parseTags(m.tags);

    // Check for procedural knowledge → skill-update
    const isProceduralMatch = PROCEDURAL_KEYWORDS.some(kw => lower.includes(kw));
    const hasProceduralTag = tags.some(t => ['procedural', 'api-format', 'tool-usage'].includes(t));

    if (isProceduralMatch || hasProceduralTag) {
      const category = m.category ?? (hasProceduralTag ? (tags.find(t => ['api-format', 'tool-usage', 'behavioral', 'process', 'communication'].includes(t)) ?? '') : '');
      actions.push({
        memory_id: m.id,
        action: 'skill-update',
        target_skill: resolveSkillTarget(category, config.skill_mapping),
        content: m.content,
        reason: isProceduralMatch ? 'Contains procedural keywords' : 'Has procedural tag',
      });
      continue;
    }

    // Check for transient events → memory-expire
    const isTransient = TRANSIENT_KEYWORDS.some(kw => lower.includes(kw));
    const ageMs = Date.now() - new Date(m.created_at).getTime();
    const isOld = ageMs > 7 * 24 * 3600_000; // older than 7 days

    if (isTransient && isOld) {
      actions.push({
        memory_id: m.id,
        action: 'memory-expire',
        reason: 'Transient event, older than 7 days',
      });
      continue;
    }

    // Default: keep
    actions.push({
      memory_id: m.id,
      action: 'memory-keep',
      reason: 'No clear categorization signal — retaining',
    });
  }

  // Build summary
  const counts = new Map<string, number>();
  for (const a of actions) {
    counts.set(a.action, (counts.get(a.action) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([k, v]) => `${v} ${k}`);
  const summary = `Categorized ${memories.length} memories: ${parts.join(', ')}.`;

  return { actions, patterns: [], summary };
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

  // Categorize memories (heuristic for scheduler path)
  const categorization = categorizeMemories(memories, config);

  log.info('kkit-reflection: categorization complete', {
    total: memories.length,
    summary: categorization.summary,
  });

  for (const action of categorization.actions) {
    log.info(`kkit-reflection:${dryRunLabel} action`, {
      memory_id: action.memory_id,
      action: action.action,
      target_skill: action.target_skill,
      reason: action.reason,
    });
  }

  // TODO (Story 4): Execute actions using categorization.actions
  // TODO (Story 5): Generate summary + deliver to comms
  // TODO (Story 6): Pattern detection

  const summary = `${dryRunLabel.trim()} ${categorization.summary} (action execution pending — Stories 2+3 only).`;
  recordRun('success', summary, startedAt);
  return summary;
}

// ── Register ────────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('kkit-reflection', async (ctx) => {
    return run(ctx.config ?? {});
  });
}
