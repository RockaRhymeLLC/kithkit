/**
 * Route registry — extensions register HTTP routes for custom endpoints.
 *
 * Supports exact path matching and prefix matching (trailing /*).
 * Routes are checked in registration order; first match wins.
 * Integrated into the extension system via onRoute().
 */

import http from 'node:http';

// ── Types ───────────────────────────────────────────────────

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
) => Promise<boolean>;

interface RegisteredRoute {
  pattern: string;
  handler: RouteHandler;
  type: 'exact' | 'prefix';
  /** For prefix routes, the path prefix without trailing /* */
  prefix?: string;
}

// ── State ───────────────────────────────────────────────────

const _routes: RegisteredRoute[] = [];

// ── Public API ──────────────────────────────────────────────

/**
 * Register an HTTP route handler.
 *
 * @param pattern Exact path (e.g., '/test/exact') or prefix with wildcard (e.g., '/api/ext/*').
 * @param handler Async function that returns true if it handled the request.
 * @throws If a route with the same pattern is already registered.
 */
export function registerRoute(pattern: string, handler: RouteHandler): void {
  // Check for duplicates
  const existing = _routes.find(r => r.pattern === pattern);
  if (existing) {
    throw new Error(`Route already registered: "${pattern}". Each pattern must be unique.`);
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2); // Remove trailing /*
    _routes.push({ pattern, handler, type: 'prefix', prefix });
  } else {
    _routes.push({ pattern, handler, type: 'exact' });
  }
}

/**
 * Try to match and handle a request against registered routes.
 * Returns true if a route handled the request, false otherwise.
 */
export async function matchRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  for (const route of _routes) {
    if (route.type === 'exact' && pathname === route.pattern) {
      const handled = await route.handler(req, res, pathname, searchParams);
      if (handled) return true;
    } else if (route.type === 'prefix' && route.prefix && (pathname === route.prefix || pathname.startsWith(route.prefix + '/'))) {
      const handled = await route.handler(req, res, pathname, searchParams);
      if (handled) return true;
    }
  }
  return false;
}

/**
 * Get list of registered route patterns (for health/debug output).
 */
export function getRegisteredRoutes(): string[] {
  return _routes.map(r => r.pattern);
}

/**
 * Reset all registered routes (for testing).
 */
export function _resetRoutesForTesting(): void {
  _routes.length = 0;
}
