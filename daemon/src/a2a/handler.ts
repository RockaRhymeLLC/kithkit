/**
 * HTTP route handler for the unified A2A send endpoint.
 * Route: POST /api/a2a/send
 */

import type http from 'node:http';
import { json, parseBody } from '../api/helpers.js';
import type { UnifiedA2ARouter } from './router.js';
import type { A2ASendError } from './types.js';

const ERROR_CODE_TO_HTTP: Record<string, number> = {
  INVALID_REQUEST: 400,
  INVALID_TARGET: 400,
  INVALID_ROUTE: 400,
  PEER_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
  DELIVERY_FAILED: 502,
  RELAY_UNAVAILABLE: 503,
  LAN_UNAVAILABLE: 503,
};

let _router: UnifiedA2ARouter | null = null;

export function setA2ARouter(router: UnifiedA2ARouter): void {
  _router = router;
}

export async function handleA2ARoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  const subpath = pathname.replace(/^\/api\/a2a\/?/, '');

  if (subpath === 'send' && req.method === 'POST') {
    if (!_router) {
      json(res, 503, { ok: false, error: 'A2A router not initialized', code: 'RELAY_UNAVAILABLE', timestamp: new Date().toISOString() });
      return true;
    }

    try {
      const body = await parseBody(req);
      const result = await _router.send(body);

      if (result.ok) {
        json(res, 200, result);
      } else {
        const status = ERROR_CODE_TO_HTTP[(result as A2ASendError).code] ?? 500;
        json(res, status, result);
      }
    } catch (err) {
      json(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid request',
        code: 'INVALID_REQUEST',
        timestamp: new Date().toISOString(),
      });
    }
    return true;
  }

  return false;
}
