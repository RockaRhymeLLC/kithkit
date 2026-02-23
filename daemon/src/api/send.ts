/**
 * Send API — HTTP endpoint for outbound message delivery via channel router.
 *
 * POST /api/send — Deliver a message through configured channels.
 */

import type http from 'node:http';
import { routeMessage } from '../comms/channel-router.js';

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
    if (err instanceof Error && err.message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }
    throw err;
  }
}
