/**
 * Voice Client Registry — tracks connected laptop voice clients.
 *
 * Clients register on startup with a callback URL and send heartbeats
 * every 30s. Stale clients (no heartbeat in 60s) are pruned automatically.
 *
 * Ported from CC4Me v1 daemon/src/voice/voice-client-registry.ts
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createLogger } from '../../core/logger.js';
const log = createLogger('voice-registry');
const clients = new Map();
let pruneTimer = null;
const STALE_TIMEOUT_MS = 60_000; // 60 seconds
const PRUNE_INTERVAL_MS = 15_000; // check every 15s
/**
 * Register or update a voice client. Used for both initial registration
 * and heartbeat (re-registration updates lastSeen).
 */
export function registerClient(clientId, callbackUrl, ip) {
    const existing = clients.get(clientId);
    if (existing) {
        existing.lastSeen = Date.now();
        existing.callbackUrl = callbackUrl;
        existing.ip = ip;
        log.debug('Voice client heartbeat', { clientId, callbackUrl });
    }
    else {
        clients.set(clientId, {
            clientId,
            callbackUrl,
            ip,
            lastSeen: Date.now(),
            registeredAt: Date.now(),
        });
        log.info('Voice client registered', { clientId, callbackUrl, ip });
    }
}
/**
 * Remove a voice client from the registry.
 */
export function unregisterClient(clientId) {
    const removed = clients.delete(clientId);
    if (removed) {
        log.info('Voice client unregistered', { clientId });
    }
    else {
        log.warn('Unregister called for unknown client', { clientId });
    }
    return removed;
}
/**
 * Check if any voice client is currently connected.
 */
export function isVoiceAvailable() {
    return clients.size > 0;
}
/**
 * Get all connected clients.
 */
export function getConnectedClients() {
    return Array.from(clients.values());
}
/**
 * Get the first connected client (for single-client use case).
 */
export function getPrimaryClient() {
    const first = clients.values().next();
    return first.done ? null : first.value;
}
/**
 * Get registry status for the /voice/status endpoint.
 */
export function getRegistryStatus() {
    return {
        connected: clients.size > 0,
        clients: getConnectedClients(),
    };
}
/**
 * Prune clients that haven't sent a heartbeat within STALE_TIMEOUT_MS.
 */
function pruneStaleClients() {
    const now = Date.now();
    for (const [id, client] of clients) {
        if (now - client.lastSeen > STALE_TIMEOUT_MS) {
            clients.delete(id);
            log.info('Pruned stale voice client', {
                clientId: id,
                lastSeenAgo: `${Math.round((now - client.lastSeen) / 1000)}s`,
            });
        }
    }
}
/**
 * Start the periodic stale-client pruner.
 */
export function startPruner() {
    if (pruneTimer)
        return;
    pruneTimer = setInterval(pruneStaleClients, PRUNE_INTERVAL_MS);
    log.debug('Voice client pruner started');
}
/**
 * Stop the periodic pruner (for graceful shutdown).
 */
export function stopPruner() {
    if (pruneTimer) {
        clearInterval(pruneTimer);
        pruneTimer = null;
    }
}
/**
 * Send a chime request to the primary voice client.
 * The client plays a chime, listens for confirmation/rejection,
 * and returns the result.
 *
 * Uses curl via execFile because Node.js http.request has EHOSTUNREACH
 * issues on macOS for LAN IPs.
 */
export function sendChime(text, type) {
    const client = getPrimaryClient();
    if (!client) {
        return Promise.resolve({ status: 'error', error: 'No voice client connected' });
    }
    if (!client.callbackUrl) {
        return Promise.resolve({ status: 'error', error: 'Voice client is remote (no callback URL)' });
    }
    const url = `${client.callbackUrl}/chime`;
    const payload = JSON.stringify({ text, type });
    return new Promise((resolve) => {
        const args = [
            '-s', '--connect-timeout', '5', '--max-time', '15',
            '-X', 'POST', url,
            '-H', 'Content-Type: application/json',
            '--data-raw', payload,
        ];
        execFile('curl', args, { timeout: 20_000 }, (err, stdout, stderr) => {
            if (err) {
                const detail = stderr?.trim() || err.message || 'unknown error';
                log.error('Chime request failed', { error: detail, callbackUrl: client.callbackUrl });
                resolve({ status: 'error', error: detail });
                return;
            }
            try {
                const response = JSON.parse(stdout);
                log.info('Chime response', { status: response.status, clientId: client.clientId });
                resolve(response);
            }
            catch {
                log.error('Invalid chime response', { stdout });
                resolve({ status: 'error', error: 'Invalid response from client' });
            }
        });
    });
}
/**
 * Send synthesized audio to the primary voice client for playback.
 * The client plays the audio through its speakers.
 */
export function sendAudioToClient(audioBuffer) {
    const client = getPrimaryClient();
    if (!client || !client.callbackUrl)
        return Promise.resolve(false);
    const url = `${client.callbackUrl}/play`;
    return new Promise((resolve) => {
        // Write audio to a temp file, then use curl to upload it
        // (can't pass binary data via --data-raw)
        const tmpFile = `/tmp/kithkit-chime-audio-${Date.now()}.wav`;
        fs.writeFileSync(tmpFile, audioBuffer);
        const args = [
            '-s', '--connect-timeout', '5', '--max-time', '30',
            '-X', 'POST', url,
            '-H', 'Content-Type: audio/wav',
            '--data-binary', `@${tmpFile}`,
        ];
        execFile('curl', args, { timeout: 35_000, maxBuffer: 1024 }, (err, stdout, stderr) => {
            // Clean up temp file
            try {
                fs.unlinkSync(tmpFile);
            }
            catch { /* ignore */ }
            if (err) {
                const detail = stderr?.trim() || err.message || 'unknown error';
                log.error('Audio push failed', { error: detail });
                resolve(false);
                return;
            }
            resolve(true);
        });
    });
}
// ── Test helpers ─────────────────────────────────────────────
export const _testHelpers = {
    clearAll() {
        clients.clear();
    },
    get size() {
        return clients.size;
    },
};
//# sourceMappingURL=voice-client-registry.js.map