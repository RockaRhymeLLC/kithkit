/**
 * Self-improvement API routes.
 *
 * Routes:
 *   GET /api/self-improvement/stats — return aggregated learning stats
 */

import type http from 'node:http';
import { getDatabase } from '../core/db.js';
import { json } from './helpers.js';
import { getSelfImprovementStats } from '../self-improvement/stats.js';

export async function handleSelfImprovementRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/self-improvement/stats') {
    const db = getDatabase();
    const stats = await getSelfImprovementStats(db);
    json(res, 200, stats);
    return true;
  }

  return false;
}
