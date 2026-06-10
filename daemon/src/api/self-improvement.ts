/**
 * Self-improvement API routes.
 *
 * Routes:
 *   GET  /api/self-improvement/stats          — return aggregated learning stats
 *   POST /api/self-improvement/retro-backfill — ingest historical retro jobs
 *        body: { dry_run?: boolean, limit?: number }  (default dry_run=true —
 *        a real backfill writes memories, so it must be requested explicitly
 *        with dry_run: false)
 */

import type http from 'node:http';
import { getDatabase } from '../core/db.js';
import { json, parseBody, withTimestamp } from './helpers.js';
import { getSelfImprovementStats } from '../self-improvement/stats.js';
import { backfillRetroLearnings } from '../self-improvement/retro-ingest.js';

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

  if (req.method === 'POST' && pathname === '/api/self-improvement/retro-backfill') {
    try {
      const body = await parseBody(req).catch(() => ({} as Record<string, unknown>));
      const dryRun = body.dry_run !== false; // safe default: dry run unless explicitly disabled
      const limit = typeof body.limit === 'number' ? body.limit : undefined;
      const result = await backfillRetroLearnings({ dryRun, limit });
      json(res, 200, withTimestamp(result));
    } catch (err) {
      json(res, 500, withTimestamp({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  return false;
}
