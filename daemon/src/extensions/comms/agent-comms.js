/**
 * Agent-to-Agent Communication — receive, validate, inject, send, log.
 *
 * Handles both inbound (from peers) and outbound (to peers) messaging.
 * Messages are injected into the tmux session with [Agent] prefix.
 * 2-tier routing: LAN direct → P2P SDK fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { readKeychain } from '../../core/keychain.js';
import { injectText } from '../../core/session-bridge.js';
import { getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { getNetworkClient } from './network/sdk-bridge.js';
const log = createLogger('agent-comms');
const VALID_TYPES = ['text', 'status', 'coordination', 'pr-review'];
// ── State ─────────────────────────────────────────────────────
let _config = null;
// ── Display Name ──────────────────────────────────────────────
export function getDisplayName(agentId, config) {
    const cfg = config ?? _config;
    const peers = cfg?.['agent-comms']?.peers ?? [];
    for (const peer of peers) {
        if (peer.name.toLowerCase() === agentId.toLowerCase()) {
            return peer.name;
        }
    }
    return agentId.charAt(0).toUpperCase() + agentId.slice(1);
}
// ── Message Formatting ────────────────────────────────────────
function formatMessage(msg) {
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
            const parts = ['PR review request'];
            if (msg.repo)
                parts.push(`repo: ${msg.repo}`);
            if (msg.branch)
                parts.push(`branch: ${msg.branch}`);
            if (msg.pr)
                parts.push(`PR #${msg.pr}`);
            if (msg.text)
                parts.push(msg.text);
            return `[Agent] ${name}: [${parts.join(', ')}]`;
        }
        default:
            return `[Agent] ${name}: ${msg.text ?? JSON.stringify(msg)}`;
    }
}
// ── JSONL Logging ─────────────────────────────────────────────
const COMMS_LOG_MAX_SIZE = 5 * 1024 * 1024;
const COMMS_LOG_MAX_FILES = 3;
function getLogPath() {
    return path.join(getProjectDir(), 'logs', 'agent-comms.log');
}
function rotateCommsLogIfNeeded(logPath) {
    try {
        if (!fs.existsSync(logPath))
            return;
        const stats = fs.statSync(logPath);
        if (stats.size < COMMS_LOG_MAX_SIZE)
            return;
        for (let i = COMMS_LOG_MAX_FILES - 1; i >= 1; i--) {
            const src = `${logPath}.${i}`;
            const dst = `${logPath}.${i + 1}`;
            if (fs.existsSync(src)) {
                if (i + 1 >= COMMS_LOG_MAX_FILES) {
                    fs.unlinkSync(src);
                }
                else {
                    fs.renameSync(src, dst);
                }
            }
        }
        fs.renameSync(logPath, `${logPath}.1`);
        log.info('Rotated agent-comms.log');
    }
    catch (err) {
        log.warn('Failed to rotate agent-comms.log', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
export function logCommsEntry(entry) {
    const logPath = getLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    rotateCommsLogIfNeeded(logPath);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}
// ── Validation ────────────────────────────────────────────────
function validateMessage(body) {
    if (!body || typeof body !== 'object') {
        return { valid: false, error: 'Request body must be a JSON object' };
    }
    const msg = body;
    if (!msg.from || typeof msg.from !== 'string') {
        return { valid: false, error: "'from' is required and must be a string" };
    }
    if (!msg.type || typeof msg.type !== 'string') {
        return { valid: false, error: "'type' is required and must be a string" };
    }
    if (!VALID_TYPES.includes(msg.type)) {
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
export async function handleAgentMessage(authToken, body) {
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
    const msg = body;
    const formatted = formatMessage(msg);
    injectText(formatted);
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
function sendViaLAN(peer, msg, secret, agentName) {
    const payload = JSON.stringify(msg);
    const hosts = [peer.host];
    if (peer.ip && peer.ip !== peer.host)
        hosts.push(peer.ip);
    const startTime = Date.now();
    return new Promise((resolve) => {
        const trySend = (hostIdx) => {
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
                    const via = hostIdx > 0 ? ` (via fallback IP ${host})` : '';
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
                    log.info(`Sent to ${peer.name} via LAN${via}`, { messageId: msg.messageId, type: msg.type, httpStatus, latencyMs });
                    resolve(response);
                }
                catch {
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
// ── P2P Name Resolution ───────────────────────────────────────
function resolveP2PName(peerName, peer) {
    const community = peer?.community;
    if (!community || !_config?.network?.communities?.length) {
        return peerName;
    }
    const communityConfig = _config.network.communities.find(c => c.name === community);
    if (!communityConfig) {
        log.warn(`Peer ${peerName} references unknown community '${community}' — using unqualified name`);
        return peerName;
    }
    try {
        const hostname = new URL(communityConfig.primary).hostname;
        return `${peerName}@${hostname}`;
    }
    catch {
        log.warn(`Invalid primary URL for community '${community}' — using unqualified name`);
        return peerName;
    }
}
// ── Send Outgoing ─────────────────────────────────────────────
export async function sendAgentMessage(peerName, type, text, extra) {
    if (!_config) {
        return { ok: false, queued: false, error: 'Agent comms not initialized' };
    }
    const agentComms = _config['agent-comms'];
    const networkEnabled = _config.network?.enabled ?? false;
    if (!agentComms?.enabled && !networkEnabled) {
        return { ok: false, queued: false, error: 'Neither agent comms nor network enabled' };
    }
    const peer = agentComms?.enabled
        ? agentComms.peers?.find(p => p.name.toLowerCase() === peerName.toLowerCase())
        : undefined;
    const agentName = _config.agent.name.toLowerCase();
    const msg = {
        from: agentName,
        type,
        text,
        timestamp: new Date().toISOString(),
        messageId: crypto.randomUUID(),
        ...extra,
    };
    // Strategy 1: LAN
    let lanResult = null;
    if (peer && agentComms?.enabled) {
        const secret = await readKeychain('credential-agent-comms-secret');
        if (secret) {
            lanResult = await sendViaLAN(peer, msg, secret, agentName);
            if (lanResult.ok)
                return lanResult;
        }
        else {
            lanResult = { ok: false, queued: false, error: 'Agent comms secret not found in Keychain' };
        }
    }
    // Strategy 2: P2P SDK
    const networkClient = getNetworkClient();
    if (networkClient) {
        try {
            const sendTo = resolveP2PName(peerName, peer);
            const sendResult = await networkClient.send(sendTo, {
                type: msg.type,
                text: msg.text,
                from: msg.from,
                timestamp: msg.timestamp,
                messageId: msg.messageId,
                ...(msg.status && { status: msg.status }),
                ...(msg.action && { action: msg.action }),
                ...(msg.task && { task: msg.task }),
                ...(msg.context && { context: msg.context }),
            });
            if (sendResult.status === 'delivered' || sendResult.status === 'queued') {
                const direction = sendResult.status === 'delivered' ? 'out' : 'relay-out';
                logCommsEntry({
                    ts: new Date().toISOString(),
                    direction,
                    from: agentName,
                    to: peerName,
                    type: msg.type,
                    text: msg.text,
                    messageId: msg.messageId,
                });
                log.info(`Sent to ${peerName} via P2P SDK (${sendResult.status})`, {
                    messageId: msg.messageId,
                    type: msg.type,
                });
                return { ok: true, queued: sendResult.status === 'queued' };
            }
            log.warn(`P2P SDK send failed to ${peerName}`, { error: sendResult.error });
        }
        catch (err) {
            log.warn('P2P SDK send error', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // All failed
    const errors = [];
    if (lanResult)
        errors.push(`LAN: ${lanResult.error}`);
    if (networkClient)
        errors.push('P2P: SDK send failed');
    if (!lanResult && !networkClient)
        errors.push(`Unknown peer: ${peerName}`);
    return { ok: false, queued: false, error: errors.join('; ') };
}
const _peerStates = new Map();
export function updatePeerState(peerName, state) {
    _peerStates.set(peerName.toLowerCase(), state);
}
export function getPeerState(peerName) {
    return _peerStates.get(peerName.toLowerCase());
}
export function getAllPeerStates() {
    const result = {};
    for (const [name, state] of _peerStates) {
        result[name] = state;
    }
    return result;
}
export function getAgentStatus() {
    return {
        agent: _config?.agent?.name ?? 'unknown',
        status: 'idle',
        uptime: process.uptime(),
    };
}
// ── Broadcast ─────────────────────────────────────────────────
/**
 * Send a message to ALL configured peers (fan-out broadcast).
 * Returns per-peer results.
 */
export async function broadcastToAllPeers(type, text, extra) {
    if (!_config) {
        return { ok: false, error: 'Agent comms not initialized', results: {} };
    }
    const agentComms = _config['agent-comms'];
    if (!agentComms?.enabled || !agentComms.peers?.length) {
        return { ok: false, error: 'No peers configured', results: {} };
    }
    const results = {};
    const promises = agentComms.peers.map(async (peer) => {
        const result = await sendAgentMessage(peer.name, type, text, extra);
        results[peer.name] = result;
    });
    await Promise.all(promises);
    const allOk = Object.values(results).every(r => r.ok);
    const anyOk = Object.values(results).some(r => r.ok);
    return {
        ok: anyOk,
        allDelivered: allOk,
        peerCount: agentComms.peers.length,
        results,
    };
}
/**
 * Get the list of configured peer names.
 */
export function getConfiguredPeers() {
    const agentComms = _config?.['agent-comms'];
    if (!agentComms?.enabled) return [];
    return (agentComms.peers ?? []).map(p => p.name);
}
// ── Init / Shutdown ───────────────────────────────────────────
export function initAgentComms(config) {
    _config = config;
    const agentComms = config['agent-comms'];
    if (!agentComms?.enabled) {
        log.info('Agent comms disabled');
        return;
    }
    log.info('Agent comms initialized', {
        peers: agentComms.peers?.length ?? 0,
        peerNames: agentComms.peers?.map(p => p.name) ?? [],
    });
}
export function stopAgentComms() {
    _config = null;
    log.info('Agent comms stopped');
}
export function _resetAgentCommsForTesting() {
    _peerStates.clear();
    _config = null;
}
//# sourceMappingURL=agent-comms.js.map