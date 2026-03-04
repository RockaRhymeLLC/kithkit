/**
 * Orchestrator Messages API — convenient messaging scoped to orchestrator.
 *
 *   GET  /api/orchestrator/messages — Get orchestrator message queue
 *   POST /api/orchestrator/messages — Send from orchestrator (pre-fills from)
 */

import type http from 'node:http';
import { json, withTimestamp, parseBody } from './helpers.js';
import { sendMessage, getMessages } from '../agents/message-router.js';
import type { MessageType } from '../agents/message-router.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('orchestrator-messages');

export async function handleOrchestratorMessagesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (pathname !== '/api/orchestrator/messages') return false;

  try {
    // GET /api/orchestrator/messages — alias for /api/messages?agent=orchestrator
    if (method === 'GET') {
      const limitStr = searchParams.get('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : 50;
      const type = searchParams.get('type') as MessageType | null;

      const messages = getMessages('orchestrator', {
        type: type ?? undefined,
        limit: !isNaN(limit) ? limit : 50,
      });

      json(res, 200, withTimestamp({ data: messages }));
      return true;
    }

    // POST /api/orchestrator/messages — send with pre-filled from
    if (method === 'POST') {
      const body = await parseBody(req);

      if (!body.to || typeof body.to !== 'string') {
        json(res, 400, withTimestamp({ error: 'to is required' }));
        return true;
      }
      if (!body.body || typeof body.body !== 'string') {
        json(res, 400, withTimestamp({ error: 'body is required' }));
        return true;
      }

      const result = sendMessage({
        from: 'orchestrator',  // Pre-filled
        to: body.to as string,
        type: (body.type as MessageType) ?? 'text',
        body: body.body as string,
        metadata: typeof body.metadata === 'object' && body.metadata !== null
          ? body.metadata as Record<string, unknown>
          : undefined,
        direct: body.direct === true,
      });

      log.info('Message sent via orchestrator messages API', {
        to: body.to,
        type: body.type ?? 'text',
        messageId: result.messageId,
      });

      json(res, 200, withTimestamp({
        messageId: result.messageId,
        delivered: result.delivered,
        ...(result.warning ? { warning: result.warning } : {}),
      }));
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
