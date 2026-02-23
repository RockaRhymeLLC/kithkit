/**
 * Messages API — HTTP endpoints for inter-agent messaging.
 *
 * POST /api/messages     — Send a message between agents
 * GET  /api/messages     — Get message history (filter by agent, type)
 */

import type http from 'node:http';
import {
  sendMessage,
  getMessages,
  MessageValidationError,
  WorkerRestrictionError,
} from '../agents/message-router.js';
import type { MessageType } from '../agents/message-router.js';

// ── Helpers ──────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Request body too large')); return; }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Route handler ────────────────────────────────────────────

export async function handleMessagesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // POST /api/messages
    if (pathname === '/api/messages' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.from || typeof body.from !== 'string') {
        json(res, 400, withTimestamp({ error: 'from is required' }));
        return true;
      }
      if (!body.to || typeof body.to !== 'string') {
        json(res, 400, withTimestamp({ error: 'to is required' }));
        return true;
      }
      if (!body.body || typeof body.body !== 'string') {
        json(res, 400, withTimestamp({ error: 'body is required' }));
        return true;
      }

      try {
        const result = sendMessage({
          from: body.from as string,
          to: body.to as string,
          type: (body.type as MessageType) ?? 'text',
          body: body.body as string,
          metadata: typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined,
        });

        json(res, 200, withTimestamp({
          messageId: result.messageId,
          delivered: result.delivered,
        }));
      } catch (err) {
        if (err instanceof WorkerRestrictionError) {
          json(res, 403, withTimestamp({ error: err.message }));
          return true;
        }
        if (err instanceof MessageValidationError) {
          json(res, 400, withTimestamp({ error: err.message }));
          return true;
        }
        throw err;
      }
      return true;
    }

    // GET /api/messages
    if (pathname === '/api/messages' && method === 'GET') {
      const agent = searchParams.get('agent');
      if (!agent) {
        json(res, 400, withTimestamp({ error: 'agent query parameter is required' }));
        return true;
      }

      const type = searchParams.get('type') as MessageType | null;
      const limitStr = searchParams.get('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const messages = getMessages(agent, {
        type: type ?? undefined,
        limit: limit && !isNaN(limit) ? limit : undefined,
      });

      json(res, 200, withTimestamp({ data: messages }));
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof Error && err.message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }
    throw err;
  }
}
