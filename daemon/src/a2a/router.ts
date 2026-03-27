/**
 * Unified A2A Router — orchestrates delivery of A2A messages via LAN or relay.
 *
 * All dependencies are injected via constructor — NO imports from extensions.
 * Supports DM (to) and group (group) targets with auto/lan/relay routing.
 */

import crypto from 'node:crypto';
import { createLogger } from '../core/logger.js';
import type {
  A2ASendRequest,
  A2ASendResponse,
  A2AGroupSendResponse,
  A2ASendError,
  DeliveryAttempt,
} from './types.js';
import { A2A_ERROR_CODES } from './types.js';

const log = createLogger('a2a:router');

// ── Dependency Types ─────────────────────────────────────────

export interface PeerConfig {
  name: string;
  host: string;
  port: number;
  ip?: string;
}

export interface AgentMessage {
  from: string;
  type: string;
  text?: string;
  messageId: string;
  timestamp: string;
  [key: string]: unknown;
}

interface A2ANetworkClient {
  send(to: string, payload: Record<string, unknown>): Promise<{
    status: 'delivered' | 'queued' | 'failed';
    messageId: string;
    error?: string;
  }>;
  sendToGroup(groupId: string, payload: Record<string, unknown>): Promise<{
    messageId: string;
    delivered: string[];
    queued: string[];
    failed: string[];
  }>;
  getGroups(): Promise<Array<{ groupId: string; name: string }>>;
}

export interface RouterDeps {
  config: Record<string, unknown>;
  sendViaLAN: (peer: PeerConfig, msg: AgentMessage, secret: string, agentName: string) => Promise<Record<string, unknown>>;
  getNetworkClient: () => A2ANetworkClient | null;
  getAgentCommsSecret: () => Promise<string | null>;
  logCommsEntry: (entry: Record<string, unknown>) => void;
  sendMessage: (req: { from: string; to: string; type: string; body: string; metadata?: Record<string, unknown> }) => { messageId: number; delivered: boolean };
}

// ── Router Class ──────────────────────────────────────────────

export class UnifiedA2ARouter {
  private readonly deps: RouterDeps;
  private readonly agentName: string;
  private readonly peers: PeerConfig[];
  private readonly primaryCommunity: string | null;

  constructor(deps: RouterDeps) {
    this.deps = deps;
    const agentConfig = deps.config.agent as { name?: string } | undefined;
    this.agentName = (agentConfig?.name ?? 'unknown').toLowerCase();

    const agentComms = deps.config['agent-comms'] as { enabled?: boolean; peers?: PeerConfig[] } | undefined;
    this.peers = agentComms?.peers ?? [];

    const networkConfig = deps.config.network as { communities?: Array<{ name: string; primary: string }> } | undefined;
    this.primaryCommunity = networkConfig?.communities?.[0]?.name ?? null;
  }

  // ── Validate ────────────────────────────────────────────────

  validate(body: unknown): { valid: true; request: A2ASendRequest } | { valid: false; error: string; code: string } {
    if (!body || typeof body !== 'object') {
      return { valid: false, error: 'Request body must be a JSON object', code: A2A_ERROR_CODES.INVALID_REQUEST };
    }

    const req = body as Record<string, unknown>;

    // Must have exactly one of 'to' or 'group'
    const hasTo = req.to !== undefined && req.to !== null;
    const hasGroup = req.group !== undefined && req.group !== null;

    if (!hasTo && !hasGroup) {
      return { valid: false, error: "Either 'to' or 'group' is required", code: A2A_ERROR_CODES.INVALID_TARGET };
    }
    if (hasTo && hasGroup) {
      return { valid: false, error: "Cannot specify both 'to' and 'group'", code: A2A_ERROR_CODES.INVALID_TARGET };
    }

    if (hasTo && typeof req.to !== 'string') {
      return { valid: false, error: "'to' must be a string", code: A2A_ERROR_CODES.INVALID_TARGET };
    }
    if (hasGroup && typeof req.group !== 'string') {
      return { valid: false, error: "'group' must be a string", code: A2A_ERROR_CODES.INVALID_TARGET };
    }

    // Payload is required
    if (!req.payload || typeof req.payload !== 'object') {
      return { valid: false, error: "'payload' is required and must be an object", code: A2A_ERROR_CODES.INVALID_REQUEST };
    }

    const payload = req.payload as Record<string, unknown>;
    if (!payload.type || typeof payload.type !== 'string') {
      return { valid: false, error: "'payload.type' is required and must be a string", code: A2A_ERROR_CODES.INVALID_REQUEST };
    }

    // Route validation
    const route = req.route as string | undefined;
    if (route !== undefined && !['auto', 'lan', 'relay'].includes(route)) {
      return { valid: false, error: `Invalid route '${route}'. Valid: auto, lan, relay`, code: A2A_ERROR_CODES.INVALID_ROUTE };
    }

    // LAN route cannot be used with groups
    if (route === 'lan' && hasGroup) {
      return { valid: false, error: "Cannot use 'lan' route with group targets", code: A2A_ERROR_CODES.INVALID_ROUTE };
    }

    return {
      valid: true,
      request: {
        to: hasTo ? (req.to as string) : undefined,
        group: hasGroup ? (req.group as string) : undefined,
        payload: payload as A2ASendRequest['payload'],
        route: (route as A2ASendRequest['route']) ?? 'auto',
      },
    };
  }

  // ── Resolve Peer ─────────────────────────────────────────────

  resolvePeer(name: string): { peer?: PeerConfig; qualified: string } {
    // If name contains '@', treat as qualified relay name — skip config lookup
    if (name.includes('@')) {
      return { qualified: name };
    }

    const peer = this.peers.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );

    // Qualify bare names for relay: append @community.primary
    const qualified = this.primaryCommunity
      ? `${name.toLowerCase()}@${this.primaryCommunity}`
      : name.toLowerCase();

    return { peer, qualified };
  }

  // ── Group Mismatch Check ─────────────────────────────────────

  /**
   * Check if a DM target name matches a known group name.
   * Returns a helpful error message if so, or null if no mismatch.
   * Used to catch the common mistake of using `to: "group-name"` instead of `group: "group-name"`.
   */
  private async checkGroupMismatch(name: string): Promise<string | null> {
    const network = this.deps.getNetworkClient();
    if (!network) return null;

    try {
      const groups = await network.getGroups();
      const match = groups.find(
        (g) => g.name.toLowerCase() === name.toLowerCase(),
      );
      if (match) {
        return `'${name}' is a group, not a peer. Use the 'group' field instead of 'to' to send to groups.`;
      }
    } catch {
      // Don't fail the send if group lookup fails — just skip the hint
    }

    return null;
  }

  // ── Send (main orchestration) ────────────────────────────────

  async send(body: unknown): Promise<A2ASendResponse | A2AGroupSendResponse | A2ASendError> {
    const validation = this.validate(body);
    if (!validation.valid) {
      return {
        ok: false,
        error: validation.error,
        code: validation.code,
        timestamp: new Date().toISOString(),
      };
    }

    const request = validation.request;
    const messageId = crypto.randomUUID();
    const attempts: DeliveryAttempt[] = [];

    // Group send
    if (request.group) {
      return this.sendGroup(request, messageId, attempts);
    }

    // DM send
    return this.sendDM(request, messageId, attempts);
  }

  // ── DM Send ──────────────────────────────────────────────────

  private async sendDM(
    request: A2ASendRequest,
    messageId: string,
    attempts: DeliveryAttempt[],
  ): Promise<A2ASendResponse | A2ASendError> {
    const target = request.to!;
    const route = request.route ?? 'auto';
    const { peer, qualified } = this.resolvePeer(target);

    // Check if the caller accidentally put a group name in 'to' instead of 'group'
    const groupMismatch = await this.checkGroupMismatch(target);
    if (groupMismatch) {
      return {
        ok: false,
        error: groupMismatch,
        code: A2A_ERROR_CODES.PEER_NOT_FOUND,
        timestamp: new Date().toISOString(),
      };
    }

    // Forced LAN
    if (route === 'lan') {
      if (!peer) {
        return {
          ok: false,
          error: `Peer '${target}' not found in agent-comms config`,
          code: A2A_ERROR_CODES.PEER_NOT_FOUND,
          timestamp: new Date().toISOString(),
        };
      }
      const attempt = await this.attemptLAN(peer, request.payload, messageId);
      attempts.push(attempt);

      if (attempt.status === 'success') {
        this.logDBSuccess(messageId, target, 'dm', 'lan', request.payload, attempts);
        return {
          ok: true,
          messageId,
          target,
          targetType: 'dm',
          route: 'lan',
          status: 'delivered',
          attempts,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        ok: false,
        error: attempt.error ?? 'LAN delivery failed',
        code: A2A_ERROR_CODES.LAN_UNAVAILABLE,
        attempts,
        timestamp: new Date().toISOString(),
      };
    }

    // Forced relay
    if (route === 'relay') {
      const attempt = await this.attemptRelay(qualified, request.payload, messageId);
      attempts.push(attempt);

      if (attempt.status === 'success') {
        this.logDBSuccess(messageId, target, 'dm', 'relay', request.payload, attempts);
        return {
          ok: true,
          messageId,
          target,
          targetType: 'dm',
          route: 'relay',
          status: 'delivered',
          attempts,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        ok: false,
        error: attempt.error ?? 'Relay delivery failed',
        code: A2A_ERROR_CODES.RELAY_UNAVAILABLE,
        attempts,
        timestamp: new Date().toISOString(),
      };
    }

    // Auto: try LAN first (if peer in config), fall back to relay
    if (peer) {
      const lanAttempt = await this.attemptLAN(peer, request.payload, messageId);
      attempts.push(lanAttempt);

      if (lanAttempt.status === 'success') {
        this.logDBSuccess(messageId, target, 'dm', 'lan', request.payload, attempts);
        return {
          ok: true,
          messageId,
          target,
          targetType: 'dm',
          route: 'lan',
          status: 'delivered',
          attempts,
          timestamp: new Date().toISOString(),
        };
      }

      log.info(`LAN failed for ${target}, falling back to relay`, { messageId });
    }

    // Relay fallback (or relay-only if no peer)
    const relayAttempt = await this.attemptRelay(qualified, request.payload, messageId);
    attempts.push(relayAttempt);

    if (relayAttempt.status === 'success') {
      this.logDBSuccess(messageId, target, 'dm', 'relay', request.payload, attempts);
      return {
        ok: true,
        messageId,
        target,
        targetType: 'dm',
        route: 'relay',
        status: 'delivered',
        attempts,
        timestamp: new Date().toISOString(),
      };
    }

    return {
      ok: false,
      error: 'All delivery routes failed',
      code: A2A_ERROR_CODES.DELIVERY_FAILED,
      attempts,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Group Send ───────────────────────────────────────────────

  private async sendGroup(
    request: A2ASendRequest,
    messageId: string,
    attempts: DeliveryAttempt[],
  ): Promise<A2AGroupSendResponse | A2ASendError> {
    const groupId = request.group!;

    // Groups always go via relay
    const network = this.deps.getNetworkClient();
    if (!network) {
      return {
        ok: false,
        error: 'Network SDK not available for group send',
        code: A2A_ERROR_CODES.RELAY_UNAVAILABLE,
        timestamp: new Date().toISOString(),
      };
    }

    const startTime = Date.now();
    try {
      const result = await network.sendToGroup(groupId, request.payload);
      const latencyMs = Date.now() - startTime;

      const attempt: DeliveryAttempt = {
        route: 'relay',
        status: 'success',
        latencyMs,
      };
      attempts.push(attempt);

      // Story 4: Log relay send for groups
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: this.agentName,
        to: `group:${groupId}`,
        type: request.payload.type,
        text: request.payload.text,
        messageId,
        latencyMs,
        status: 'success',
      });

      // Story 5: DB audit trail for groups
      this.logDBSuccess(messageId, groupId, 'group', 'relay', request.payload, attempts);

      return {
        ok: true,
        messageId,
        target: groupId,
        targetType: 'group',
        route: 'relay',
        status: 'delivered',
        attempts,
        delivered: result.delivered,
        queued: result.queued,
        failed: result.failed,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);
      const attempt: DeliveryAttempt = {
        route: 'relay',
        status: 'failed',
        error,
        latencyMs,
      };
      attempts.push(attempt);

      // Story 4: Log failed relay send for groups
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: this.agentName,
        to: `group:${groupId}`,
        type: request.payload.type,
        text: request.payload.text,
        messageId,
        latencyMs,
        status: 'failed',
        error,
      });

      return {
        ok: false,
        error: `Group send failed: ${error}`,
        code: A2A_ERROR_CODES.DELIVERY_FAILED,
        attempts,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ── LAN Attempt ──────────────────────────────────────────────

  private async attemptLAN(
    peer: PeerConfig,
    payload: A2ASendRequest['payload'],
    messageId: string,
  ): Promise<DeliveryAttempt> {
    const secret = await this.deps.getAgentCommsSecret();
    if (!secret) {
      return {
        route: 'lan',
        status: 'failed',
        error: 'Agent comms secret not found in Keychain',
        latencyMs: 0,
      };
    }

    // Build the AgentMessage by flattening payload fields
    const { type, text, ...remainingPayload } = payload;
    const msg: AgentMessage = {
      from: this.agentName,
      type,
      text,
      ...remainingPayload,
      messageId,
      timestamp: new Date().toISOString(),
    };

    const startTime = Date.now();
    try {
      const result = await this.deps.sendViaLAN(peer, msg, secret, this.agentName);
      const latencyMs = Date.now() - startTime;

      // sendViaLAN already logs internally (Story 4 note: do NOT double-log LAN)
      if (result.ok === true) {
        return { route: 'lan', status: 'success', latencyMs };
      }
      return {
        route: 'lan',
        status: 'failed',
        error: (result.error as string) ?? 'LAN delivery failed',
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        route: 'lan',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        latencyMs,
      };
    }
  }

  // ── Relay Attempt ────────────────────────────────────────────

  private async attemptRelay(
    qualifiedName: string,
    payload: A2ASendRequest['payload'],
    messageId: string,
  ): Promise<DeliveryAttempt> {
    const network = this.deps.getNetworkClient();
    if (!network) {
      return {
        route: 'relay',
        status: 'failed',
        error: 'Network SDK not available',
        latencyMs: 0,
      };
    }

    const startTime = Date.now();
    try {
      const result = await network.send(qualifiedName, payload);
      const latencyMs = Date.now() - startTime;

      const success = result.status === 'delivered' || result.status === 'queued';

      // Story 4: Log relay send
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: this.agentName,
        to: qualifiedName,
        type: payload.type,
        text: payload.text,
        messageId,
        latencyMs,
        status: success ? 'success' : 'failed',
        error: result.error,
      });

      if (success) {
        return { route: 'relay', status: 'success', latencyMs };
      }

      return {
        route: 'relay',
        status: 'failed',
        error: result.error ?? 'Relay delivery failed',
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const error = err instanceof Error ? err.message : String(err);

      // Story 4: Log failed relay send
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: this.agentName,
        to: qualifiedName,
        type: payload.type,
        text: payload.text,
        messageId,
        latencyMs,
        status: 'failed',
        error,
      });

      return {
        route: 'relay',
        status: 'failed',
        error,
        latencyMs,
      };
    }
  }

  // ── Story 5: DB Audit Trail ──────────────────────────────────

  private logDBSuccess(
    messageId: string,
    target: string,
    targetType: 'dm' | 'group',
    usedRoute: 'lan' | 'relay',
    payload: A2ASendRequest['payload'],
    attempts: DeliveryAttempt[],
  ): void {
    try {
      if (targetType === 'group') {
        this.deps.sendMessage({
          from: 'comms',
          to: `a2a:group:${target}`,
          type: 'text',
          body: JSON.stringify(payload),
          metadata: { channel: 'a2a', group_id: target, route: usedRoute, messageId },
        });
      } else {
        this.deps.sendMessage({
          from: 'comms',
          to: `a2a:${target}`,
          type: 'text',
          body: JSON.stringify(payload),
          metadata: { channel: 'a2a', route: usedRoute, messageId, attempts },
        });
      }
    } catch (err) {
      // Don't fail the send if DB logging fails -- just log a warning
      log.warn('Failed to log A2A send to DB', {
        error: err instanceof Error ? err.message : String(err),
        messageId,
      });
    }
  }
}
