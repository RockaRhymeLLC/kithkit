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
 */
export function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
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
