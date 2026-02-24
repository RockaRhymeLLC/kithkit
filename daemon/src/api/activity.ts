/**
 * Agent activity logging — daemon-side observability for agent lifecycle events.
 *
 * Event types: session_start, session_end, task_received, task_completed,
 *              context_checkpoint, error, shutdown_reason
 */

import { insert, query } from '../core/db.js';

// ── Valid event types ────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  'session_start',
  'session_end',
  'task_received',
  'task_completed',
  'context_checkpoint',
  'error',
  'shutdown_reason',
]);

// ── Types ────────────────────────────────────────────────────

export interface ActivityEntry {
  id: number;
  agent_id: string;
  session_id: string | null;
  event_type: string;
  details: string | null;
  created_at: string;
}

export interface LogActivityInput {
  agent_id: string;
  session_id?: string;
  event_type: string;
  details?: string;
}

export interface GetActivityOptions {
  sessionId?: string;
  eventType?: string;
  limit?: number;
}

// ── Operations ───────────────────────────────────────────────

/**
 * Log an activity event for an agent.
 */
export function logActivity(input: LogActivityInput): ActivityEntry {
  if (!VALID_EVENT_TYPES.has(input.event_type)) {
    throw new Error(
      `Invalid event_type "${input.event_type}" — must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`,
    );
  }

  return insert<ActivityEntry>('agent_activity_log', {
    agent_id: input.agent_id,
    session_id: input.session_id ?? null,
    event_type: input.event_type,
    details: input.details ?? null,
  });
}

/**
 * Get activity events for an agent, with optional filters.
 */
export function getActivity(
  agentId: string,
  options: GetActivityOptions = {},
): ActivityEntry[] {
  const { sessionId, eventType, limit = 100 } = options;

  const conditions: string[] = ['agent_id = ?'];
  const params: unknown[] = [agentId];

  if (sessionId) {
    conditions.push('session_id = ?');
    params.push(sessionId);
  }

  if (eventType) {
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new Error(
        `Invalid event_type filter "${eventType}" — must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`,
      );
    }
    conditions.push('event_type = ?');
    params.push(eventType);
  }

  const safeLimit = Math.min(Math.max(1, limit), 1000);
  params.push(safeLimit);

  return query<ActivityEntry>(
    `SELECT * FROM agent_activity_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ...params,
  );
}
