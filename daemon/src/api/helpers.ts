/**
 * Shared API helpers — JSON response, timestamp injection, body parsing.
 * Used by all API route handlers.
 */

import type http from 'node:http';

/**
 * Send a JSON response with the given status code.
 */
export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Add a timestamp field to an object.
 */
export function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Parse a JSON request body with a 1MB size limit.
 *
 * If the body was pre-buffered by the metrics middleware (stored as
 * req._rawBody), parses synchronously from that buffer instead of
 * attaching new stream listeners (which would miss already-emitted events).
 */
export function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as unknown as Record<string, unknown>)._rawBody;
  if (pre instanceof Buffer) {
    if (pre.length === 0) return Promise.resolve({});
    try { return Promise.resolve(JSON.parse(pre.toString()) as Record<string, unknown>); }
    catch { return Promise.reject(new Error('Invalid JSON')); }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { reject(new Error('Request body too large')); return; }
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
