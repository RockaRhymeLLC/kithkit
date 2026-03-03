/**
 * Agent-to-Agent Communication — receive, validate, inject, send, log.
 *
 * Handles both inbound (from peers) and outbound (to peers) messaging.
 * Messages are injected into the tmux session with [Agent] prefix.
 * LAN-direct HTTP communication using a shared secret for auth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readKeychain } from '../../core/keychain.js';
import { injectText } from '../../core/session-bridge.js';
import { getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { KithkitConfig } from '../../core/config.js';

const log = createLogger('agent-comms');
const VALID_TYPES = ['text', 'status', 'coordination', 'pr-review'];

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

// ── Peer Lookup ──────────────────────────────────────────────
export function getPeerByName(name: string): PeerConfig | undefined {
  const peers = (_config as CommsConfig)?.['agent-comms']?.peers ?? [];
  return peers.find((p) => p.name.toLowerCase() === name.toLowerCase());
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
 * Handle an incoming LAN agent message (Bearer auth).
 */
export async function handleAgentMessage(
  authToken: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Auth check (async keychain)
  const secret = await readKeychain('credential-agent-comms-secret');
  if (!authToken || !secret || authToken !== secret) {
    log.warn('Agent message rejected: invalid auth', { hasToken: !!authToken });
    return {
      status: 401,
      body: { error: 'Unauthorized: invalid or missing bearer token' },
    };
  }

  const validation = validateMessage(body);
  if (!validation.valid) {
    log.warn('Agent message rejected: invalid structure', { error: validation.error });
    return {
      status: 400,
      body: { error: validation.error },
    };
  }

  const msg = body as AgentMessage;
  const formatted = formatMessage(msg);

  // Skip tmux injection for status messages (idle heartbeats) — they burn
  // comms tokens for no value. Still log them for observability.
  if (msg.type === 'status') {
    log.debug(`Suppressed status injection from ${msg.from}`, {
      messageId: msg.messageId,
      status: msg.status,
    });
  } else {
    injectText(formatted);
  }

  log.info(`Delivered message from ${msg.from}`, {
    messageId: msg.messageId,
    type: msg.type,
  });

  const agentName = _config?.agent?.name?.toLowerCase() ?? 'unknown';
  logCommsEntry({
    ts: new Date().toISOString(),
    direction: 'in',
    from: msg.from,
    to: agentName,
    type: msg.type,
    text: msg.text,
    messageId: msg.messageId,
  });

  return {
    status: 200,
    body: { ok: true, queued: false },
  };
}

// ── LAN Send (curl) ──────────────────────────────────────────
export function sendViaLAN(
  peer: PeerConfig,
  msg: AgentMessage,
  secret: string,
  agentName: string,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(msg);
  const hosts = [peer.host];
  if (peer.ip && peer.ip !== peer.host) hosts.push(peer.ip);

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
        '-H', `Authorization: Bearer ${secret}`,
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

  const secret = await readKeychain('credential-agent-comms-secret');
  if (!secret) {
    return { ok: false, queued: false, error: 'Agent comms secret not found in Keychain' };
  }

  return sendViaLAN(peer, msg, secret, agentName) as Promise<Record<string, unknown>>;
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
  log.info('Agent comms stopped');
}
