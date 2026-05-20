/**
 * Send API — HTTP endpoint for outbound message delivery via channel router.
 *
 * POST /api/send — Deliver a message through configured channels.
 */

import type http from 'node:http';
import { routeMessage, listAdapters } from '../comms/channel-router.js';
import { sendMessage } from '../agents/message-router.js';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp, parseBody } from './helpers.js';
import { verifyToken } from '../auth/agent-tokens.js';

const log = createLogger('api-send');

// ── Route handler ────────────────────────────────────────────

export async function handleSendRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    if (pathname === '/api/send' && method === 'POST') {
      // ── Role gate ─────────────────────────────────────────────
      // Only the comms agent may deliver messages to human channels.
      // Workers and orchestrators must escalate via /api/messages.
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
      if (identity.role !== 'comms') {
        json(res, 403, withTimestamp({
          error: 'Workers and orchestrators cannot send to human channels. Escalate via /api/messages (worker → orchestrator → comms → human).',
          role: identity.role,
        }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.message || typeof body.message !== 'string') {
        json(res, 400, withTimestamp({ error: 'message is required' }));
        return true;
      }

      // Accept either channels (array) or channel (singular string) — both documented.
      // Previously, a singular 'channel' field was silently ignored causing broadcast to all adapters.
      const channels: string[] | undefined = Array.isArray(body.channels)
        ? body.channels.filter((c: unknown) => typeof c === 'string') as string[]
        : typeof body.channel === 'string'
          ? [body.channel]
          : undefined;

      // Validate requested channels exist — return 400 for unknown channels rather
      // than silently falling through with empty results (addresses kithkit #60).
      if (channels && channels.length > 0) {
        const registered = new Set(listAdapters());
        const unknown = channels.filter(c => !registered.has(c));
        if (unknown.length > 0) {
          json(res, 400, withTimestamp({
            error: `Unknown channel(s): ${unknown.join(', ')}. Registered: ${[...registered].join(', ') || 'none'}`,
          }));
          return true;
        }
      }

      // Merge top-level chat_id into metadata so the Telegram adapter receives it.
      // Explicit metadata.chatId from the caller takes precedence over top-level chat_id.
      const metadata: Record<string, unknown> = {
        ...(body.metadata as Record<string, unknown> | undefined),
      };
      if (typeof body.chat_id === 'string' && !metadata.chatId) {
        metadata.chatId = body.chat_id;
      }

      const results = await routeMessage(
        { text: body.message as string, metadata },
        channels,
      );

      // Success = silent (comms already knows it sent). Failure = notify comms.
      const failed = Object.entries(results).filter(([, ok]) => !ok).map(([ch]) => ch);
      const delivered = Object.entries(results).filter(([, ok]) => ok).map(([ch]) => ch);

      if (delivered.length > 0) {
        log.debug('Delivered to channels', { channels: delivered });
      }

      if (failed.length > 0) {
        const channelList = failed.join(', ');
        const preview = (body.message as string).length > 120
          ? (body.message as string).slice(0, 120) + '…'
          : body.message as string;
        try {
          sendMessage({
            from: 'daemon',
            to: 'comms',
            type: 'error',
            body: `[delivery failed: ${channelList}] ${preview}`,
          });
        } catch (notifyErr) {
          log.warn('Failed to notify comms of delivery failure', {
            error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          });
        }
      }

      // Return 502 only when every channel attempted delivery and all failed.
      // Partial success (some channels delivered) still returns 200.
      const resultValues = Object.values(results);
      const allFailed = resultValues.length > 0 && resultValues.every(v => v === false);
      if (allFailed) {
        json(res, 502, withTimestamp({ error: 'All delivery channels failed', results }));
        return true;
      }

      json(res, 200, withTimestamp({ results }));
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Request body too large') {
        json(res, 413, withTimestamp({ error: 'Request body too large' }));
        return true;
      }
      if (err.message === 'Invalid JSON') {
        json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
        return true;
      }
    }
    throw err;
  }
}

