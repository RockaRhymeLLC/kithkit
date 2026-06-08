/**
 * Spotify API — typed wrappers around the Spotify Web API.
 *
 * All calls go through getAccessToken() so they transparently handle
 * token refresh. Uses built-in Node 22 fetch — no extra dependencies.
 */

import { getAccessToken } from './auth.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('spotify-api');

const API_BASE = 'https://api.spotify.com/v1';

// ── Types ────────────────────────────────────────────────────

export interface SpotifyUser {
  id: string;
  display_name: string | null;
  email?: string;
  country?: string;
  product?: string;
  images?: Array<{ url: string; height: number | null; width: number | null }>;
  uri: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  owner: { id: string; display_name: string | null };
  tracks: { total: number };
  uri: string;
  images?: Array<{ url: string; height: number | null; width: number | null }>;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string; images?: Array<{ url: string }> };
  duration_ms: number;
  uri: string;
  preview_url: string | null;
}

export interface SpotifySearchResult {
  tracks?: { items: SpotifyTrack[]; total: number };
}

export interface SpotifyPaginatedPlaylists {
  items: SpotifyPlaylist[];
  total: number;
  offset: number;
  limit: number;
}

// ── Internal helpers ─────────────────────────────────────────

async function spotifyRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Spotify: no access token available — login required');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 204 No Content (e.g. after adding/removing tracks)
  if (res.status === 204) {
    return undefined as unknown as T;
  }

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Spotify API ${method} ${path} failed (${res.status}): ${text}`);
  }

  if (!text.trim()) {
    return undefined as unknown as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Spotify API ${method} ${path} returned invalid JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get the current user's profile.
 */
export async function getMe(): Promise<SpotifyUser> {
  log.debug('Spotify: get current user profile');
  return spotifyRequest<SpotifyUser>('GET', '/me');
}

/**
 * List the current user's playlists.
 */
export async function getPlaylists(
  limit: number = 20,
  offset: number = 0,
): Promise<SpotifyPaginatedPlaylists> {
  log.debug('Spotify: list playlists', { limit, offset });
  return spotifyRequest<SpotifyPaginatedPlaylists>(
    'GET',
    `/me/playlists?limit=${limit}&offset=${offset}`,
  );
}

/**
 * Create a new playlist for the current user.
 */
export async function createPlaylist(
  _userId: string,
  name: string,
  description: string = '',
  isPublic: boolean = false,
): Promise<SpotifyPlaylist> {
  log.info('Spotify: create playlist', { name, public: isPublic });
  return spotifyRequest<SpotifyPlaylist>(
    'POST',
    `/me/playlists`,
    { name, description, public: isPublic },
  );
}

/**
 * Add tracks to a playlist.
 * @param playlistId - Spotify playlist ID
 * @param uris - Array of Spotify track URIs (e.g. ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"])
 */
export async function addTracksToPlaylist(
  playlistId: string,
  uris: string[],
): Promise<{ snapshot_id: string }> {
  log.info('Spotify: add tracks to playlist', { playlistId, count: uris.length });
  return spotifyRequest<{ snapshot_id: string }>(
    'POST',
    `/playlists/${encodeURIComponent(playlistId)}/items`,
    { uris },
  );
}

/**
 * Remove tracks from a playlist.
 * @param playlistId - Spotify playlist ID
 * @param uris - Array of Spotify track URIs to remove
 */
export async function removeTracksFromPlaylist(
  playlistId: string,
  uris: string[],
): Promise<{ snapshot_id: string }> {
  log.info('Spotify: remove tracks from playlist', { playlistId, count: uris.length });
  return spotifyRequest<{ snapshot_id: string }>(
    'DELETE',
    `/playlists/${encodeURIComponent(playlistId)}/items`,
    { tracks: uris.map(uri => ({ uri })) },
  );
}

/**
 * Search for tracks on Spotify.
 */
export async function searchTracks(
  query: string,
  type: string = 'track',
  limit: number = 20,
): Promise<SpotifySearchResult> {
  const params = new URLSearchParams({
    q: query,
    type,
    limit: String(limit),
  });
  log.debug('Spotify: search', { query, type, limit });
  return spotifyRequest<SpotifySearchResult>('GET', `/search?${params.toString()}`);
}
