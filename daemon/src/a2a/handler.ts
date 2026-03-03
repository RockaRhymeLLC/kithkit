/**
 * Unified A2A HTTP Handler — handles POST /api/a2a/send.
 *
 * Maps router results to HTTP status codes and JSON responses.
 * Registered as a prefix route at /api/a2a/*.
 */

import type http from 'node:http';
import { json } from '../api/helpers.js';
import { parseBody } from '../api/helpers.js';
import type { UnifiedA2ARouter } from './router.js';
import type { ErrorCode } from './types.js';

// ── Error Code -> HTTP Status ────────────────────────────────

export const ERROR_CODE_TO_HTTP: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_TARGET: 400,
  INVALID_ROUTE: 400,
  PEER_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
  DELIVERY_FAILED: 502,
  RELAY_UNAVAILABLE: 503,
  LAN_UNAVAILABLE: 503,
};

// ── Router Instance ──────────────────────────────────────────

let _router: UnifiedA2ARouter | null = null;

export function setA2ARouter(router: UnifiedA2ARouter): void {
  _router = router;
}

// ── Route Handler ────────────────────────────────────────────

/**
 * Handle requests under /api/a2a/*.
 * Returns true if the request was handled, false to pass through.
 */
export async function handleA2ARoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  // Strip the /api/a2a/ prefix to get the subpath
  const subpath = pathname.replace(/^\/api\/a2a\/?/, '');

  if (subpath !== 'send') {
    return false;
  }

  if (req.method !== 'POST') {
    return false;
  }

  if (!_router) {
    json(res, 503, { ok: false, error: 'A2A router not initialized', code: 'RELAY_UNAVAILABLE', timestamp: new Date().toISOString() });
    return true;
  }

  // Parse the request body
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { ok: false, error: 'Invalid JSON', code: 'INVALID_REQUEST', timestamp: new Date().toISOString() });
    return true;
  }

  // Route through the unified router
  const result = await _router.send(body);

  if (result.ok) {
    json(res, 200, result);
  } else {
    const httpStatus = ERROR_CODE_TO_HTTP[result.code] ?? 500;
    json(res, httpStatus, result);
  }

  return true;
}
