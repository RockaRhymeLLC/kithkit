/**
 * M365 Auth — Device Code Flow token acquisition and refresh for Microsoft Graph.
 *
 * Uses the OAuth 2.0 device code flow (no browser redirect required — suitable
 * for headless/daemon use). Tokens are cached in memory and refreshed
 * automatically before expiry.
 *
 * Credentials are read from macOS Keychain:
 *   credential-m365-client-id   — Azure AD app (client) ID
 *   credential-m365-tenant-id   — Azure AD tenant ID
 *   credential-m365-refresh-token — persisted refresh token (optional, set after first login)
 */

import { readKeychain, writeKeychain } from '../../core/keychain.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('m365-auth');

// ── Types ────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  expiresAt: number; // epoch ms
  refreshToken?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

// ── State ────────────────────────────────────────────────────

let _tokenSet: TokenSet | null = null;
let _clientId: string | null = null;
let _tenantId: string | null = null;
let _scopes: string[] = ['Mail.Read', 'Mail.Send', 'Calendars.Read', 'Calendars.Read.Shared', 'Chat.Read', 'Sites.Read.All', 'Files.Read.All', 'Notes.Read', 'offline_access'];

// ── Helpers ──────────────────────────────────────────────────

async function loadCredentials(): Promise<{ clientId: string; tenantId: string }> {
  if (_clientId && _tenantId) {
    return { clientId: _clientId, tenantId: _tenantId };
  }

  const clientId = await readKeychain('credential-m365-client-id');
  const tenantId = await readKeychain('credential-m365-tenant-id');

  if (!clientId) throw new Error('M365 client ID not found in keychain (credential-m365-client-id)');
  if (!tenantId) throw new Error('M365 tenant ID not found in keychain (credential-m365-tenant-id)');

  _clientId = clientId;
  _tenantId = tenantId;
  return { clientId, tenantId };
}

async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const { clientId, tenantId } = await loadCredentials();
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: _scopes.join(' '),
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  const tokenSet: TokenSet = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // 60s early renewal buffer
    refreshToken: data.refresh_token ?? refreshToken,
  };

  // Persist updated refresh token
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    await writeKeychain('credential-m365-refresh-token', 'assistant', data.refresh_token)
      .catch(err => log.warn('Failed to persist refresh token', { error: String(err) }));
  }

  return tokenSet;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Configure the scopes the M365 extension will request.
 * Must be called before the first token acquisition.
 */
export function setScopes(scopes: string[]): void {
  // Always include offline_access to get a refresh token
  _scopes = scopes.includes('offline_access') ? scopes : [...scopes, 'offline_access'];
}

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no token is available (device code login required).
 */
export async function getAccessToken(): Promise<string | null> {
  // Token already in memory and still valid
  if (_tokenSet && _tokenSet.expiresAt > Date.now()) {
    return _tokenSet.accessToken;
  }

  // Try to refresh using persisted refresh token
  const storedRefresh = await readKeychain('credential-m365-refresh-token');
  if (storedRefresh) {
    try {
      _tokenSet = await refreshAccessToken(storedRefresh);
      log.info('M365 token refreshed from keychain');
      return _tokenSet.accessToken;
    } catch (err) {
      log.warn('M365 token refresh failed — device code login required', {
        error: err instanceof Error ? err.message : String(err),
      });
      _tokenSet = null;
      return null;
    }
  }

  // Try in-memory refresh token (from current session)
  if (_tokenSet?.refreshToken) {
    try {
      _tokenSet = await refreshAccessToken(_tokenSet.refreshToken);
      log.info('M365 token refreshed from in-memory refresh token');
      return _tokenSet.accessToken;
    } catch (err) {
      log.warn('M365 in-memory refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      _tokenSet = null;
    }
  }

  return null;
}

/**
 * Start the device code flow. Returns the user-facing code and verification URL.
 * The caller must display these to the user, then call pollDeviceCode().
 */
export async function startDeviceCodeFlow(): Promise<DeviceCodeResponse> {
  const { clientId, tenantId } = await loadCredentials();
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/devicecode`;
  const body = new URLSearchParams({
    client_id: clientId,
    scope: _scopes.join(' '),
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Device code request failed (${res.status}): ${text}`);
  }

  return await res.json() as DeviceCodeResponse;
}

/**
 * Poll the token endpoint until the user completes device code login.
 * Returns the TokenSet when authentication succeeds.
 */
export async function pollDeviceCode(
  deviceCode: string,
  interval: number,
  maxWaitMs = 300_000,
): Promise<TokenSet> {
  const { clientId, tenantId } = await loadCredentials();
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval * 1000));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json() as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) {
      const tokenSet: TokenSet = {
        accessToken: data.access_token,
        expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
        refreshToken: data.refresh_token,
      };

      _tokenSet = tokenSet;

      // Persist refresh token to keychain
      if (data.refresh_token) {
        await writeKeychain('credential-m365-refresh-token', 'assistant', data.refresh_token)
          .catch(err => log.warn('Failed to persist refresh token', { error: String(err) }));
      }

      log.info('M365 device code login complete');
      return tokenSet;
    }

    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      // Normal — user hasn't completed yet
      if (data.error === 'slow_down') {
        await new Promise(r => setTimeout(r, 5000)); // extra backoff
      }
      continue;
    }

    throw new Error(`Device code polling failed: ${data.error} — ${data.error_description}`);
  }

  throw new Error('Device code login timed out');
}

/**
 * Check whether the M365 extension has a valid (or refreshable) token.
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
}
