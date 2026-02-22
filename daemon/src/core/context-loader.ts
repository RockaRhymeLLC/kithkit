/**
 * Context loader — structured recent activity summary for session startup.
 *
 * Queries DB for active todos, recent decisions, in-progress work, and
 * recent conversation summaries. Smart filtering by relevance within
 * a configurable context budget (in characters).
 */

import { query } from './db.js';

// ── Types ────────────────────────────────────────────────────

export interface ContextSummary {
  active_todos: TodoSummary[];
  recent_decisions: DecisionSummary[];
  in_progress: InProgressItem[];
  upcoming_calendar: CalendarItem[];
  recent_memories: MemorySummary[];
  token_budget_used: number;
  token_budget_total: number;
}

export interface TodoSummary {
  id: number;
  title: string;
  priority: string;
  status: string;
  due_date: string | null;
}

export interface DecisionSummary {
  key: string;
  value: unknown;
  updated_at: string;
}

export interface InProgressItem {
  id: number;
  title: string;
  priority: string;
  updated_at: string;
}

export interface CalendarItem {
  id: number;
  title: string;
  start_time: string;
  end_time: string | null;
}

export interface MemorySummary {
  id: number;
  content: string;
  category: string | null;
  created_at: string;
}

/** Extension point: custom filter function for agent-specific inclusion rules. */
export type ContextFilter = (summary: ContextSummary) => ContextSummary;

// ── State ────────────────────────────────────────────────────

const _filters: ContextFilter[] = [];

// ── Public API ───────────────────────────────────────────────

/**
 * Register an agent-specific filter for context loading.
 * Filters are applied in registration order.
 */
export function registerContextFilter(filter: ContextFilter): void {
  _filters.push(filter);
}

/**
 * Clear all registered filters (for testing).
 */
export function clearContextFilters(): void {
  _filters.length = 0;
}

/**
 * Load context summary from the database.
 * @param budgetChars - Maximum character budget for the summary (default: 8000)
 */
export function loadContext(budgetChars: number = 8000): ContextSummary {
  let used = 0;

  // 1. Active todos (pending + in_progress), ordered by priority then created_at
  const priorityOrder = "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const activeTodos = query<TodoSummary>(
    `SELECT id, title, priority, status, due_date FROM todos
     WHERE status IN ('pending', 'in_progress')
     ORDER BY ${priorityOrder}, created_at DESC
     LIMIT 20`,
  );
  used += JSON.stringify(activeTodos).length;

  // 2. In-progress items (subset of todos, with placeholder updated_at)
  const inProgress: InProgressItem[] = activeTodos
    .filter(t => t.status === 'in_progress')
    .map(t => ({ id: t.id, title: t.title, priority: t.priority, updated_at: '' }));

  // 3. Recent config changes (decisions) from last 7 days
  const recentDecisions = query<{ key: string; value: string; updated_at: string }>(
    `SELECT key, value, updated_at FROM config
     WHERE updated_at > datetime('now', '-7 days')
     ORDER BY updated_at DESC
     LIMIT 10`,
  ).map(d => ({
    key: d.key,
    value: safeJsonParse(d.value),
    updated_at: d.updated_at,
  }));
  used += JSON.stringify(recentDecisions).length;

  // 4. Upcoming calendar events (next 48 hours)
  const upcomingCalendar = query<CalendarItem>(
    `SELECT id, title, start_time, end_time FROM calendar
     WHERE start_time > datetime('now') AND start_time < datetime('now', '+2 days')
     ORDER BY start_time ASC
     LIMIT 10`,
  );
  used += JSON.stringify(upcomingCalendar).length;

  // 5. Recent memories (last 24 hours, if within 80% of budget)
  let recentMemories: MemorySummary[] = [];
  if (used < budgetChars * 0.8) {
    recentMemories = query<MemorySummary>(
      `SELECT id, content, category, created_at FROM memories
       WHERE created_at > datetime('now', '-1 day')
       ORDER BY created_at DESC
       LIMIT 10`,
    );
    used += JSON.stringify(recentMemories).length;
  }

  // Trim if over budget — drop memories first, then calendar, then decisions
  if (used > budgetChars) {
    if (recentMemories.length > 0) {
      recentMemories = [];
      used =
        JSON.stringify(activeTodos).length +
        JSON.stringify(recentDecisions).length +
        JSON.stringify(upcomingCalendar).length;
    }
    if (used > budgetChars && upcomingCalendar.length > 5) {
      upcomingCalendar.splice(5);
      used =
        JSON.stringify(activeTodos).length +
        JSON.stringify(recentDecisions).length +
        JSON.stringify(upcomingCalendar).length;
    }
  }

  let summary: ContextSummary = {
    active_todos: activeTodos,
    recent_decisions: recentDecisions,
    in_progress: inProgress,
    upcoming_calendar: upcomingCalendar,
    recent_memories: recentMemories,
    token_budget_used: used,
    token_budget_total: budgetChars,
  };

  // Apply registered filters in order
  for (const filter of _filters) {
    summary = filter(summary);
  }

  return summary;
}

// ── Helpers ──────────────────────────────────────────────────

function safeJsonParse(str: string): unknown {
  try { return JSON.parse(str); }
  catch { return str; }
}
