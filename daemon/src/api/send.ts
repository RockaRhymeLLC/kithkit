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

