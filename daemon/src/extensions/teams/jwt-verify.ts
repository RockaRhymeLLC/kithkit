/**
 * Bot Framework JWT verification — inbound webhook auth.
 *
 * The Bot Framework sends a bearer JWT on every inbound Activity POST.
 * This module verifies it using the classic Node.js `crypto` module (not
 * the Web Crypto API), which avoids Web Crypto type issues under the project's
 * ES2022/Node16 tsconfig:
 *
 *   1. Fetch the OpenID Connect metadata from the Bot Framework well-known URL.
 *   2. Retrieve the JWKS (JSON Web Key Set) from the jwks_uri in that metadata.
 *   3. Find the matching key by `kid` (key ID) from the JWT header.
 *   4. Verify the RS256 signature using `crypto.createVerify('SHA256')` and
 *      `crypto.createPublicKey({ format: 'jwk', key: ... })`.
 *   5. Validate standard claims: iss must equal BOT_FRAMEWORK_ISSUER, aud must
 *      equal the bot's app id, and `exp` must not be in the past.
 *
 * CORRECTION NOTE (vs original task spec):
 *   The task spec originally mentioned HMAC for inbound webhook auth. That is
 *   incorrect for the Bot Framework. Bot Framework does NOT use HMAC signatures
 *   on inbound Activities; it issues JWTs signed by its own key service. The
 *   correct verification is RS256 JWT against the Bot Framework JWKS, which is
 *   what this module implements. Reference:
 *   https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 */

import crypto from 'node:crypto';
import { createLogger } from '../../core/logger.js';

const log = createLogger('teams-jwt');

// ── Constants ─────────────────────────────────────────────────────────────────

/** The OIDC discovery endpoint for the Bot Framework token service. */
export const BOT_FRAMEWORK_OPENID_META_URL =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';

/** Expected `iss` (issuer) claim in the JWT. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

// ── JWKS cache ────────────────────────────────────────────────────────────────

interface JwkEntry {
  kid: string;
  /** The RSA public key as a Node.js KeyObject, ready for `createVerify`. */
  publicKey: crypto.KeyObject;
}

interface JwksCache {
  keys: JwkEntry[];
  fetchedAt: number;
}

let _jwksCache: JwksCache | null = null;
const JWKS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Force-clear the JWKS cache (for testing). */
export function _resetJwksCacheForTesting(): void {
  _jwksCache = null;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch JSON from a URL. Exported for test mocking.
 */
export let fetchJson: (url: string) => Promise<unknown> = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchJson: HTTP ${res.status} from ${url}`);
  }
  return res.json();
};

/** Override fetchJson for testing. */
export function _setFetchJson(fn: (url: string) => Promise<unknown>): void {
  fetchJson = fn;
}

// ── JWKS loading ──────────────────────────────────────────────────────────────

interface OidcMeta {
  jwks_uri: string;
}

interface JwkRaw {
  kid?: string;
  kty?: string;
  use?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

interface JwksResponse {
  keys: JwkRaw[];
}

/**
 * Return cached JWKS keys, refreshing from the Bot Framework endpoint if stale.
 */
async function getJwksKeys(): Promise<JwkEntry[]> {
  const now = Date.now();
  if (_jwksCache && now - _jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return _jwksCache.keys;
  }

  log.debug('Refreshing Bot Framework JWKS cache');

  // Step 1: fetch OIDC metadata to discover jwks_uri
  const meta = (await fetchJson(BOT_FRAMEWORK_OPENID_META_URL)) as OidcMeta;
  if (!meta?.jwks_uri) {
    throw new Error('Bot Framework OIDC metadata missing jwks_uri');
  }

  // Step 2: fetch the key set
  const jwks = (await fetchJson(meta.jwks_uri)) as JwksResponse;
  if (!Array.isArray(jwks?.keys)) {
    throw new Error('Bot Framework JWKS response missing keys array');
  }

  // Step 3: import each RSA public key using Node.js crypto.createPublicKey
  const entries: JwkEntry[] = [];
  for (const raw of jwks.keys) {
    if (raw.kty !== 'RSA' || !raw.kid || !raw.n || !raw.e) {
      continue; // skip non-RSA or incomplete entries
    }
    try {
      // crypto.createPublicKey accepts a JWK object directly (n and e are sufficient for RSA verify)
      const jwkObj: Record<string, string> = {
        kty: raw.kty,
        n: raw.n,
        e: raw.e,
      };
      if (raw.alg) jwkObj.alg = String(raw.alg);
      if (raw.use) jwkObj.use = String(raw.use);
      const publicKey = crypto.createPublicKey({ format: 'jwk', key: jwkObj });
      entries.push({ kid: raw.kid, publicKey });
    } catch (err) {
      log.warn('Failed to import JWK', {
        kid: raw.kid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  _jwksCache = { keys: entries, fetchedAt: now };
  log.debug('Bot Framework JWKS cache refreshed', { keyCount: entries.length });
  return entries;
}

// ── JWT verification ──────────────────────────────────────────────────────────

export interface VerifiedClaims {
  iss: string;
  aud: string | string[];
  sub?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  appid?: string;
}

export interface JwtVerifyResult {
  ok: true;
  claims: VerifiedClaims;
}

export interface JwtVerifyError {
  ok: false;
  reason: string;
}

export type JwtVerifyOutcome = JwtVerifyResult | JwtVerifyError;

/**
 * Verify a Bot Framework inbound JWT bearer token.
 *
 * @param bearerToken  The raw token string (without "Bearer " prefix).
 * @param botAppId     The bot's Azure app id — must match the JWT `aud` claim.
 * @returns            { ok: true, claims } on success, { ok: false, reason } on failure.
 *
 * On JWKS fetch failure the function fails closed: returns ok:false.
 */
export async function verifyBotFrameworkJwt(
  bearerToken: string,
  botAppId: string,
): Promise<JwtVerifyOutcome> {
  // ── Parse the JWT structure ───────────────────────────────
  const parts = bearerToken.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed JWT: expected 3 parts' };
  }

  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;

  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed JWT: could not decode header/payload' };
  }

  // ── Algorithm check ───────────────────────────────────────
  if (header.alg !== 'RS256') {
    return { ok: false, reason: `unexpected JWT algorithm: ${header.alg}` };
  }

  if (!header.kid) {
    return { ok: false, reason: 'JWT header missing kid' };
  }

  // ── Issuer check ──────────────────────────────────────────
  if (claims.iss !== BOT_FRAMEWORK_ISSUER) {
    return { ok: false, reason: `invalid issuer: expected ${BOT_FRAMEWORK_ISSUER}, got ${claims.iss}` };
  }

  // ── Audience check ────────────────────────────────────────
  // aud can be a string or array of strings
  const aud = claims.aud;
  const audMatch =
    aud === botAppId ||
    (Array.isArray(aud) && aud.includes(botAppId));
  if (!audMatch) {
    return { ok: false, reason: `invalid audience: expected ${botAppId}, got ${JSON.stringify(aud)}` };
  }

  // ── Expiry check ──────────────────────────────────────────
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  if (exp === 0) {
    return { ok: false, reason: 'JWT missing exp claim' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > exp) {
    return { ok: false, reason: `JWT expired at ${exp}, now ${nowSec}` };
  }

  // ── Signature verification ────────────────────────────────
  let keys: JwkEntry[];
  try {
    keys = await getJwksKeys();
  } catch (err) {
    log.error('Failed to fetch Bot Framework JWKS', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: 'could not fetch Bot Framework JWKS' };
  }

  let matchingKey = keys.find(k => k.kid === header.kid);

  if (!matchingKey) {
    // Try refreshing once if the key isn't found (key rotation)
    _jwksCache = null;
    try {
      const refreshed = await getJwksKeys();
      matchingKey = refreshed.find(k => k.kid === header.kid);
    } catch (err) {
      return { ok: false, reason: `JWKS refresh failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!matchingKey) {
      return { ok: false, reason: `no JWKS key matching kid=${header.kid}` };
    }
  }

  // Verify RS256 signature using Node.js crypto.createVerify
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBytes = Buffer.from(sigB64, 'base64url');

  let valid: boolean;
  try {
    const verifier = crypto.createVerify('SHA256');
    verifier.update(signingInput);
    valid = verifier.verify(matchingKey.publicKey, sigBytes);
  } catch (err) {
    return { ok: false, reason: `signature verification threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!valid) {
    return { ok: false, reason: 'JWT signature invalid' };
  }

  return {
    ok: true,
    claims: claims as unknown as VerifiedClaims,
  };
}
