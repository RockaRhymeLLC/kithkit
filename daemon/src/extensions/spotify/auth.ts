/**
 * Spotify Auth — OAuth 2.0 Authorization Code flow.
 *
 * Credentials are read from macOS Keychain:
 *   credential-spotify-client-id     — Spotify app client ID
 *   credential-spotify-client-secret — Spotify app client secret
 *   credential-spotify-access-token  — persisted access token (written after login)
 *   credential-spotify-refresh-token — persisted refresh token (written after login)
 */

import { readKeychain, writeKeychain } from '../../core/keychain.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('spotify-auth');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_URI = 'http://127.0.0.1:3847/api/spotify/callback';
const SCOPES = 'playlist-read-private playlist-modify-public playlist-modify-private user-read-private user-top-read user-library-read user-read-recently-played';

// ── Types ────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

// ── State ────────────────────────────────────────────────────

let _tokenSet: TokenSet | null = null;
let _clientId: string | null = null;
let _clientSecret: string | null = null;

// ── Helpers ──────────────────────────────────────────────────

async function loadCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  if (_clientId && _clientSecret) {
    return { clientId: _clientId, clientSecret: _clientSecret };
  }

  const clientId = await readKeychain('credential-spotify-client-id');
  const clientSecret = await readKeychain('credential-spotify-client-secret');

  if (!clientId) throw new Error('Spotify client ID not found in keychain (credential-spotify-client-id)');
  if (!clientSecret) throw new Error('Spotify client secret not found in keychain (credential-spotify-client-secret)');

  _clientId = clientId;
  _clientSecret = clientSecret;
  return { clientId, clientSecret };
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const { clientId, clientSecret } = await loadCredentials();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const tokenSet: TokenSet = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    refreshToken: data.refresh_token ?? refreshToken,
  };

  // Persist tokens to keychain
  await writeKeychain('credential-spotify-access-token', 'assistant', data.access_token)
    .catch(err => log.warn('Failed to persist access token', { error: String(err) }));

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await writeKeychain('credential-spotify-refresh-token', 'assistant', data.refresh_token)
      .catch(err => log.warn('Failed to persist refresh token', { error: String(err) }));
  }

  return tokenSet;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Build the Spotify authorization URL for the OAuth code flow.
 */
export async function getAuthorizationUrl(): Promise<string> {
  const { clientId } = await loadCredentials();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(code: string): Promise<TokenSet> {
  const { clientId, clientSecret } = await loadCredentials();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokenSet: TokenSet = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  _tokenSet = tokenSet;

  // Persist both tokens to keychain
  await writeKeychain('credential-spotify-access-token', 'assistant', data.access_token)
    .catch(err => log.warn('Failed to persist access token', { error: String(err) }));
  await writeKeychain('credential-spotify-refresh-token', 'assistant', data.refresh_token)
    .catch(err => log.warn('Failed to persist refresh token', { error: String(err) }));

  log.info('Spotify OAuth login complete');
  return tokenSet;
}

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no token is available (login required).
 */
export async function getAccessToken(): Promise<string | null> {
  // Token in memory and still valid
  if (_tokenSet && _tokenSet.expiresAt > Date.now()) {
    return _tokenSet.accessToken;
  }

  // Try to refresh using persisted refresh token
  const storedRefresh = await readKeychain('credential-spotify-refresh-token');
  if (storedRefresh) {
    try {
      _tokenSet = await refreshAccessToken(storedRefresh);
      log.info('Spotify token refreshed from keychain');
      return _tokenSet.accessToken;
    } catch (err) {
      log.warn('Spotify token refresh failed — login required', {
        error: err instanceof Error ? err.message : String(err),
      });
      _tokenSet = null;
      return null;
    }
  }

  // Try in-memory refresh token
  if (_tokenSet?.refreshToken) {
    try {
      _tokenSet = await refreshAccessToken(_tokenSet.refreshToken);
      log.info('Spotify token refreshed from in-memory refresh token');
      return _tokenSet.accessToken;
    } catch (err) {
      log.warn('Spotify in-memory refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      _tokenSet = null;
    }
  }

  return null;
}

/**
 * Check whether the Spotify extension has a valid (or refreshable) token.
 */
export async function isAuthenticated(): Promise<boolean> {
  const token = await getAccessToken();
  return token !== null;
}

/**
 * Clear in-memory token state (does not remove keychain entries).
 */
export function clearTokenCache(): void {
  _tokenSet = null;
  _clientId = null;
  _clientSecret = null;
}
