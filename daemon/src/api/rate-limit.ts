/**
 * Simple in-memory sliding-window rate limiter.
 * Tracks request timestamps per key and rejects when the window limit is exceeded.
 */

import type http from 'node:http';
import { json, withTimestamp } from './helpers.js';

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

/**
 * Create a rate-limit guard for a specific route.
 * @param key — unique identifier for this limiter (e.g. 'spawn', 'escalate')
 * @param max — max requests allowed in the window
 * @param windowMs — window size in milliseconds (default 60_000 = 1 minute)
 * @returns a function that returns true if the request is allowed, false if rate-limited (and sends 429)
 */
export function createRateLimiter(
  key: string,
  max: number,
  windowMs: number = 60_000,
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return (_req, res) => {
    const now = Date.now();
    let entry = windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      windows.set(key, entry);
    }

    // Slide: remove timestamps older than the window
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= max) {
      const retryAfter = Math.ceil(
        (entry.timestamps[0]! + windowMs - now) / 1000,
      );
      res.setHeader('Retry-After', String(retryAfter));
      json(res, 429, withTimestamp({
        error: 'Too many requests',
        retry_after_seconds: retryAfter,
      }));
      return false; // blocked
    }

    entry.timestamps.push(now);
    return true; // allowed
  };
}

/** Reset all limiters — useful for testing. */
export function resetAllLimiters(): void {
  windows.clear();
}
