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
 *     to the Bot Framework connector endpoint using the official
 *     botframework-connector SDK (MicrosoftAppCredentials + ConnectorClient).
 *     Registered with registerAdapter() so POST /api/send with channel='teams'
 *     routes through routeMessage() and therefore through the approval gate.
 *
 * AUTH CORRECTION NOTE (vs original task spec):
 *   The task originally specified HMAC for inbound auth. Bot Framework does NOT
 *   use HMAC on inbound Activities. The correct mechanism is RS256 JWT bearer
 *   token verification against the Bot Framework JWKS. This module implements
 *   the correct approach. See jwt-verify.ts for details.
 *
 * INBOUND JWT NOTE:
 *   Inbound JWT validation is intentionally left hand-rolled; CloudAdapter
 *   migration deferred to v1.1.
 *
 * CONFIGURATION (kithkit.config.yaml):
 *   channels:
 *     teams:
 *       enabled: true
 *       tenantId: "<azure-tenant-id>"  # Required for single-tenant bots
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
import { MicrosoftAppCredentials, ConnectorClient } from 'botframework-connector';
import { createLogger } from '../../core/logger.js';
import { readKeychain } from '../../core/keychain.js';
import { loadConfig } from '../../core/config.js';
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

// ── Outbound Bot Framework send (SDK) ─────────────────────────────────────────

/**
 * Post a reply Activity to the Bot Framework connector endpoint using the
 * official botframework-connector SDK.
 *
 * Uses MicrosoftAppCredentials with the correct single-tenant ID so that token
 * acquisition targets the right AAD tenant (fixes HTTP 400 that occurred with
 * the previous hand-rolled common-tenant endpoint).
 *
 * @param ref           Conversation reference identifying where to send.
 * @param text          Message text to send.
 * @param clientId      Bot app id (MicrosoftAppId).
 * @param clientSecret  Bot app password (from Keychain — NEVER logged).
 * @param tenantId      Azure AD tenant ID (channels.teams.tenantId from config).
 */
export async function sendTeamsActivity(
  ref: ConversationReference,
  text: string,
  clientId: string,
  clientSecret: string,
  tenantId: string,
): Promise<void> {
  const activity = {
    type: 'message',
    text,
    from: { id: ref.botId, name: ref.botName },
    recipient: { id: ref.userId, name: ref.userName },
    conversation: { id: ref.conversationId },
    channelId: ref.channelId,
    serviceUrl: ref.serviceUrl,
  };

  const creds = new MicrosoftAppCredentials(clientId, clientSecret, tenantId);
  const client = new ConnectorClient(creds, { baseUri: ref.serviceUrl });
  // Cast to any: the activity shape is valid for the Bot Framework API but
  // ConversationAccount requires isGroup/conversationType/name fields that we
  // intentionally omit (server accepts partial accounts in outbound activities).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.conversations.sendToConversation(ref.conversationId, activity as any);

  log.debug('Teams activity sent', { conversationId: ref.conversationId });
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
  private readonly _tenantId: string;

  constructor(clientId: string, clientSecret: string, tenantId: string) {
    this._clientId = clientId;
    this._clientSecret = clientSecret;
    this._tenantId = tenantId;
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
      await sendTeamsActivity(ref, message.text, this._clientId, this._clientSecret, this._tenantId);
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
 * Reads credentials from Keychain and tenantId from config, then registers
 * the webhook route and the adapter.
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

  // Read tenantId from channels.teams.tenantId — use cast since core/config.ts's
  // KithkitConfig does not type the channels block (extensions/config.ts owns that).
  const cfg = loadConfig() as unknown as { channels?: { teams?: { tenantId?: string } } };
  const tenantId = cfg.channels?.teams?.tenantId ?? '';

  if (!tenantId) {
    log.warn('Teams extension: channels.teams.tenantId not configured — outbound auth will use default tenant (likely wrong for single-tenant bots)');
  }

  setBotAppId(clientId);

  _teamsAdapter = new TeamsAdapter(clientId, clientSecret, tenantId);
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
