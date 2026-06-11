/**
 * Boot-time URL reachability check.
 * DNS-resolves hostnames of configured relay/community URLs at daemon startup.
 *
 * Motivation: misconfigured relay URLs silently fail at message-send time.
 * Early detection at boot gives the operator a clear, actionable warning.
 *
 * Mechanism:
 *   - Collect network.relay.url and each communities[].primary from config.
 *   - Extract the hostname from each URL (ws://, wss://, http://, https://).
 *   - Skip bare IPv4/IPv6 literals — they can't fail DNS and don't need lookup.
 *   - Skip empty/unset values.
 *   - dns.lookup each remaining hostname. Failures are collected and logged.
 *
 * Warn-only: boot is never blocked or failed. All failures are surfaced on
 * GET /health as `unresolvable_urls` alongside the existing `stale_build` field.
 */

import dns from 'node:dns/promises';
import { createLogger } from './logger.js';
import type { KithkitConfig } from './config.js';

const log = createLogger('boot-url-check');

// ── Types ─────────────────────────────────────────────────────

export interface UnresolvableEntry {
  /** The original URL as written in the config. */
  url: string;
  /** The hostname that failed to resolve. */
  hostname: string;
  /** DNS error message. */
  error: string;
}

export interface BootUrlCheckState {
  /** Whether the check has run at least once since startup. */
  checked: boolean;
  /** Entries that failed DNS resolution. Empty = all URLs resolved. */
  unresolvableUrls: UnresolvableEntry[];
  /** ISO timestamp of the check, or null if never run. */
  checkedAt: string | null;
}

// ── Module-level cached state ──────────────────────────────────

let _state: BootUrlCheckState = {
  checked: false,
  unresolvableUrls: [],
  checkedAt: null,
};

// ── Injectable deps (overridable for testing) ─────────────────

type ResolveFn = (hostname: string) => Promise<void>;

let _resolve: ResolveFn = async (hostname) => {
  await dns.lookup(hostname);
};

let _logWarn: (msg: string, ctx?: Record<string, unknown>) => void =
  (msg, ctx) => log.warn(msg, ctx);

// ── Public API ────────────────────────────────────────────────

/**
 * Get the cached boot URL check state.
 * Synchronous — safe to call from the /health handler.
 */
export function getBootUrlCheckState(): BootUrlCheckState {
  return { ..._state, unresolvableUrls: [..._state.unresolvableUrls] };
}

/**
 * DNS-resolve relay/community hostnames from the daemon config.
 * Called once at daemon startup. Warn-only, non-fatal.
 *
 * Checks:
 *   - config.network.relay.url
 *   - config.network.communities[].primary
 */
export async function runBootUrlCheck(config: KithkitConfig): Promise<BootUrlCheckState> {
  const checkedAt = new Date().toISOString();

  // network config is in the agent-extension section — access via cast.
  // KithkitConfig does not declare `network`; the extension layer adds it.
  const networkConfig = (config as unknown as Record<string, unknown>)['network'] as {
    relay?: { url?: string };
    communities?: Array<{ primary?: string }>;
  } | undefined;

  const candidateUrls: string[] = [];

  // network.relay.url (optional single-relay config)
  const relayUrl = networkConfig?.relay?.url;
  if (typeof relayUrl !== 'string') {
    if (relayUrl != null) {
      _logWarn('boot-url-check: skipping non-string network.relay.url', { value: String(relayUrl) });
    }
  } else if (relayUrl.trim()) {
    candidateUrls.push(relayUrl.trim());
  }

  // network.communities[].primary (multi-community relay URLs)
  for (const community of networkConfig?.communities ?? []) {
    if (typeof community.primary !== 'string') {
      if (community.primary != null) {
        _logWarn('boot-url-check: skipping non-string community primary URL', { value: String(community.primary) });
      }
      continue;
    }
    const primary = community.primary.trim();
    if (primary) candidateUrls.push(primary);
  }

  const unresolvableUrls: UnresolvableEntry[] = [];

  for (const url of candidateUrls) {
    const hostname = extractHostname(url);
    if (!hostname) continue; // bare IP literal or unparseable — skip

    try {
      await _resolve(hostname);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      _logWarn(`boot-url-check: hostname unresolvable at startup — ${hostname}`, {
        url,
        hostname,
        error,
      });
      unresolvableUrls.push({ url, hostname, error });
    }
  }

  if (unresolvableUrls.length === 0) {
    log.debug('boot-url-check: all configured URLs resolved successfully', {
      checked: candidateUrls.length,
    });
  }

  _state = { checked: true, unresolvableUrls, checkedAt };
  return { ..._state, unresolvableUrls: [...unresolvableUrls] };
}

// ── Internals ──────────────────────────────────────────────────

/**
 * Extract the DNS-resolvable hostname from a URL string.
 * Returns null for bare IPv4/IPv6 literals, empty strings, and unparseable values.
 */
export function extractHostname(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;
  if (!hostname) return null;

  // Skip bare IPv4 literals (e.g. 192.168.1.1)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return null;

  // Skip IPv6 literals — URL.hostname strips brackets, leaving colons
  if (hostname.includes(':')) return null;

  return hostname;
}

// ── Testing hooks ──────────────────────────────────────────────

export interface BootUrlCheckTestDeps {
  resolve?: ResolveFn;
  logWarn?: (msg: string, ctx?: Record<string, unknown>) => void;
}

/** @internal Override injectable deps. Pass null to restore originals. */
export function _setDepsForTesting(deps: BootUrlCheckTestDeps | null): void {
  if (deps === null) {
    _resolve = async (hostname) => { await dns.lookup(hostname); };
    _logWarn = (msg, ctx) => log.warn(msg, ctx);
    return;
  }
  if (deps.resolve !== undefined) _resolve = deps.resolve;
  if (deps.logWarn !== undefined) _logWarn = deps.logWarn;
}

/** @internal Reset cached state for test isolation. */
export function _resetStateForTesting(): void {
  _state = { checked: false, unresolvableUrls: [], checkedAt: null };
}
