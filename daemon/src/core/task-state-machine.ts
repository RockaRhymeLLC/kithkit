/**
 * Task state machine for the unified task system.
 *
 * Defines the 11 valid statuses, the permitted transitions between them,
 * and the timestamp side-effects that each transition produces.
 *
 * Pure logic only — no HTTP, no database imports.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'proposed'
  | 'pending'
  | 'assigned'
  | 'planning'
  | 'awaiting_approval'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'cancelled';

export interface TransitionSideEffects {
  assigned_at?: string;
  started_at?: string;
  completed_at?: string;
  plan_submitted_at?: string;
  plan_approved_at?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const VALID_STATUSES: readonly TaskStatus[] = [
  'proposed',
  'pending',
  'assigned',
  'planning',
  'awaiting_approval',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'abandoned',
  'cancelled',
];

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed',
  'failed',
  'abandoned',
  'cancelled',
];

/**
 * Common user-friendly status aliases that we accept on input and normalize to
 * the canonical enum value before validation. Case-insensitive on the input.
 *
 * Issue #211: kithkit todo/task API should accept the natural-language forms
 * users actually type. Pure API-boundary normalization — schema and DB rows
 * always carry the canonical value.
 *
 * NOTE: 'blocked' → 'on_hold' was considered, but 'on_hold' is not a valid
 * status and 'blocked' is already canonical, so no alias is needed there.
 */
const STATUS_ALIASES: Readonly<Record<string, TaskStatus>> = {
  done: 'completed',
  wip: 'in_progress',
};

export function normalizeStatusAlias(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const lookup = STATUS_ALIASES[raw.toLowerCase()];
  return lookup ?? raw;
}

/**
 * Private map of all valid transitions.
 * Each key is a "from" status; the value is the set of statuses it may
 * transition to.  Most terminal statuses (completed, abandoned, cancelled)
 * have no outgoing edges.  failed has a retry edge (failed → pending) and
 * corrective escape-valve edges (failed → completed, failed → cancelled) to
 * allow rescue of false-failed-but-actually-done tasks.
 */
const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed:          ['pending', 'cancelled'],
  pending:           ['assigned', 'cancelled'],
  assigned:          ['planning', 'in_progress', 'cancelled'],
  planning:          ['awaiting_approval', 'in_progress'],
  awaiting_approval: ['in_progress', 'planning', 'abandoned'],
  in_progress:       ['blocked', 'completed', 'failed', 'abandoned'],
  blocked:           ['in_progress', 'failed', 'abandoned'],
  // failed has outgoing escape-valve transitions: retry (→pending) + corrective (→completed/cancelled)
  failed:            ['pending', 'completed', 'cancelled'],
  // Truly terminal — no outgoing transitions
  completed:         [],
  abandoned:         [],
  cancelled:         [],
};

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the transition from `from` to `to` is permitted.
 */
export function validateTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (VALID_TRANSITIONS[from] as readonly TaskStatus[]).includes(to);
}

/**
 * Returns the list of statuses that `from` can transition to.
 */
export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return VALID_TRANSITIONS[from];
}

/**
 * Compute the timestamp side-effects produced by a transition.
 *
 * Only includes fields that SHOULD be written:
 * - `assigned_at`       — set when entering `assigned`, but only if currently null
 * - `started_at`        — set when entering `in_progress` for the first time (null guard)
 * - `completed_at`      — set when entering any terminal status
 * - `plan_submitted_at` — set when transitioning planning → awaiting_approval
 * - `plan_approved_at`  — set when transitioning awaiting_approval → in_progress
 *
 * @param from     The current status.
 * @param to       The target status.
 * @param current  The task's current timestamp values (used to enforce "if null" rules).
 * @param now      ISO 8601 string to use as "now"; defaults to new Date().toISOString().
 */
export function getTransitionSideEffects(
  from: TaskStatus,
  to: TaskStatus,
  current: {
    assigned_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
  },
  now: string = new Date().toISOString(),
): TransitionSideEffects {
  const effects: TransitionSideEffects = {};

  // → assigned: set assigned_at if not already set
  if (to === 'assigned' && current.assigned_at == null) {
    effects.assigned_at = now;
  }

  // → in_progress: set started_at only on the first transition (if null)
  if (to === 'in_progress' && current.started_at == null) {
    effects.started_at = now;
  }

  // → any terminal status: always stamp completed_at
  if (to === 'completed' || to === 'failed' || to === 'abandoned' || to === 'cancelled') {
    effects.completed_at = now;
  }

  // planning → awaiting_approval: stamp plan_submitted_at
  if (from === 'planning' && to === 'awaiting_approval') {
    effects.plan_submitted_at = now;
  }

  // awaiting_approval → in_progress (approved): stamp plan_approved_at
  if (from === 'awaiting_approval' && to === 'in_progress') {
    effects.plan_approved_at = now;
  }

  return effects;
}
