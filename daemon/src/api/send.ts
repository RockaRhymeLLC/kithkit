/**
 * Send API — HTTP endpoint for outbound message delivery via channel router.
 *
 * POST /api/send — Deliver a message through configured channels.
 */

import type http from 'node:http';
import { routeMessage } from '../comms/channel-router.js';
import { sendMessage } from '../agents/message-router.js';
import { createLogger } from '../core/logger.js';
import { json, withTimestamp, parseBody } from './helpers.js';

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
      const body = await parseBody(req);

      if (!body.message || typeof body.message !== 'string') {
        json(res, 400, withTimestamp({ error: 'message is required' }));
        return true;
      }

      const channels = Array.isArray(body.channels)
        ? body.channels.filter((c: unknown) => typeof c === 'string') as string[]
        : undefined;

      const results = await routeMessage(
        { text: body.message as string, metadata: body.metadata as Record<string, unknown> | undefined },
        channels,
      );

      // Notify comms about successful external deliveries so it has context when Dave replies
      notifyCommsOfExternalSend(results, body.message as string);

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

// ── Comms notification ──────────────────────────────────────

const MAX_PREVIEW_LENGTH = 120;

/**
 * After a successful external channel delivery, post a brief status message
 * to comms so it has context when Dave replies about the content.
 */
function notifyCommsOfExternalSend(results: Record<string, boolean>, message: string): void {
  const delivered = Object.entries(results)
    .filter(([, ok]) => ok)
    .map(([ch]) => ch);

  if (delivered.length === 0) return;

  const preview = message.length > MAX_PREVIEW_LENGTH
    ? message.slice(0, MAX_PREVIEW_LENGTH) + '…'
    : message;

  const channelList = delivered.join(', ');
  const body = `[daemon sent to ${channelList}] ${preview}`;

  try {
    sendMessage({
      from: 'daemon',
      to: 'comms',
      type: 'status',
      body,
    });
  } catch (err) {
    log.warn('Failed to notify comms of external send', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
