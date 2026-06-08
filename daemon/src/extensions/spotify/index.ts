/**
 * Spotify Extension — Spotify Web API integration with OAuth and playlist management.
 *
 * Provides:
 * - OAuth 2.0 Authorization Code flow for authentication
 * - Automatic token refresh using persisted refresh token
 * - HTTP endpoints for user profile, playlists, track search
 * - Health check registration
 *
 * Configuration (kithkit.config.yaml):
 *
 *   spotify:
 *     enabled: true
 *
 * Credentials (macOS Keychain):
 *   credential-spotify-client-id     — Spotify app client ID
 *   credential-spotify-client-secret — Spotify app client secret
 *   credential-spotify-access-token  — persisted access token (written after login)
 *   credential-spotify-refresh-token — persisted refresh token (written after login)
 */

import http from 'node:http';
import { createLogger } from '../../core/logger.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import { parseBody } from '../../api/helpers.js';
import {
  getAuthorizationUrl,
  exchangeCode,
  getAccessToken,
  isAuthenticated,
  clearTokenCache,
} from './auth.js';
import {
  getMe,
  getPlaylists,
  createPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  searchTracks,
} from './api.js';

const log = createLogger('spotify');

// ── Config ───────────────────────────────────────────────────

export interface SpotifyConfig {
  enabled: boolean;
}

// ── State ────────────────────────────────────────────────────

let _config: SpotifyConfig | null = null;
let _initialized = false;

// ── Route Handlers ───────────────────────────────────────────

async function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  try {
    const url = await getAuthorizationUrl();
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Spotify login redirect failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Spotify auth denied: ${error}` }));
    return true;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing authorization code' }));
    return true;
  }

  try {
    await exchangeCode(code);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Spotify authentication successful' }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Spotify callback token exchange failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  const authed = await isAuthenticated().catch(() => false);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    enabled: _config?.enabled ?? false,
    authenticated: authed,
  }));
  return true;
}

async function handleMe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  try {
    const user = await getMe();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(user));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleGetPlaylists(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  try {
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 20;
    const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : 0;
    const playlists = await getPlaylists(limit, offset);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(playlists));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleCreatePlaylist(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await parseBody(req);
    const { name, description, public: isPublic } = body as {
      name?: string;
      description?: string;
      public?: boolean;
    };

    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'name is required' }));
      return true;
    }

    // Need user ID for playlist creation
    const user = await getMe();
    const playlist = await createPlaylist(user.id, name, description ?? '', isPublic ?? false);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(playlist));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleAddTracks(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const match = pathname.match(/\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
  if (!match) return false;

  const playlistId = decodeURIComponent(match[1]);

  try {
    const body = await parseBody(req);
    const { uris } = body as { uris?: string[] };

    if (!uris || !Array.isArray(uris) || uris.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'uris array is required' }));
      return true;
    }

    const result = await addTracksToPlaylist(playlistId, uris);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleRemoveTracks(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'DELETE') return false;

  const match = pathname.match(/\/api\/spotify\/playlists\/([^/]+)\/tracks$/);
  if (!match) return false;

  const playlistId = decodeURIComponent(match[1]);

  try {
    const body = await parseBody(req);
    const { uris } = body as { uris?: string[] };

    if (!uris || !Array.isArray(uris) || uris.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'uris array is required' }));
      return true;
    }

    const result = await removeTracksFromPlaylist(playlistId, uris);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  const q = searchParams.get('q');
  if (!q) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'q query parameter is required' }));
    return true;
  }

  try {
    const type = searchParams.get('type') ?? 'track';
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 20;
    const results = await searchTracks(q, type, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('no access token') ? 401 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

// ── Router ───────────────────────────────────────────────────

/**
 * Central route handler for all /api/spotify/* requests.
 */
async function handleSpotifyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Spotify extension is disabled' }));
    return true;
  }

  // Auth
  if (pathname === '/api/spotify/login') return handleLogin(req, res);
  if (pathname === '/api/spotify/callback') return handleCallback(req, res, pathname, searchParams);
  if (pathname === '/api/spotify/status') return handleStatus(req, res);

  // User
  if (pathname === '/api/spotify/me') return handleMe(req, res);

  // Playlists
  if (pathname === '/api/spotify/playlists') {
    if (req.method === 'POST') return handleCreatePlaylist(req, res);
    return handleGetPlaylists(req, res, pathname, searchParams);
  }

  // Playlist tracks (add/remove)
  if (/\/api\/spotify\/playlists\/[^/]+\/tracks$/.test(pathname)) {
    if (req.method === 'POST') return handleAddTracks(req, res, pathname);
    if (req.method === 'DELETE') return handleRemoveTracks(req, res, pathname);
  }

  // Search
  if (pathname === '/api/spotify/search') return handleSearch(req, res, pathname, searchParams);

  return false;
}

// ── Health Check ─────────────────────────────────────────────

function registerSpotifyHealthCheck(): void {
  registerCheck('spotify', () => {
    if (!_config?.enabled) {
      return { ok: true, message: 'Spotify disabled' };
    }
    // Non-blocking — don't await here
    getAccessToken()
      .then(t => t !== null)
      .catch(() => false);
    return {
      ok: _initialized,
      message: _initialized ? 'Spotify extension loaded' : 'Spotify extension not initialized',
    };
  });
}

// ── Init / Shutdown ──────────────────────────────────────────

export async function initSpotify(config: SpotifyConfig): Promise<void> {
  _config = config;

  if (!config.enabled) {
    log.info('Spotify extension disabled in config');
    registerSpotifyHealthCheck();
    return;
  }

  // Register all /api/spotify/* routes
  registerRoute('/api/spotify/*', handleSpotifyRoute);
  registerRoute('/api/spotify/login', handleSpotifyRoute);
  registerRoute('/api/spotify/callback', handleSpotifyRoute);
  registerRoute('/api/spotify/status', handleSpotifyRoute);
  registerRoute('/api/spotify/me', handleSpotifyRoute);
  registerRoute('/api/spotify/playlists', handleSpotifyRoute);
  registerRoute('/api/spotify/search', handleSpotifyRoute);

  registerSpotifyHealthCheck();

  // Attempt background token refresh (non-blocking)
  getAccessToken()
    .then(token => {
      if (token) {
        log.info('Spotify authenticated (token refreshed from keychain)');
      } else {
        log.info('Spotify not authenticated — visit /api/spotify/login to authorize');
      }
    })
    .catch(err => {
      log.warn('Spotify background token check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  _initialized = true;
  log.info('Spotify extension initialized');
}

export function stopSpotify(): void {
  clearTokenCache();
  _initialized = false;
  _config = null;
  log.info('Spotify extension shut down');
}
