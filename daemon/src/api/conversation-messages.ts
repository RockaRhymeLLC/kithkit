/**
 * Conversation Messages API — read-only access to the conversation_messages table.
 *
 * GET /api/conversation-messages
 *   Query params: direction, date (YYYY-MM-DD), channel, limit
 *   Auth: comms or daemon token (X-Agent-Token header), same as /api/send.
 *
 * PRIVACY: This endpoint returns the agent's private conversation history.
 * It is gated behind the comms/daemon token — same enforcement as /api/send.
 * This data is LOCAL-ONLY and must never be relayed to peers.
 */

import type http from 'node:http';
import { query } from '../core/db.js';
import { json, withTimestamp } from './helpers.js';
import { verifyToken } from '../auth/agent-tokens.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('api-conversation-messages');

interface ConversationMessageRow {
  id: number;
  direction: string;
  channel: string;
  sender: string | null;
  recipient: string | null;
  text: string;
  ts: string;
  chat_id: string | null;
  message_id: string | null;
  metadata: string | null;
  sys_created: string;
}

export async function handleConversationMessagesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (pathname !== '/api/conversation-messages') return false;
  if (req.method !== 'GET') return false;

  // ── Token gate — same pattern as /api/send ───────────────────
  const rawHeader = req.headers['x-agent-token'];
  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!token) {
    json(res, 401, withTimestamp({ error: 'X-Agent-Token header required' }));
    return true;
  }
  const identity = verifyToken(token);
  if (!identity) {
    json(res, 401, withTimestamp({ error: 'Invalid or revoked agent token' }));
    return true;
  }
  if (identity.role !== 'comms' && identity.role !== 'daemon') {
    json(res, 403, withTimestamp({
      error: 'Only comms and daemon roles may access conversation history.',
      role: identity.role,
    }));
    return true;
  }
  // ── End token gate ───────────────────────────────────────────

  try {
    const direction = searchParams.get('direction');
    const date = searchParams.get('date');
    const channel = searchParams.get('channel');
    const limitRaw = searchParams.get('limit');
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 1000) : 100;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (direction) {
      conditions.push('direction = ?');
      params.push(direction);
    }
    if (date) {
      conditions.push("date(ts) = ?");
      params.push(date);
    }
    if (channel) {
      conditions.push('channel = ?');
      params.push(channel);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM conversation_messages ${where} ORDER BY ts ASC LIMIT ?`;
    params.push(limit);

    const rows = query<ConversationMessageRow>(sql, ...params);

    log.debug('conversation-messages query', { direction, date, channel, limit, count: rows.length });

    json(res, 200, withTimestamp({
      rows,
      count: rows.length,
    }));
    return true;
  } catch (err) {
    log.error('conversation-messages: query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, withTimestamp({ error: 'Internal error' }));
    return true;
  }
}
