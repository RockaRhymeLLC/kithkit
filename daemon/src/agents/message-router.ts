/**
 * Inter-agent message router.
 *
 * Routes messages between agents via HTTP POST. Messages to persistent agents
 * (comms/orchestrator) are injected via tmux. Messages to workers are stored
 * for pull. All messages logged in SQLite messages table.
 *
 * Workers can only send result or error type messages.
 */

import { insert, query, exec } from '../core/db.js';
import { injectMessage } from './tmux.js';
import { notifyNewMessage } from '../automation/tasks/message-delivery.js';

// ── Types ────────────────────────────────────────────────────

export type MessageType = 'text' | 'task' | 'result' | 'error' | 'status';

export interface Message {
  id: number;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  body: string;
  metadata: string | null;
  processed_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SendMessageRequest {
  from: string;
  to: string;
  type: MessageType;
  body: string;
  metadata?: Record<string, unknown>;
}

const VALID_MESSAGE_TYPES: MessageType[] = ['text', 'task', 'result', 'error', 'status'];
const WORKER_ALLOWED_TYPES: MessageType[] = ['result', 'error'];

// ── Tmux injection (injectable for testing) ──────────────────

type TmuxInjector = (session: string, text: string) => boolean;

let tmuxInjector: TmuxInjector = defaultTmuxInjector;

function defaultTmuxInjector(agentId: string, text: string): boolean {
  return injectMessage(agentId, text);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Send a message between agents. Logs to DB and routes to target.
 */
export function sendMessage(req: SendMessageRequest): { messageId: number; delivered: boolean } {
  // Validate type
  if (!VALID_MESSAGE_TYPES.includes(req.type)) {
    throw new MessageValidationError(`Invalid message type: ${req.type}`);
  }

  // Enforce worker restrictions
  if (isWorkerAgent(req.from) && !WORKER_ALLOWED_TYPES.includes(req.type)) {
    throw new WorkerRestrictionError(
      `Workers can only send result or error messages, got: ${req.type}`,
    );
  }

  // Insert message into DB
  const message = insert<Message>('messages', {
    from_agent: req.from,
    to_agent: req.to,
    type: req.type,
    body: req.body,
    metadata: req.metadata ? JSON.stringify(req.metadata) : null,
  });

  // Route to target
  if (isPersistentAgent(req.to)) {
    // Queue for delivery — the message-delivery scheduler task handles tmux injection.
    // Trigger the task immediately so delivery doesn't wait for the next interval tick.
    notifyNewMessage();
    return { messageId: message.id, delivered: false };
  }
  // Workers pull their own messages — no active delivery needed

  return { messageId: message.id, delivered: true };
}

/**
 * Get message history for an agent.
 */
export function getMessages(
  agentId: string,
  opts?: { limit?: number; type?: MessageType },
): Message[] {
  let sql = 'SELECT * FROM messages WHERE to_agent = ? OR from_agent = ?';
  const params: unknown[] = [agentId, agentId];

  if (opts?.type) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }

  sql += ' ORDER BY created_at ASC';

  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }

  return query<Message>(sql, ...params);
}

/**
 * Get messages addressed TO an agent with ID greater than sinceId.
 * Used by the orchestrator wrapper to poll for new tasks without relying
 * on read/processed state (avoids race where Claude consumes messages
 * via the API before the wrapper's polling loop runs).
 */
export function getMessagesSince(agentId: string, sinceId: number, type?: MessageType): Message[] {
  let sql = 'SELECT * FROM messages WHERE to_agent = ? AND id > ?';
  const params: unknown[] = [agentId, sinceId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY id ASC';

  return query<Message>(sql, ...params);
}

/**
 * Get unprocessed messages for an agent (pull model).
 */
export function pullMessages(agentId: string): Message[] {
  return query<Message>(
    'SELECT * FROM messages WHERE to_agent = ? AND processed_at IS NULL ORDER BY created_at ASC',
    agentId,
  );
}

/**
 * Mark a message as processed.
 */
export function markProcessed(messageId: number): void {
  exec(
    'UPDATE messages SET processed_at = ? WHERE id = ?',
    new Date().toISOString(), messageId,
  );
}

/**
 * Get unread messages for an agent (read_at IS NULL, already delivered/processed).
 */
export function getUnreadMessages(agentId: string): Message[] {
  return query<Message>(
    `SELECT * FROM messages
     WHERE to_agent = ? AND read_at IS NULL AND processed_at IS NOT NULL
     ORDER BY created_at ASC`,
    agentId,
  );
}

/**
 * Mark messages as read. Sets read_at timestamp.
 */
export function markMessagesRead(messageIds: number[]): void {
  if (messageIds.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = messageIds.map(() => '?').join(',');
  exec(
    `UPDATE messages SET read_at = ? WHERE id IN (${placeholders})`,
    now, ...messageIds,
  );
}

// ── Helpers ──────────────────────────────────────────────────

function isWorkerAgent(agentId: string): boolean {
  return agentId.startsWith('worker-') || agentId.match(/^[0-9a-f]{8}-/) !== null;
}

function isPersistentAgent(agentId: string): boolean {
  return agentId === 'comms' || agentId === 'orchestrator';
}

function formatForTmux(req: SendMessageRequest): string {
  return `[${req.type}] from ${req.from}: ${req.body}`;
}

// ── Errors ───────────────────────────────────────────────────

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

export class WorkerRestrictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRestrictionError';
  }
}

// ── Testing ──────────────────────────────────────────────────

export function _setTmuxInjectorForTesting(fn: TmuxInjector | null): void {
  tmuxInjector = fn ?? defaultTmuxInjector;
}
