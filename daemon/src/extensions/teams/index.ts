/**
 * Teams Bot Framework Extension — Phase 4.
 *
 * Adds two capabilities to the kithkit daemon:
 *
 *   INBOUND — POST /api/teams/messages
 *     Receives Bot Framework Activity POSTs from the Teams channel.
 *     Auth: RS256 JWT bearer token issued by the Bot Framework token service,
 *     verified against the Bot Framework JWKS. Rejects 401 on any failure.
 *     On a valid 'message' activity: injects the text into the comms session
 *     via injectToComms() and stores the conversation reference for replies.
 *
 *   OUTBOUND — ChannelAdapter named 'teams'
 *     Implements the ChannelAdapter interface. send() posts a reply Activity
 *     to the Bot Framework connector endpoint using a cached AAD client-
 *     credentials token (scope: https://api.botframework.com/.default).
 *     Registered with registerAdapter() so POST /api/send with channel='teams'
 *     routes through routeMessage() and therefore through the approval gate.
 *
 * AUTH CORRECTION NOTE (vs original task spec):
 *   The task originally specified HMAC for inbound auth. Bot Framework does NOT
 *   use HMAC on inbound Activities. The correct mechanism is RS256 JWT bearer
 *   token verification against the Bot Framework JWKS. This module implements
 *   the correct approach. See jwt-verify.ts for details.
 *
 * CONFIGURATION (kithkit.config.yaml):
 *   channels:
 *     teams:
 *       enabled: true
 *       # Credentials are read from macOS Keychain at startup:
 *       #   credential-teams-bot-client-id  (also the MicrosoftAppId / bot app id)
 *       #   credential-teams-bot-secret     (bot app password — never logged)
 *
 * APPROVAL GATE:
 *   Add a 'teams' entry to approval_policies in kithkit.config.yaml to gate
 *   outbound Teams messages through the human-in-the-loop approval flow:
 *     approval_policies:
 *       teams:
 *         require_approval_for: all
 *         timeout_minutes: 10
 */

import http from 'node:http';
import { createLogger } from '../../core/logger.js';
import { readKeychain } from '../../core/keychain.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerAdapter, unregisterAdapter } from '../../comms/channel-router.js';
import { injectToComms } from '../../core/session-bridge.js';
import { parseBody } from '../../api/helpers.js';
import { verifyBotFrameworkJwt } from './jwt-verify.js';
import type { ChannelAdapter, OutboundMessage, InboundMessage, Verbosity, ChannelCapabilities } from '../../comms/adapter.js';

const log = createLogger('teams-extension');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Subset of the Bot Framework ConversationReference needed to reply.
 * Stored in memory keyed by conversationId.
 */
export interface ConversationReference {
  serviceUrl: string;
  conversationId: string;
  conversationTenantId?: string;
  botId: string;
  botName: string;
  userId: string;
  userName: string;
  channelId: string;
  activityId?: string;
}

/**
 * A Bot Framework Activity (inbound message payload).
 * Only the fields we care about are typed here.
 */
interface BotFrameworkActivity {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; tenantId?: string; isGroup?: boolean };
  replyToId?: string;
}

// ── Conversation reference store ──────────────────────────────────────────────

/**
 * In-memory map of conversationId → ConversationReference.
 * Persists for the lifetime of the daemon process.
 * The most recent inbound message's reference is what we use for replies.
 */
const _conversationRefs = new Map<string, ConversationReference>();

/**
 * Store or update the conversation reference for a conversation.
 * Exported for testing.
 */
export function upsertConversationRef(ref: ConversationReference): void {
  _conversationRefs.set(ref.conversationId, ref);
}

/**
 * Retrieve a stored conversation reference by conversationId.
 * Exported for testing.
 */
export function getConversationRef(conversationId: string): ConversationReference | undefined {
  return _conversationRefs.get(conversationId);
}

/**
 * Returns all stored conversation reference IDs (for status/debug).
 */
export function listConversationRefIds(): string[] {
  return Array.from(_conversationRefs.keys());
}

/** Reset for testing. */
export function _resetConversationRefsForTesting(): void {
  _conversationRefs.clear();
}

// ── AAD token cache (outbound auth) ──────────────────────────────────────────

interface TokenCache {
  accessToken: string;
  expiresAt: number; // Unix timestamp ms
}

let _tokenCache: TokenCache | null = null;

const AAD_TOKEN_URL =
  'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
/** Refresh the token 60 seconds before actual expiry. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Retrieve a valid AAD client-credentials token for the Bot Framework.
 *  Caches the token until it is within TOKEN_EXPIRY_BUFFER_MS of expiry.
 *  NEVER logs the token value or the client secret. */
export async function getAadToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (_tokenCache && now < _tokenCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return _tokenCache.accessToken;
  }

  log.debug('Fetching new AAD token for Bot Framework outbound');

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: BOT_FRAMEWORK_SCOPE,
  });

  const res = await fetch(AAD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`AAD token request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!data.access_token) {
    throw new Error(`AAD token response missing access_token: ${data.error ?? 'unknown error'}`);
  }

  const expiresInMs = typeof data.expires_in === 'number'
    ? data.expires_in * 1000
    : 3600_000; // default 1 hour

  _tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresInMs,
  };

  log.debug('AAD token cached', { expiresIn: `${Math.round(expiresInMs / 1000)}s` });
  return _tokenCache.accessToken;
}

/** Reset token cache for testing. */
export function _resetTokenCacheForTesting(): void {
  _tokenCache = null;
}

// ── Outbound Bot Framework send ───────────────────────────────────────────────

/**
 * Post a reply Activity to the Bot Framework connector endpoint.
 *
 * @param ref           Conversation reference identifying where to send.
 * @param text          Message text to send.
 * @param clientId      Bot app id (MicrosoftAppId).
 * @param clientSecret  Bot app password (from Keychain — NEVER logged).
 */
export async function sendTeamsActivity(
  ref: ConversationReference,
  text: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const token = await getAadToken(clientId, clientSecret);

  // Construct the outbound Activity
  const activity = {
    type: 'message',
    text,
    from: { id: ref.botId, name: ref.botName },
    recipient: { id: ref.userId, name: ref.userName },
    conversation: { id: ref.conversationId },
    channelId: ref.channelId,
    serviceUrl: ref.serviceUrl,
  };

  // Normalize serviceUrl — must not end with slash before appending path
  const base = ref.serviceUrl.replace(/\/$/, '');
  const url = `${base}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;

  let res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(activity),
  });

  // Retry once on 401 — token may have just expired
  if (res.status === 401) {
    log.warn('Outbound Teams: 401, refreshing AAD token and retrying');
    _tokenCache = null;
    const freshToken = await getAadToken(clientId, clientSecret);
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freshToken}`,
      },
      body: JSON.stringify(activity),
    });
  }

  if (!res.ok) {
    throw new Error(`Teams outbound failed: HTTP ${res.status} from ${url}`);
  }

  log.debug('Teams activity sent', { conversationId: ref.conversationId, status: res.status });
}

// ── ChannelAdapter implementation ─────────────────────────────────────────────

/**
 * TeamsAdapter — ChannelAdapter for the 'teams' channel.
 *
 * send() targets the most-recently-seen conversation by default. To override,
 * pass the conversationId in message.metadata.conversationId.
 */
export class TeamsAdapter implements ChannelAdapter {
  readonly name = 'teams';

  private readonly _clientId: string;
  private readonly _clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this._clientId = clientId;
    this._clientSecret = clientSecret;
  }

  /**
   * Send a message to a Teams conversation.
   *
   * Looks up the conversation reference by:
   *   1. message.metadata.conversationId if provided
   *   2. the most recently stored conversation reference
   *
   * Returns false if no conversation reference is available.
   */
  async send(message: OutboundMessage): Promise<boolean> {
    const meta = message.metadata ?? {};
    let ref: ConversationReference | undefined;

    if (typeof meta.conversationId === 'string') {
      ref = getConversationRef(meta.conversationId);
    }

    if (!ref) {
      // Fall back to most recently seen conversation
      const ids = listConversationRefIds();
      if (ids.length > 0) {
        ref = getConversationRef(ids[ids.length - 1]);
      }
    }

    if (!ref) {
      log.error('Teams send: no conversation reference available — no inbound message received yet');
      return false;
    }

    try {
      await sendTeamsActivity(ref, message.text, this._clientId, this._clientSecret);
      return true;
    } catch (err) {
      log.error('Teams send failed', {
        error: err instanceof Error ? err.message : String(err),
        conversationId: ref.conversationId,
      });
      return false;
    }
  }

  /** Pull-mode receive — Teams is push-only; always returns empty. */
  async receive(): Promise<InboundMessage[]> {
    return [];
  }

  formatMessage(text: string, _verbosity: Verbosity): string {
    // Teams supports markdown; pass through as-is.
    return text;
  }

  capabilities(): ChannelCapabilities {
    return {
      markdown: true,
      images: false,
      buttons: false,
      html: false,
      maxLength: 28000, // Bot Framework connector limit
    };
  }
}

// ── Inbound webhook handler ───────────────────────────────────────────────────

let _botAppId: string | null = null;

/** Set the bot app id for JWT verification (called at startup). */
export function setBotAppId(id: string): void {
  _botAppId = id;
}

/**
 * Handle POST /api/teams/messages — Bot Framework inbound Activity webhook.
 *
 * Auth: RS256 JWT bearer token in Authorization header.
 * Verified against the Bot Framework JWKS.
 *
 * On valid 'message' activity:
 *   - Stores the conversation reference for future replies.
 *   - Injects formatted text into the comms session via injectToComms().
 */
export async function handleTeamsWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') {
    return false;
  }

  // ── JWT auth ─────────────────────────────────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    log.warn('Teams inbound: missing or malformed Authorization header');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing bearer token' }));
    return true;
  }

  const token = authHeader.slice(7);

  if (!_botAppId) {
    log.error('Teams inbound: bot app id not configured — rejecting request');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Teams extension not configured' }));
    return true;
  }

  const jwtResult = await verifyBotFrameworkJwt(token, _botAppId);
  if (!jwtResult.ok) {
    log.warn('Teams inbound: JWT verification failed', { reason: jwtResult.reason });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid bearer token' }));
    return true;
  }
  // ── End JWT auth ─────────────────────────────────────────

  let activity: BotFrameworkActivity;
  try {
    const body = await parseBody(req);
    activity = body as BotFrameworkActivity;
  } catch (err) {
    log.error('Teams inbound: failed to parse activity body', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request body' }));
    return true;
  }

  log.debug('Teams inbound activity', { type: activity.type, id: activity.id });

  // Only process 'message' activities
  if (activity.type !== 'message') {
    // Acknowledge non-message activities with 200 (e.g. conversationUpdate, typing)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── Store conversation reference ──────────────────────────
  if (
    activity.serviceUrl &&
    activity.conversation?.id &&
    activity.from?.id &&
    activity.recipient?.id
  ) {
    const ref: ConversationReference = {
      serviceUrl: activity.serviceUrl,
      conversationId: activity.conversation.id,
      conversationTenantId: activity.conversation.tenantId,
      botId: activity.recipient.id,
      botName: activity.recipient.name ?? 'Bot',
      userId: activity.from.id,
      userName: activity.from.name ?? 'User',
      channelId: activity.channelId ?? 'msteams',
      activityId: activity.id,
    };
    upsertConversationRef(ref);
    log.debug('Teams: stored conversation reference', { conversationId: ref.conversationId });
  }

  // ── Inject into comms session ─────────────────────────────
  const senderName = activity.from?.name ?? 'Teams user';
  const messageText = (activity.text ?? '').trim();

  if (!messageText) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  const injected = `[Teams: ${senderName}]: ${messageText}`;

  try {
    injectToComms(injected, { pressEnter: true });
    log.info('Teams message injected', {
      from: senderName,
      conversationId: activity.conversation?.id,
    });
  } catch (err) {
    log.error('Teams inbound: failed to inject into comms session', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Still return 200 — we received the message; injection failure is internal
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
  return true;
}

// ── Extension lifecycle ───────────────────────────────────────────────────────

let _teamsAdapter: TeamsAdapter | null = null;

/**
 * Initialize the Teams extension.
 * Called by the agent extension during onInit().
 *
 * Reads credentials from Keychain, registers the webhook route and the adapter.
 */
export async function initTeamsExtension(): Promise<void> {
  const clientId = await readKeychain('credential-teams-bot-client-id');
  const clientSecret = await readKeychain('credential-teams-bot-secret');

  if (!clientId || !clientSecret) {
    log.warn('Teams extension: credentials not found in Keychain — Teams disabled', {
      clientId: clientId ? 'ok' : 'MISSING',
      clientSecret: clientSecret ? 'ok' : 'MISSING',
    });
    return;
  }

  setBotAppId(clientId);

  _teamsAdapter = new TeamsAdapter(clientId, clientSecret);
  registerAdapter(_teamsAdapter);
  registerRoute('/api/teams/messages', handleTeamsWebhook);

  log.info('Teams extension initialized', { botAppId: clientId });
}

/**
 * Shut down the Teams extension.
 * Called by the agent extension during onShutdown().
 */
export function shutdownTeamsExtension(): void {
  if (_teamsAdapter) {
    unregisterAdapter('teams');
    _teamsAdapter = null;
  }
  _botAppId = null;
  log.info('Teams extension shut down');
}

/** Exported for integration testing. */
export function _getTeamsAdapterForTesting(): TeamsAdapter | null {
  return _teamsAdapter;
}
