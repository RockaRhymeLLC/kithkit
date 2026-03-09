/**
 * Simple in-memory rate limiter using sliding window counters.
 *
 * Tracks request counts per key (typically IP address) within a
 * configurable time window. No external dependencies.
 */

import { createLogger } from './logger.js';

const log = createLogger('rate-limiter');

interface WindowEntry {
  count: number;
  resetAt: number; // Date.now() timestamp when window resets
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private maxRequests: number;
  private windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request from the given key is allowed.
   * Returns true if allowed, false if rate limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      // New window
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    entry.count++;
    if (entry.count > this.maxRequests) {
      log.warn('Rate limit exceeded', { key, count: entry.count, limit: this.maxRequests });
      return false;
    }

    return true;
  }

  /**
   * Get remaining requests for a key.
   */
  remaining(key: string): number {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || now >= entry.resetAt) return this.maxRequests;
    return Math.max(0, this.maxRequests - entry.count);
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.windows) {
        if (now >= entry.resetAt) {
          this.windows.delete(key);
        }
      }
    }, intervalMs);
  }

  /**
   * Stop cleanup and clear all entries.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}
