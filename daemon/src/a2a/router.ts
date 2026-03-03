/**
 * Unified A2A Router — core routing logic for the POST /api/a2a/send endpoint.
 *
 * Uses constructor injection for all dependencies (no direct imports from extensions).
 * Supports DM (to) and group messaging, with auto/lan/relay route selection,
 * LAN-first with relay fallback, stale heartbeat detection, and JSONL logging.
 */

import crypto from 'node:crypto';
import type {
  A2ASendRequest,
  A2ASendResponse,
  A2ASendError,
  A2ASendResult,
  DeliveryAttempt,
  ErrorCode,
} from './types.js';
import type { AgentConfig, PeerConfig } from '../extensions/config.js';
import type {
  AgentMessage,
  AgentMessageResponse,
  PeerState,
  CommsLogEntry,
} from '../extensions/comms/agent-comms.js';

// ── Dependency Injection ─────────────────────────────────────

export interface RouterDeps {
  config: AgentConfig;
  sendViaLAN: (peer: PeerConfig, msg: AgentMessage, secret: string, agentName: string) => Promise<AgentMessageResponse>;
  getNetworkClient: () => any | null;
  getPeerState: (name: string) => PeerState | undefined;
  logCommsEntry: (entry: CommsLogEntry) => void;
  readKeychain: (name: string) => Promise<string | null>;
  sendDbMessage?: (msg: { from: string; to: string; type: string; body: string; metadata?: Record<string, unknown> }) => void;
}

// ── Constants ────────────────────────────────────────────────

/** Peer heartbeat older than this (ms) means stale — skip LAN, go relay. */
const STALE_HEARTBEAT_MS = 300_000; // 5 minutes

const VALID_ROUTES = new Set(['auto', 'lan', 'relay']);

// ── Router ───────────────────────────────────────────────────

export class UnifiedA2ARouter {
  private readonly deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  // ── Validation ─────────────────────────────────────────────

  validate(body: unknown): A2ASendError | null {
    if (!body || typeof body !== 'object') {
      return this.error('INVALID_REQUEST', 'Request body must be a JSON object');
    }

    const req = body as Record<string, unknown>;

    // Exactly one of to/group
    const hasTo = req.to !== undefined && req.to !== null;
    const hasGroup = req.group !== undefined && req.group !== null;

    if (hasTo && hasGroup) {
      return this.error('INVALID_TARGET', 'Specify exactly one of "to" or "group", not both');
    }
    if (!hasTo && !hasGroup) {
      return this.error('INVALID_TARGET', 'Specify exactly one of "to" or "group"');
    }

    // Payload validation
    if (!req.payload || typeof req.payload !== 'object') {
      return this.error('INVALID_REQUEST', '"payload" is required and must be an object');
    }

    const payload = req.payload as Record<string, unknown>;
    if (!payload.type || typeof payload.type !== 'string') {
      return this.error('INVALID_REQUEST', '"payload.type" is required and must be a string');
    }

    // Route validation
    if (req.route !== undefined) {
      if (typeof req.route !== 'string' || !VALID_ROUTES.has(req.route)) {
        return this.error('INVALID_REQUEST', `"route" must be one of: auto, lan, relay`);
      }
    }

    // group + lan = invalid
    if (hasGroup && req.route === 'lan') {
      return this.error('INVALID_ROUTE', 'Cannot use route "lan" with group targets — groups require relay');
    }

    return null;
  }

  // ── Peer Resolution ────────────────────────────────────────

  resolvePeer(name: string): { peer?: PeerConfig; qualifiedName: string; error?: A2ASendError } {
    // Qualified name (contains @) — skip config lookup, use as-is for relay
    if (name.includes('@')) {
      return { qualifiedName: name };
    }

    // Bare name — look up in config
    const peers = this.deps.config['agent-comms']?.peers ?? [];
    const peer = peers.find(p => p.name.toLowerCase() === name.toLowerCase());

    if (!peer) {
      return {
        qualifiedName: name,
        error: this.error('PEER_NOT_FOUND', `Unknown peer: "${name}"`),
      };
    }

    // Qualify for relay using community config (same logic as resolveP2PName in agent-comms.ts)
    const qualifiedName = this.qualifyPeerName(name, peer);

    return { peer, qualifiedName };
  }

  // ── Main Send ──────────────────────────────────────────────

  async send(body: unknown): Promise<A2ASendResult> {
    // Validate
    const validationError = this.validate(body);
    if (validationError) return validationError;

    const request = body as A2ASendRequest;
    const messageId = crypto.randomUUID();
    const agentName = this.deps.config.agent?.name?.toLowerCase() ?? 'unknown';
    const route = request.route ?? 'auto';
    const isGroup = !!request.group;
    const target = isGroup ? request.group! : request.to!;
    const attempts: DeliveryAttempt[] = [];

    // ── Group messages ───────────────────────────────────────

    if (isGroup) {
      // Groups always go through relay
      if (route === 'lan') {
        // Already caught by validate, but defensive
        return this.error('INVALID_ROUTE', 'Cannot use route "lan" with group targets');
      }

      const relayAttempt = await this.sendRelay(target, request.payload, true, target, messageId, agentName);
      attempts.push(relayAttempt);

      if (relayAttempt.status === 'success') {
        this.auditGroup(target, request.payload, 'relay', messageId);
        return this.success(messageId, target, 'group', 'relay', 'delivered', attempts);
      }

      return this.errorWithAttempts('DELIVERY_FAILED', `Group delivery failed: ${relayAttempt.error}`, attempts);
    }

    // ── DM messages ──────────────────────────────────────────

    const resolution = this.resolvePeer(target);
    if (resolution.error) return resolution.error;

    // Forced LAN
    if (route === 'lan') {
      if (!resolution.peer) {
        return this.error('LAN_UNAVAILABLE', `Peer "${target}" not configured for LAN`);
      }
      const lanAttempt = await this.sendLAN(resolution.peer, messageId, request.payload, agentName);
      attempts.push(lanAttempt);

      if (lanAttempt.status === 'success') {
        this.auditDM(target, request.payload, 'lan', messageId, attempts);
        return this.success(messageId, target, 'dm', 'lan', 'delivered', attempts);
      }
      return this.errorWithAttempts('DELIVERY_FAILED', `LAN delivery failed: ${lanAttempt.error}`, attempts);
    }

    // Forced relay
    if (route === 'relay') {
      const client = this.deps.getNetworkClient();
      if (!client) {
        return this.error('RELAY_UNAVAILABLE', 'Network SDK not initialized');
      }

      const relayAttempt = await this.sendRelay(resolution.qualifiedName, request.payload, false, undefined, messageId, agentName);
      attempts.push(relayAttempt);

      if (relayAttempt.status === 'success') {
        const relayStatus = (relayAttempt as any)._sdkStatus === 'queued' ? 'queued' as const : 'delivered' as const;
        this.auditDM(target, request.payload, 'relay', messageId, attempts);
        return this.success(messageId, target, 'dm', 'relay', relayStatus, attempts);
      }
      return this.errorWithAttempts('DELIVERY_FAILED', `Relay delivery failed: ${relayAttempt.error}`, attempts);
    }

    // Auto route
    return this.sendAuto(resolution, target, messageId, request.payload, agentName, attempts);
  }

  // ── Auto Route Logic ───────────────────────────────────────

  private async sendAuto(
    resolution: { peer?: PeerConfig; qualifiedName: string },
    target: string,
    messageId: string,
    payload: A2ASendRequest['payload'],
    agentName: string,
    attempts: DeliveryAttempt[],
  ): Promise<A2ASendResult> {
    // Check peer liveness — if stale heartbeat, skip LAN
    let tryLAN = !!resolution.peer;

    if (resolution.peer) {
      const peerState = this.deps.getPeerState(resolution.peer.name);
      if (peerState) {
        const age = Date.now() - peerState.updatedAt;
        if (age > STALE_HEARTBEAT_MS) {
          tryLAN = false; // Stale heartbeat — skip LAN, go straight to relay
        }
      }
    }

    // Try LAN first (if peer is configured and heartbeat is fresh)
    if (tryLAN && resolution.peer) {
      const lanAttempt = await this.sendLAN(resolution.peer, messageId, payload, agentName);
      attempts.push(lanAttempt);

      if (lanAttempt.status === 'success') {
        this.auditDM(target, payload, 'lan', messageId, attempts);
        return this.success(messageId, target, 'dm', 'lan', 'delivered', attempts);
      }
    }

    // Fallback to relay
    const client = this.deps.getNetworkClient();
    if (client) {
      const relayAttempt = await this.sendRelay(resolution.qualifiedName, payload, false, undefined, messageId, agentName);
      attempts.push(relayAttempt);

      if (relayAttempt.status === 'success') {
        const relayStatus = (relayAttempt as any)._sdkStatus === 'queued' ? 'queued' as const : 'delivered' as const;
        this.auditDM(target, payload, 'relay', messageId, attempts);
        return this.success(messageId, target, 'dm', 'relay', relayStatus, attempts);
      }
    }

    // All routes exhausted
    if (attempts.length === 0) {
      return this.error('DELIVERY_FAILED', `No transport available for peer "${target}"`);
    }
    return this.errorWithAttempts('DELIVERY_FAILED', `All delivery routes failed for "${target}"`, attempts);
  }

  // ── LAN Transport ──────────────────────────────────────────

  private async sendLAN(
    peer: PeerConfig,
    messageId: string,
    payload: A2ASendRequest['payload'],
    agentName: string,
  ): Promise<DeliveryAttempt> {
    const start = Date.now();

    try {
      const secret = await this.deps.readKeychain('credential-agent-comms-secret');
      if (!secret) {
        return {
          route: 'lan',
          status: 'failed',
          error: 'Agent comms secret not found in Keychain',
          latencyMs: Date.now() - start,
        };
      }

      // Build AgentMessage from payload fields
      const msg: AgentMessage = {
        from: agentName,
        type: payload.type,
        text: payload.text,
        timestamp: new Date().toISOString(),
        messageId,
        ...(payload.status && typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(payload.action && typeof payload.action === 'string' ? { action: payload.action } : {}),
        ...(payload.task && typeof payload.task === 'string' ? { task: payload.task } : {}),
        ...(payload.context && typeof payload.context === 'string' ? { context: payload.context } : {}),
      };

      const result = await this.deps.sendViaLAN(peer, msg, secret, agentName);
      const latencyMs = Date.now() - start;

      // NOTE: sendViaLAN already logs internally via logCommsEntry in agent-comms.ts.
      // The router does NOT call logCommsEntry for LAN sends (Story 4).

      if (result.ok) {
        return { route: 'lan', status: 'success', latencyMs };
      }
      return { route: 'lan', status: 'failed', error: result.error, latencyMs };
    } catch (err) {
      return {
        route: 'lan',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  // ── Relay Transport ────────────────────────────────────────

  private async sendRelay(
    target: string,
    payload: A2ASendRequest['payload'],
    isGroup: boolean,
    groupId: string | undefined,
    messageId: string,
    agentName: string,
  ): Promise<DeliveryAttempt> {
    const start = Date.now();

    const client = this.deps.getNetworkClient();
    if (!client) {
      return {
        route: 'relay',
        status: 'failed',
        error: 'Network SDK not initialized',
        latencyMs: Date.now() - start,
      };
    }

    try {
      const sendPayload = {
        ...payload,
        from: agentName,
        messageId,
        timestamp: new Date().toISOString(),
      };

      let sendResult: { status: string; error?: string };

      if (isGroup && groupId) {
        sendResult = await client.sendToGroup(groupId, sendPayload);
      } else {
        sendResult = await client.send(target, sendPayload);
      }

      const latencyMs = Date.now() - start;
      const ok = sendResult.status === 'delivered' || sendResult.status === 'queued';

      // Story 4: Log relay sends via logCommsEntry
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: agentName,
        to: target,
        type: payload.type as string,
        text: payload.text as string | undefined,
        messageId,
        ...(isGroup && groupId ? { groupId } : {}),
        ...(!ok && sendResult.error ? { error: sendResult.error } : {}),
      });

      if (ok) {
        const attempt: DeliveryAttempt & { _sdkStatus?: string } = {
          route: 'relay',
          status: 'success',
          latencyMs,
        };
        // Stash SDK status for the caller to distinguish delivered vs queued
        (attempt as any)._sdkStatus = sendResult.status;
        return attempt;
      }

      return {
        route: 'relay',
        status: 'failed',
        error: sendResult.error ?? 'Relay send failed',
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);

      // Log failed relay attempt
      this.deps.logCommsEntry({
        ts: new Date().toISOString(),
        direction: 'relay-out',
        from: agentName,
        to: target,
        type: payload.type as string,
        text: payload.text as string | undefined,
        messageId,
        ...(isGroup && groupId ? { groupId } : {}),
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

  // ── Peer Name Qualification ────────────────────────────────

  private qualifyPeerName(name: string, peer: PeerConfig): string {
    // Replicate resolveP2PName logic from agent-comms.ts:
    // If the peer has a community config and communities are configured,
    // qualify as name@hostname from the community's primary URL.
    const community = (peer as unknown as Record<string, unknown>).community as string | undefined;
    if (!community) return name;

    const communities = this.deps.config.network?.communities ?? [];
    if (!communities.length) return name;

    const communityConfig = communities.find(c => c.name === community);
    if (!communityConfig) return name;

    try {
      const hostname = new URL(communityConfig.primary).hostname;
      return `${name}@${hostname}`;
    } catch {
      return name;
    }
  }

  // ── DB Audit ───────────────────────────────────────────────

  private auditDM(
    target: string,
    payload: A2ASendRequest['payload'],
    finalRoute: 'lan' | 'relay',
    messageId: string,
    attempts: DeliveryAttempt[],
  ): void {
    if (this.deps.sendDbMessage) {
      try {
        this.deps.sendDbMessage({
          from: 'comms',
          to: `a2a:${target}`,
          type: 'text',
          body: JSON.stringify(payload),
          metadata: { channel: 'a2a', route: finalRoute, messageId, attempts: attempts.length },
        });
      } catch { /* don't fail send on audit error */ }
    }
  }

  private auditGroup(
    groupId: string,
    payload: A2ASendRequest['payload'],
    finalRoute: 'lan' | 'relay',
    messageId: string,
  ): void {
    if (this.deps.sendDbMessage) {
      try {
        this.deps.sendDbMessage({
          from: 'comms',
          to: `a2a:group:${groupId}`,
          type: 'text',
          body: JSON.stringify(payload),
          metadata: { channel: 'a2a', group_id: groupId, route: finalRoute, messageId },
        });
      } catch { /* don't fail send on audit error */ }
    }
  }

  // ── Response Builders ──────────────────────────────────────

  private error(code: ErrorCode, message: string): A2ASendError {
    return {
      ok: false,
      error: message,
      code,
      timestamp: new Date().toISOString(),
    };
  }

  private errorWithAttempts(code: ErrorCode, message: string, attempts: DeliveryAttempt[]): A2ASendError {
    return {
      ok: false,
      error: message,
      code,
      attempts,
      timestamp: new Date().toISOString(),
    };
  }

  private success(
    messageId: string,
    target: string,
    targetType: 'dm' | 'group',
    route: 'lan' | 'relay',
    status: 'delivered' | 'queued',
    attempts: DeliveryAttempt[],
  ): A2ASendResponse {
    return {
      ok: true,
      messageId,
      target,
      targetType,
      route,
      status,
      attempts,
      timestamp: new Date().toISOString(),
    };
  }
}
