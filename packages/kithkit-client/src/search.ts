/**
 * Catalog Search — fetch, cache, verify, and search the Kithkit skill index.
 *
 * CatalogCache  — local JSON cache with TTL
 * verifyAndParseIndex — Ed25519 signature verification (no cross-package deps)
 * searchCatalog — filter by text / tag / capability
 * formatSearchResults — human-readable output
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { SignedCatalogIndex, CachedIndex, SearchQuery, SearchResult } from './types.ts';

// ---------------------------------------------------------------------------
// Canonical JSON (same algorithm as catalog's index-builder — sorted keys,
// no whitespace, deterministic for any given object).
// ---------------------------------------------------------------------------

function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

// ---------------------------------------------------------------------------
// CatalogCache — local index cache with configurable TTL
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class CatalogCache {
  private readonly cacheFile: string;
  private readonly ttlMs: number;

  constructor(cacheDir: string, ttlMs: number = DEFAULT_TTL_MS) {
    this.cacheFile = join(cacheDir, 'index-cache.json');
    this.ttlMs = ttlMs;
  }

  /**
   * Returns the cached index if it is fresh (within TTL), otherwise calls
   * fetchFn to get a new index, caches it, and returns it.
   */
  async getIndex(fetchFn: () => Promise<SignedCatalogIndex>): Promise<SignedCatalogIndex> {
    // Try to read existing cache
    let cached: CachedIndex | null = null;
    try {
      const raw = await readFile(this.cacheFile, 'utf8');
      cached = JSON.parse(raw) as CachedIndex;
    } catch {
      // Cache miss or corrupt — will fetch below
    }

    const now = Date.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.index;
    }

    // Cache miss or stale — fetch fresh
    const index = await fetchFn();

    // Persist to cache (ensure directory exists)
    await mkdir(join(this.cacheFile, '..'), { recursive: true });
    const entry: CachedIndex = { fetchedAt: now, index };
    await writeFile(this.cacheFile, JSON.stringify(entry), 'utf8');

    return index;
  }

  /**
   * Clears the cached index (forces a re-fetch on next getIndex call).
   */
  async invalidate(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.cacheFile);
    } catch {
      // File may not exist — that's fine
    }
  }
}

// ---------------------------------------------------------------------------
// verifyAndParseIndex — verify Ed25519 signature on a signed catalog index
// ---------------------------------------------------------------------------

export interface VerifySuccess {
  valid: true;
  index: SignedCatalogIndex;
}

export interface VerifyFailure {
  valid: false;
  error: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;

/**
 * Verify a signed catalog index against the catalog authority's public key.
 *
 * The signature covers the canonical JSON of { version, updated, skills }
 * (i.e. the index without the `signature` field), using Ed25519.
 *
 * Returns { valid: true, index } on success, or { valid: false, error } on failure.
 */
export function verifyAndParseIndex(
  signedIndex: SignedCatalogIndex,
  publicKeyBase64: string,
): VerifyResult {
  try {
    const { signature, ...index } = signedIndex;

    // Canonical JSON of the index fields (no signature)
    const canonical = canonicalJson(index);
    const data = Buffer.from(canonical, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'base64');

    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const ok = cryptoVerify(null, data, keyObject, signatureBuffer);
    if (!ok) {
      return { valid: false, error: 'Signature verification failed — index may have been tampered with' };
    }

    return { valid: true, index: signedIndex };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Verification error: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// searchCatalog — filter skills by text / tag / capability (AND-ed)
// ---------------------------------------------------------------------------

/**
 * Search/filter skills in a signed catalog index.
 *
 * Filters:
 *   text       — substring match on name or description (case-insensitive)
 *   tag        — exact match against skill tags array
 *   capability — exact match against capabilities.required array
 *
 * All supplied filters must match (AND logic).
 * Returns an array of SearchResult (latest version details).
 */
export function searchCatalog(index: SignedCatalogIndex, query: SearchQuery): SearchResult[] {
  const { text, tag, capability } = query;
  const hasFilters = text !== undefined || tag !== undefined || capability !== undefined;

  const results: SearchResult[] = [];

  for (const skill of index.skills) {
    // Text filter — case-insensitive substring on name or description
    if (text !== undefined) {
      const needle = text.toLowerCase();
      const inName = skill.name.toLowerCase().includes(needle);
      const inDesc = skill.description.toLowerCase().includes(needle);
      if (!inName && !inDesc) continue;
    }

    // Tag filter — exact match
    if (tag !== undefined) {
      if (!skill.tags.includes(tag)) continue;
    }

    // Capability filter — exact match in required list
    if (capability !== undefined) {
      if (!skill.capabilities.required.includes(capability)) continue;
    }

    // Build result with latest version info
    const latestVersion = skill.versions[skill.latest];
    results.push({
      name: skill.name,
      description: skill.description,
      version: skill.latest,
      trust_level: skill.trust_level,
      capabilities: skill.capabilities,
      tags: skill.tags,
      author: skill.author,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// formatSearchResults — human-readable output string
// ---------------------------------------------------------------------------

const TRUST_LABELS: Record<string, string> = {
  'first-party': '[first-party]',
  'verified': '[verified]',
  'community': '[community]',
};

/**
 * Format search results for display.
 *
 * Shows each skill's name, version, trust level, description, capabilities,
 * and tags. Returns "No matching skills found." if the results array is empty.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No matching skills found.';
  }

  const lines: string[] = [];

  for (const result of results) {
    const trustLabel = TRUST_LABELS[result.trust_level] ?? `[${result.trust_level}]`;
    lines.push(`${result.name} v${result.version} ${trustLabel}`);
    lines.push(`  ${result.description}`);

    const requiredCaps = result.capabilities.required.join(', ');
    const optionalCaps = result.capabilities.optional?.join(', ');
    if (optionalCaps) {
      lines.push(`  capabilities: ${requiredCaps} (optional: ${optionalCaps})`);
    } else {
      lines.push(`  capabilities: ${requiredCaps}`);
    }

    lines.push(`  tags: ${result.tags.join(', ')}`);
    lines.push('');
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}
