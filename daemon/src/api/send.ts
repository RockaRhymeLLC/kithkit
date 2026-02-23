/**
 * Send API — HTTP endpoint for outbound message delivery via channel router.
 *
 * POST /api/send — Deliver a message through configured channels.
 */

import type http from 'node:http';
import { routeMessage } from '../comms/channel-router.js';
import { json, withTimestamp, parseBody } from './helpers.js';

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
