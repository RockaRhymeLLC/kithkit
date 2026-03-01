/**
 * BMO Health Checks — comprehensive system health via registerCheck().
 *
 * Registers BMO-specific health checks with the kithkit framework's
 * extended-status system. These checks cover:
 * - System resources (disk, memory)
 * - Processes (tmux, cloudflare tunnel)
 * - Network (Telegram API reachability)
 * - LAN peers (agent-comms connectivity)
 * - State files (required config files present)
 * - Log size monitoring
 */
import { execSync, execFile } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { registerCheck } from '../core/extended-status.js';
import { getProjectDir } from '../core/config.js';
import { sessionExists } from '../core/session-bridge.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('bmo-health');
function exec(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    catch {
        return '';
    }
}
// ── Individual Checks ───────────────────────────────────────
function checkSystem() {
    const details = {};
    // Disk usage
    const diskOutput = exec("df -h / | awk 'NR==2 {print $5, $4}'");
    if (diskOutput) {
        const [usagePct, available] = diskOutput.split(' ');
        const usage = parseInt(usagePct.replace('%', ''), 10);
        details.diskUsage = `${usage}%`;
        details.diskAvailable = available;
        if (usage >= 90) {
            return { ok: false, message: `Disk critically full: ${usage}%`, details };
        }
        if (usage >= 75) {
            details.warning = 'Disk usage above 75%';
        }
    }
    // Memory pressure
    const pressure = exec('sysctl -n kern.memorystatus_vm_pressure_level');
    const level = parseInt(pressure, 10) || 0;
    details.memoryPressure = level >= 4 ? 'CRITICAL' : level >= 2 ? 'WARNING' : 'normal';
    if (level >= 4) {
        return { ok: false, message: `Memory pressure critical (level ${level})`, details };
    }
    return { ok: true, message: 'System resources OK', details };
}
function checkProcesses() {
    const details = {};
    // tmux session
    details.tmuxSession = sessionExists() ? 'active' : 'not found';
    // Cloudflare tunnel
    const cfPid = exec('pgrep -f cloudflared');
    details.cloudflaredTunnel = cfPid ? 'running' : 'not running';
    const allGood = sessionExists() && !!cfPid;
    return {
        ok: true, // processes are optional — warn-level, not failures
        message: allGood ? 'All processes running' : 'Some processes not running',
        details,
    };
}
function checkLogs(config) {
    const logDir = path.resolve(getProjectDir(), config.daemon?.log_dir ?? 'logs');
    if (!fs.existsSync(logDir)) {
        return { ok: true, message: 'Log directory not found (OK if new install)' };
    }
    let totalSize = 0;
    const largeFiles = [];
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    for (const file of files) {
        const stats = fs.statSync(path.join(logDir, file));
        totalSize += stats.size;
        if (stats.size > 5 * 1_048_576) {
            largeFiles.push(`${file}: ${(stats.size / 1_048_576).toFixed(1)}MB`);
        }
    }
    const totalMB = totalSize / 1_048_576;
    const ok = totalMB <= 100;
    const sizeLabel = totalMB > 1 ? `${totalMB.toFixed(1)}MB` : `${(totalSize / 1024).toFixed(1)}KB`;
    return {
        ok,
        message: `Logs total: ${sizeLabel}${largeFiles.length ? ` (${largeFiles.length} large)` : ''}`,
        details: { totalMB: Math.round(totalMB * 10) / 10, fileCount: files.length, ...(largeFiles.length && { largeFiles }) },
    };
}
function checkNetwork() {
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: '/',
            method: 'GET',
            timeout: 10_000,
        }, (res) => {
            res.resume();
            resolve({ ok: true, message: 'Telegram API reachable' });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, message: 'Telegram API timeout' }); });
        req.on('error', (err) => { resolve({ ok: false, message: `Telegram API unreachable: ${err.message}` }); });
        req.end();
    });
}
function checkPeers(config) {
    const agentComms = config['agent-comms'];
    if (!agentComms?.enabled || !agentComms.peers?.length) {
        return Promise.resolve({ ok: true, message: 'No peers configured' });
    }
    const checks = agentComms.peers.map((peer) => {
        return new Promise((resolve) => {
            const hosts = [peer.host];
            if (peer.ip && peer.ip !== peer.host)
                hosts.push(peer.ip);
            const tryHost = (idx) => {
                const host = hosts[idx];
                const url = `http://${host}:${peer.port}/agent/status`;
                const start = Date.now();
                execFile('curl', ['-s', '--connect-timeout', '3', url], { timeout: 6000 }, (err) => {
                    const latency = Date.now() - start;
                    if (err && idx + 1 < hosts.length) {
                        tryHost(idx + 1);
                        return;
                    }
                    resolve({ name: peer.name, ok: !err, latencyMs: latency });
                });
            };
            tryHost(0);
        });
    });
    return Promise.all(checks).then(results => {
        const reachable = results.filter(r => r.ok).length;
        const total = results.length;
        const details = {};
        for (const r of results) {
            details[r.name] = r.ok ? `reachable (${r.latencyMs}ms)` : 'unreachable';
        }
        return {
            ok: reachable > 0,
            message: `${reachable}/${total} peers reachable`,
            details,
        };
    });
}
function checkStateFiles() {
    const stateDir = path.join(getProjectDir(), '.claude', 'state');
    const required = ['autonomy.json', 'identity.json', 'channel.txt', 'safe-senders.json'];
    const missing = [];
    for (const file of required) {
        if (!fs.existsSync(path.join(stateDir, file))) {
            missing.push(file);
        }
    }
    return {
        ok: missing.length === 0,
        message: missing.length === 0 ? `All ${required.length} state files present` : `Missing: ${missing.join(', ')}`,
        details: { required: required.length, missing: missing.length, ...(missing.length && { missingFiles: missing }) },
    };
}
// ── Registration ────────────────────────────────────────────
/**
 * Register all BMO health checks with the kithkit framework.
 * Each check is registered separately for granular reporting.
 */
export function registerBmoHealthChecks(config) {
    registerCheck('bmo-system', () => checkSystem());
    registerCheck('bmo-processes', () => checkProcesses());
    registerCheck('bmo-logs', () => checkLogs(config));
    registerCheck('bmo-network', () => checkNetwork());
    registerCheck('bmo-peers', () => checkPeers(config));
    registerCheck('bmo-state', () => checkStateFiles());
    log.info('Registered 6 BMO health checks');
}
//# sourceMappingURL=health-extended.js.map