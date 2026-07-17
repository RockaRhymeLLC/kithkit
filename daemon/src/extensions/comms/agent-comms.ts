/**
 * Agent-to-Agent Communication — receive, validate, inject, send, log.
 *
 * Handles both inbound (from peers) and outbound (to peers) messaging.
 * Messages are injected into the tmux session with [Agent] prefix.
 * LAN-direct HTTP communication between peers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readKeychain } from '../../core/keychain.js';
import { getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { KithkitConfig } from '../../core/config.js';
// Persist-on-receive: mirror the relay path (sdk-bridge.ts uses sendMessage + direct).
// Extraction-friendly seam: when agent-comms is extracted into kithkit-a2a-client (#116),
// this import migrates with it.
import { sendMessage } from '../../agents/message-router.js';
import type { MessageType } from '../../agents/message-router.js';
import { commsSessionExists } from '../../core/session-bridge.js';

const log = createLogger('agent-comms');
const VALID_TYPES = ['text', 'status', 'coordination', 'pr-review'];

// Injectable seam: tests swap this to avoid macOS Keychain access.
// Production always uses the real readKeychain (never throws; returns null on
// locked/absent/timeout — the threat model is documented in #3148).
let _hmacKeychainReader: (service: string) => Promise<string | null> = readKeychain;

export function _setHmacKeychainReaderForTesting(
  reader: (service: string) => Promise<string | null>,
): void {
  _hmacKeychainReader = reader;
}
export function _resetHmacKeychainReaderForTesting(): void {
  _hmacKeychainReader = readKeychain;
}

// ── Types ────────────────────────────────────────────────────

export interface PeerConfig {
  name: string;
  host: string;
  port: number;
  ip?: string;
}

interface AgentCommsConfig {
  enabled: boolean;
  secret?: string;
  peers?: PeerConfig[];
}

interface CommsConfig extends KithkitConfig {
  'agent-comms'?: AgentCommsConfig;
}

export interface AgentMessage {
  from: string;
  type: string;
  text?: string;
  status?: string;
  action?: string;
  task?: string;
  context?: unknown;
  messageId: string;
  timestamp: string;
  [key: string]: unknown;
}

// ── State ─────────────────────────────────────────────────────
let _config: CommsConfig | null = null;

// Router reference for delegating sends through the unified A2A router
let _router: { send: (body: unknown) => Promise<{ ok: boolean; status?: string; error?: string }> } | null = null;

export function setRouter(router: { send: (body: unknown) => Promise<{ ok: boolean; status?: string; error?: string }> }): void {
  _router = router;
}

// Runtime peer IP overrides (from LAN discovery)
const _peerIPOverrides = new Map<string, { ip: string; updatedAt: number }>();
const IP_OVERRIDE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function setPeerIpOverride(peerName: string, ip: string): void {
  const key = peerName.toLowerCase();
  _peerIPOverrides.set(key, { ip, updatedAt: Date.now() });
}

export function getPeerIpOverride(peerName: string): string | null {
  const key = peerName.toLowerCase();
  const entry = _peerIPOverrides.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > IP_OVERRIDE_TTL_MS) {
    _peerIPOverrides.delete(key);
    return null;
  }
  return entry.ip;
}

// ── Peer State Tracking ───────────────────────────────────────
/**
 * Tracks peer reachability state as observed by the heartbeat task.
 * Distinguished states:
 *   idle                  — peer is reachable via direct LAN path
 *   unknown               — non-mDNS peer send failed (original behaviour)
 *   unreachable           — mDNS peer unreachable via both .lan DNS AND relay
 *   local-dns-indeterminate — .lan DNS probe failed but relay confirmed peer alive;
 *                             peer is healthy, local DNS path is broken
 */
export interface PeerState {
  status: 'idle' | 'unknown' | 'unreachable' | 'local-dns-indeterminate';
  updatedAt: number;
}

const _peerStates = new Map<string, PeerState>();

export function updatePeerState(peerName: string, state: PeerState): void {
  _peerStates.set(peerName.toLowerCase(), state);
}

export function getPeerState(peerName: string): PeerState | undefined {
  return _peerStates.get(peerName.toLowerCase());
}

// ── Peer Lookup ──────────────────────────────────────────────
export function getPeerByName(name: string): PeerConfig | undefined {
  const peers = (_config as CommsConfig)?.['agent-comms']?.peers ?? [];
  return peers.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

export function getAllConfiguredPeers(): PeerConfig[] {
  return (_config as CommsConfig)?.['agent-comms']?.peers ?? [];
}

// ── Display Name ──────────────────────────────────────────────
export function getDisplayName(agentId: string): string {
  const peers = (_config as CommsConfig)?.['agent-comms']?.peers ?? [];
  for (const peer of peers) {
    if (peer.name.toLowerCase() === agentId.toLowerCase()) {
      return peer.name;
    }
  }
  return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

// ── Message Formatting ────────────────────────────────────────
function formatMessage(msg: AgentMessage): string {
  const name = getDisplayName(msg.from);
  switch (msg.type) {
    case 'text':
      return `[Agent] ${name}: ${msg.text ?? ''}`;
    case 'status':
      return `[Agent] ${name}: [Status: ${msg.status ?? msg.text ?? 'unknown'}]`;
    case 'coordination': {
      const action = msg.action ?? 'unknown';
      const task = msg.task ?? msg.text ?? '';
      return `[Agent] ${name}: [Coordination: ${action} "${task}"]`;
    }
    case 'pr-review': {
      const parts: string[] = ['PR review request'];
      if (msg.repo) parts.push(`repo: ${msg.repo}`);
      if (msg.branch) parts.push(`branch: ${msg.branch}`);
      if (msg.pr) parts.push(`PR #${msg.pr}`);
      if (msg.text) parts.push(msg.text);
      return `[Agent] ${name}: [${parts.join(', ')}]`;
    }
    default:
      return `[Agent] ${name}: ${msg.text ?? JSON.stringify(msg)}`;
  }
}

// ── JSONL Logging ─────────────────────────────────────────────
const COMMS_LOG_MAX_SIZE = 5 * 1024 * 1024;
const COMMS_LOG_MAX_FILES = 3;

function getLogPath(): string {
  return path.join(getProjectDir(), 'logs', 'agent-comms.log');
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size < COMMS_LOG_MAX_SIZE) return;
    for (let i = COMMS_LOG_MAX_FILES - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i + 1 >= COMMS_LOG_MAX_FILES) {
          fs.unlinkSync(src);
        } else {
          fs.renameSync(src, dst);
        }
      }
    }
    fs.renameSync(logPath, `${logPath}.1`);
    log.info('Rotated agent-comms.log');
  } catch (err) {
    log.warn('Failed to rotate agent-comms.log', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function logCommsEntry(entry: Record<string, unknown>): void {
  const logPath = getLogPath();
  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  rotateLogIfNeeded(logPath);
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ── Validation ────────────────────────────────────────────────
function validateMessage(body: unknown): { valid: boolean; error?: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }
  const msg = body as Record<string, unknown>;
  if (!msg.from || typeof msg.from !== 'string') {
    return { valid: false, error: "'from' is required and must be a string" };
  }
  if (!msg.type || typeof msg.type !== 'string') {
    return { valid: false, error: "'type' is required and must be a string" };
  }
  if (!VALID_TYPES.includes(msg.type as string)) {
    return { valid: false, error: `Invalid message type '${msg.type}'. Valid: ${VALID_TYPES.join(', ')}` };
  }
  if (!msg.messageId || typeof msg.messageId !== 'string') {
    return { valid: false, error: "'messageId' is required and must be a string" };
  }
  if (!msg.timestamp || typeof msg.timestamp !== 'string') {
    return { valid: false, error: "'timestamp' is required and must be a string" };
  }
  return { valid: true };
}

// ── Handle Incoming ───────────────────────────────────────────
/**
 * Handle an incoming LAN agent message.
 */
export async function handleAgentMessage(
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const validation = validateMessage(body);
  if (!validation.valid) {
    log.warn('Agent message rejected: invalid structure', { error: validation.error });
    return {
      status: 400,
      body: { error: validation.error },
    };
  }

  const msg = body as AgentMessage;

  // Status pings (peer heartbeats) — log only, don't inject into comms session.
  // Injecting these burns LLM tokens every 5 minutes with no actionable value.
  if (msg.type === 'status') {
    log.debug(`Status ping from ${msg.from} — acknowledged, not injected`, {
      messageId: msg.messageId,
      status: msg.status,
    });

    const agentName = _config?.agent?.name?.toLowerCase() ?? 'unknown';
    logCommsEntry({
      ts: new Date().toISOString(),
      direction: 'in',
      from: msg.from,
      to: agentName,
      type: msg.type,
      text: msg.text,
      status: msg.status,
      messageId: msg.messageId,
      injected: false,
    });

    return {
      status: 200,
      body: { ok: true, queued: false },
    };
  }

  const formatted = formatMessage(msg);

  // Persist-before-inject: INSERT to DB unconditionally before any tmux side-effect.
  // Mirror of sdk-bridge.ts relay path (sendMessage({..., direct:true})).
  //
  // BMO decision #1 (#585): from_agent = bare name (msg.from, no transport prefix).
  // Both LAN and relay paths now persist bare sender identity (relay-path prefix
  // 'network:${sender}' stripped in sdk-bridge.ts, bare-identity invariant #585).
  //
  // BMO decision #2 (#585): messages.type column is free TEXT (no CHECK constraint).
  // msg.type is stored as-sent. MessageType has been widened to include 'coordination'
  // and 'pr-review' (LAN-valid types) to avoid application-layer coercion loss.
  //
  // to: 'comms' — correct and forced by protocol design (not a rationalization).
  //
  // The LAN AgentMessage type has NO to/recipient/target/recipientAgent field:
  // only from, type, text, status, action, task, context, messageId, timestamp.
  // validateMessage() enforces none either. This endpoint (/agent/message) is a
  // comms-inbound-only path — peers address this agent (comms), not internal
  // sub-agents. There is no mechanism for a peer to LAN-target the orchestrator
  // through this endpoint; orchestrator messages reach it via the daemon's internal
  // inter-agent system (sendMessage + isPersistentAgent('orchestrator')), not via
  // inbound LAN POST. Hardcoding to:'comms' is the only correct option on this path.
  //
  // BMO decision #3 (#585): to_agent='comms' is the canonical recipient for all
  // LAN inbound messages. isPersistentAgent() in message-router fires the
  // direct-channel inject path. agentName is used for logging only.
  const persisted = sendMessage({
    from: msg.from,
    to: 'comms',
    type: msg.type as MessageType,
    body: formatted,
    metadata: { source: 'lan', messageId: msg.messageId },
    direct: true,
  });

  // injected_at stamped in message-router.ts direct-inject path (BMO decision #3, #585).

  const agentName = _config?.agent?.name?.toLowerCase() ?? 'unknown';
  if (persisted.delivered) {
    log.info(`Delivered message from ${msg.from}`, {
      messageId: msg.messageId,
      type: msg.type,
      dbId: persisted.messageId,
    });
  } else if (commsSessionExists()) {
    // Dead-letter: session is alive but inject failed. Message is persisted and
    // queued for retry via the message-delivery scheduler, but this is unexpected
    // and warrants an ERROR so it surfaces in log monitoring (#585).
    log.error(`DEAD-LETTER: inject failed despite live comms session — message queued for retry`, {
      from: msg.from,
      messageId: msg.messageId,
      dbId: persisted.messageId,
      type: msg.type,
    });
  } else {
    // Session absent — normal pending state, not a delivery error.
    // The message-delivery scheduler will inject when the session restarts.
    log.info(`Message persisted, comms session absent — queued for delivery`, {
      from: msg.from,
      messageId: msg.messageId,
      dbId: persisted.messageId,
    });
  }

  logCommsEntry({
    ts: new Date().toISOString(),
    direction: 'in',
    from: msg.from,
    to: agentName,
    type: msg.type,
    text: msg.text,
    messageId: msg.messageId,
    delivered: persisted.delivered,
  });

  // TODO(#124, #620): ack-semantics slot.
  // Sender currently receives ok:true as soon as the DB row is created.
  // Future: a positive ACK should only be returned after confirmed inject
  // (or explicit delivery receipt from the comms session). This requires
  // a protocol-level change in the LAN message exchange (#620 ten-four ACK
  // protocol) and the per-message acknowledgement model (#124).
  // queued:true is an interim observable for callers that want to distinguish
  // persisted-but-not-yet-injected from confirmed delivery.

  return {
    status: 200,
    body: { ok: true, queued: !persisted.delivered },
  };
}

// ── Peer Host Resolver ───────────────────────────────────────
/**
 * Build the ordered list of addresses to try when reaching a peer.
 * Priority: env override (highest) → static .ip → .host (lowest / fallback).
 * If .ip is unset the resolver falls through to .host automatically (#785b).
 *
 * Exported for unit-testing the resolution order without spawning curl.
 */
export function buildPeerHosts(peer: PeerConfig, overrideIP: string | null): string[] {
  const hosts: string[] = [];
  if (overrideIP) hosts.push(overrideIP);
  // IP-primary: prefer static .ip address; fall back to .host if .ip is unset (#785b)
  if (peer.ip && peer.ip !== overrideIP) hosts.push(peer.ip);
  if (peer.host && peer.host !== peer.ip && peer.host !== overrideIP) hosts.push(peer.host);
  return hosts;
}

/**
 * Compute X-Signature HMAC curl headers for an outbound LAN message.
 *
 * Returns [] and logs at ERROR when the shared secret is unavailable.
 * readKeychain never throws — null means absent entry, locked Keychain, or
 * timeout. Post-#3148: enforcing peers REJECT unsigned messages (fail-closed,
 * not fail-open). A null secret is a visible partition failure, not a safe
 * fallback. todo #3225(b): refuse-to-send when peer posture=enforce (requires
 * posture discovery, deferred to follow-on).
 *
 * Exported for mutation-kill testing (#3225).
 */
export async function _resolveHmacSignatureHeaders(payload: string): Promise<string[]> {
  try {
    const secret = await _hmacKeychainReader('credential-agent-comms-secret');
    if (!secret) {
      // credential-agent-comms-secret is absent, Keychain locked, or timed out.
      // Post-#3148 enforcing peers REJECT unsigned messages — this is a visible
      // partition failure, not a safe fallback. Operator must fix Keychain access.
      // todo #3225(b): block send when peer posture=enforce.
      log.error(
        'HMAC: credential-agent-comms-secret unavailable — message will be sent unsigned and REJECTED by enforcing peers',
        { cause: 'null-secret: key absent, Keychain locked, or readKeychain timed out' },
      );
      return [];
    }
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return ['-H', `X-Signature: ${hmac.digest('hex')}`];
  } catch (err) {
    // Defensive: readKeychain is documented not to throw, but guard clearly if
    // that contract is ever violated. Post-#3148: send-unsigned = peer REJECT.
    log.error(
      'HMAC: unexpected keychain error — message will be sent unsigned and REJECTED by enforcing peers',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return [];
  }
}

// ── LAN Send (curl) ──────────────────────────────────────────
export async function sendViaLAN(
  peer: PeerConfig,
  msg: AgentMessage,
  agentName: string,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(msg);
  const overrideIP = getPeerIpOverride(peer.name);
  const hosts = buildPeerHosts(peer, overrideIP);

  const signatureHeaders = await _resolveHmacSignatureHeaders(payload);

  const startTime = Date.now();

  return new Promise((resolve) => {
    const trySend = (hostIdx: number) => {
      const host = hosts[hostIdx];
      const url = `http://${host}:${peer.port}/agent/message`;

      const args = [
        '-s', '--connect-timeout', '5',
        '-w', '\n%{http_code}',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        ...signatureHeaders,
        '--data-raw', payload,
      ];

      execFile('curl', args, { timeout: 10000 }, (err, stdout, stderr) => {
        const latencyMs = Date.now() - startTime;

        if (err) {
          if (hostIdx + 1 < hosts.length) {
            log.info(`Connection to ${peer.name} (${host}) failed, trying fallback IP ${hosts[hostIdx + 1]}`);
            trySend(hostIdx + 1);
            return;
          }
          const detail = stderr?.trim() || err.message || 'unknown error';
          const errorResponse = {
            ok: false,
            queued: false,
            error: `Failed to reach peer ${peer.name} (${peer.host}:${peer.port}): ${detail}`,
          };
          logCommsEntry({
            ts: new Date().toISOString(),
            direction: 'out',
            from: agentName,
            to: peer.name,
            type: msg.type,
            text: msg.text,
            messageId: msg.messageId,
            latencyMs,
            error: errorResponse.error,
          });
          log.error(`LAN send failed to ${peer.name}`, { error: detail, latencyMs });
          resolve(errorResponse);
          return;
        }

        const lines = stdout.trimEnd().split('\n');
        const httpStatus = parseInt(lines.pop() ?? '', 10) || undefined;
        const responseBody = lines.join('\n');

        try {
          const response = JSON.parse(responseBody);
          logCommsEntry({
            ts: new Date().toISOString(),
            direction: 'out',
            from: agentName,
            to: peer.name,
            type: msg.type,
            text: msg.text,
            messageId: msg.messageId,
            httpStatus,
            latencyMs,
          });
          log.info(`Sent to ${peer.name} via LAN`, {
            messageId: msg.messageId,
            type: msg.type,
            httpStatus,
            latencyMs,
          });
          resolve(response);
        } catch {
          const errorResponse = {
            ok: false,
            queued: false,
            error: `Invalid response from peer (HTTP ${httpStatus ?? '?'}): ${responseBody.slice(0, 200)}`,
          };
          logCommsEntry({
            ts: new Date().toISOString(),
            direction: 'out',
            from: agentName,
            to: peer.name,
            type: msg.type,
            text: msg.text,
            messageId: msg.messageId,
            httpStatus,
            latencyMs,
            error: errorResponse.error,
          });
          log.warn(`Bad LAN response from ${peer.name}`, { httpStatus, latencyMs });
          resolve(errorResponse);
        }
      });
    };
    trySend(0);
  });
}

// ── Send Outgoing ─────────────────────────────────────────────
export async function sendAgentMessage(
  peerName: string,
  type: string,
  text: string,
  extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // If router available, delegate to it
  if (_router) {
    const request = {
      to: peerName,
      payload: { type, text, ...extra },
      route: 'auto' as const,
    };
    const result = await _router.send(request);
    return {
      ok: result.ok,
      queued: result.ok && result.status === 'queued',
      error: result.ok ? undefined : (result as { error?: string }).error,
    };
  }

  // Fallback to original implementation if router not set
  if (!_config) {
    return { ok: false, queued: false, error: 'Agent comms not initialized' };
  }

  const agentComms = (_config as CommsConfig)['agent-comms'];
  if (!agentComms?.enabled) {
    return { ok: false, queued: false, error: 'Agent comms not enabled' };
  }

  const peer = agentComms.peers?.find(
    (p) => p.name.toLowerCase() === peerName.toLowerCase(),
  );
  if (!peer) {
    return { ok: false, queued: false, error: `Unknown peer: ${peerName}` };
  }

  const agentName = _config.agent.name.toLowerCase();

  const msg: AgentMessage = {
    from: agentName,
    type,
    text,
    timestamp: new Date().toISOString(),
    messageId: crypto.randomUUID(),
    ...extra,
  };

  return sendViaLAN(peer, msg, agentName) as Promise<Record<string, unknown>>;
}

// ── Agent Status ──────────────────────────────────────────────
export function getAgentStatus(): Record<string, unknown> {
  return {
    agent: _config?.agent?.name ?? 'unknown',
    status: 'idle',
    uptime: process.uptime(),
  };
}

// ── Init / Shutdown ───────────────────────────────────────────
export function initAgentComms(config: KithkitConfig): void {
  _config = config as CommsConfig;
  const agentComms = (_config as CommsConfig)['agent-comms'];
  if (!agentComms?.enabled) {
    log.info('Agent comms disabled');
    return;
  }
  log.info('Agent comms initialized', {
    peers: agentComms.peers?.length ?? 0,
    peerNames: agentComms.peers?.map((p) => p.name) ?? [],
  });
}

export function stopAgentComms(): void {
  _config = null;
  _peerStates.clear();
  log.info('Agent comms stopped');
}

/**
 * Refresh the agent-comms config in-place after a hot reload.
 * Updates the cached peer list and other settings without restarting.
 */
export function refreshAgentCommsConfig(config: KithkitConfig): void {
  _config = config as CommsConfig;
}
