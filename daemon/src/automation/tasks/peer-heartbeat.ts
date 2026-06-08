/**
 * Peer Heartbeat — sends periodic status messages to all configured peers.
 *
 * Every 5 minutes (configurable), sends a `status` type message to each peer
 * via `sendAgentMessage`. Updates peer state based on responses.
 *
 * Uses dynamic imports for agent-comms so the task skips gracefully when
 * the agent-comms extension is not loaded.
 *
 * Uses message type `status` (not `ping` — valid types are:
 * text, status, coordination, pr-review).
 *
 * Local-DNS failure guard: when the configured peer host is a .lan/.local
 * mDNS hostname and the LAN probe fails, we fall back to probing via the
 * A2A relay before recording the peer as down.  This prevents a local DNS
 * outage on our machine from falsely marking healthy peers unreachable.
 * A distinct `localDnsFailed` flag is emitted in log entries so the two
 * failure modes can be distinguished in dashboards and alerts.
 */

import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';
import { scanForPeers } from '../../core/lan-discovery.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('peer-heartbeat');

const _lastScan = new Map<string, number>();
const SCAN_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Peers currently in the "local-DNS-indeterminate" state: send failed via
 * .lan DNS but the peer was confirmed reachable via relay.  This is a
 * DISTINCT flag from "peer-actually-unreachable" (where both paths fail).
 *
 * Wired into updatePeerState so the distinction is externally observable
 * (e.g. in the extended-status endpoint and dashboards).
 */
const _localDnsIndeterminate = new Set<string>();

function shouldScan(peerName: string): boolean {
  const key = peerName.toLowerCase();
  const last = _lastScan.get(key) ?? 0;
  if (Date.now() - last < SCAN_COOLDOWN_MS) return false;
  _lastScan.set(key, Date.now());
  return true;
}

/**
 * Returns true when the host is an mDNS hostname (.lan / .local) that is
 * resolved by the local router/DNS and therefore susceptible to a local
 * DNS outage on our machine independent of the peer's actual health.
 *
 * Exported so it can be unit-tested directly.
 */
export function isMdnsHost(host: string): boolean {
  return host.endsWith('.lan') || host.endsWith('.local');
}

// ── Injectable deps (for testing) ────────────────────────────────────────────
// These follow the _setXForTesting pattern used elsewhere in the codebase
// (e.g. _setTmuxInjectorForTesting in message-router.ts).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _commsOverride: any | null = null;
let _fetchOverride: typeof fetch | null = null;
let _loadConfigOverride: (() => ReturnType<typeof loadConfig>) | null = null;
let _scanForPeersOverride: ((port: number) => Promise<Map<string, string>>) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _setCommsForTesting(c: any | null): void { _commsOverride = c; }
export function _setFetchForTesting(f: typeof fetch | null): void { _fetchOverride = f; }
export function _setLoadConfigForTesting(fn: (() => ReturnType<typeof loadConfig>) | null): void { _loadConfigOverride = fn; }
export function _setScanForPeersForTesting(fn: ((port: number) => Promise<Map<string, string>>) | null): void { _scanForPeersOverride = fn; }

/** Reset all module state between tests. */
export function _resetForTesting(): void {
  _commsOverride = null;
  _fetchOverride = null;
  _loadConfigOverride = null;
  _scanForPeersOverride = null;
  _localDnsIndeterminate.clear();
  _lastScan.clear();
}

interface PeerConfig {
  name: string;
  host: string;
  port: number;
}

interface AgentCommsConfig {
  enabled: boolean;
  peers?: PeerConfig[];
}

/**
 * Probe the peer via the A2A relay by POSTing to our local daemon's
 * /api/a2a/send endpoint with route:relay.  Returns true when the relay
 * confirms delivery (ok:true).
 *
 * This is intentionally a separate HTTP round-trip to localhost so that it
 * uses a completely independent code path from the LAN probe.
 */
async function probeViaRelay(peerName: string, daemonPort: number): Promise<boolean> {
  const effectiveFetch = _fetchOverride ?? fetch;
  try {
    const body = JSON.stringify({
      to: peerName,
      payload: { type: 'status', status: 'dns-fallback-probe' },
      route: 'relay',
    });
    const resp = await effectiveFetch(`http://127.0.0.1:${daemonPort}/api/a2a/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const data = await resp.json() as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const effectiveLoadConfig = _loadConfigOverride ?? loadConfig;
  const config = effectiveLoadConfig();
  const agentComms = (config as unknown as Record<string, unknown>)['agent-comms'] as AgentCommsConfig | undefined;

  if (!agentComms?.enabled) {
    log.debug('Agent comms disabled, skipping heartbeat');
    return;
  }

  const peers = agentComms.peers || [];
  if (peers.length === 0) {
    log.debug('No peers configured, skipping heartbeat');
    return;
  }

  // Dynamic import — agent-comms module may not exist if the extension isn't installed.
  // In tests, _commsOverride bypasses the dynamic import entirely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let comms: any;
  if (_commsOverride !== null) {
    comms = _commsOverride;
  } else {
    try {
      comms = await import('../../extensions/comms/agent-comms.js');
    } catch {
      log.debug('Agent-comms module not available, skipping heartbeat');
      return;
    }
  }

  const effectiveScan = _scanForPeersOverride ?? scanForPeers;
  const daemonPort = config.daemon.port;

  let sent = 0;
  let failed = 0;

  for (const peer of peers) {
    try {
      const result = await comms.sendAgentMessage(peer.name, 'status', undefined, {
        status: 'idle',
      });

      if (result.ok) {
        // Clear any prior local-DNS-indeterminate flag — peer is now reachable directly.
        _localDnsIndeterminate.delete(peer.name.toLowerCase());
        comms.updatePeerState?.(peer.name, {
          status: 'idle',
          updatedAt: Date.now(),
        });
        sent++;
        log.debug(`Heartbeat sent to ${peer.name}`, { queued: result.queued });
      } else {
        // ── Local-DNS failure guard ──────────────────────────────────────
        // When the configured host is an mDNS (.lan/.local) hostname, a
        // DNS resolution failure on our machine can cause a false "peer
        // down" reading even though the peer is healthy.  Before recording
        // the peer as unreachable we probe via the A2A relay, which does
        // NOT depend on local .lan DNS.
        if (isMdnsHost(peer.host)) {
          const relayOk = await probeViaRelay(peer.name, daemonPort);

          if (relayOk) {
            // Peer is alive — our local .lan DNS path is broken, not the peer.
            // Record the indeterminate state (wired into updatePeerState so the
            // distinction is externally observable) and do NOT increment `failed`.
            _localDnsIndeterminate.add(peer.name.toLowerCase());
            comms.updatePeerState?.(peer.name, {
              status: 'local-dns-indeterminate',
              updatedAt: Date.now(),
            });
            log.warn(`${peer.name}: local .lan DNS probe failed but peer confirmed reachable via relay — NOT marking peer down`, {
              localDnsFailed: true,
              host: peer.host,
              peerStatus: 'local-dns-indeterminate',
            });
            sent++;

            // Still try to discover the peer's current IP via ARP so the
            // next heartbeat can reach it directly without DNS.
            if (shouldScan(peer.name)) {
              try {
                const discovered = await effectiveScan(peer.port ?? 3847);
                const newIP = discovered.get(peer.name.toLowerCase());
                if (newIP) {
                  comms.setPeerIpOverride?.(peer.name, newIP);
                  log.info(`Discovered ${peer.name} at IP ${newIP} (will use for direct probes while .lan DNS is broken)`);
                }
              } catch (scanErr) {
                log.warn(`LAN discovery scan failed for ${peer.name}`, {
                  error: scanErr instanceof Error ? scanErr.message : String(scanErr),
                });
              }
            }
          } else {
            // Both .lan DNS and relay failed — peer is likely genuinely
            // unreachable (or relay is also down).  This is distinct from
            // the local-DNS-only failure above.
            _localDnsIndeterminate.delete(peer.name.toLowerCase());
            comms.updatePeerState?.(peer.name, {
              status: 'unreachable',
              updatedAt: Date.now(),
            });
            failed++;
            log.warn(`${peer.name}: unreachable via .lan DNS and relay — marking peer down`, {
              localDnsFailed: true,
              host: peer.host,
              peerStatus: 'peer-actually-unreachable',
            });

            // ARP scan to check whether peer has moved to a new IP.
            if (shouldScan(peer.name)) {
              try {
                const discovered = await effectiveScan(peer.port ?? 3847);
                const newIP = discovered.get(peer.name.toLowerCase());
                if (newIP) {
                  comms.setPeerIpOverride?.(peer.name, newIP);
                  log.info(`Discovered ${peer.name} at new IP ${newIP}`);
                }
              } catch (scanErr) {
                log.warn(`LAN discovery scan failed for ${peer.name}`, {
                  error: scanErr instanceof Error ? scanErr.message : String(scanErr),
                });
              }
            }
          }
        } else {
          // Non-mDNS host — original behavior: record unknown and scan.
          comms.updatePeerState?.(peer.name, {
            status: 'unknown',
            updatedAt: Date.now(),
          });
          failed++;
          log.debug(`Heartbeat failed for ${peer.name}`, { error: result.error });

          // Attempt LAN discovery to find peer at a new IP
          if (shouldScan(peer.name)) {
            const discovered = await effectiveScan(peer.port ?? 3847);
            const newIP = discovered.get(peer.name.toLowerCase());
            if (newIP) {
              comms.setPeerIpOverride?.(peer.name, newIP);
              log.info(`Discovered ${peer.name} at new IP ${newIP}`);
            }
          }
        }
      }
    } catch (err) {
      comms.updatePeerState?.(peer.name, {
        status: 'unknown',
        updatedAt: Date.now(),
      });
      failed++;
      log.warn(`Heartbeat error for ${peer.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });

      // Attempt LAN discovery to find peer at a new IP
      if (shouldScan(peer.name)) {
        try {
          const discovered = await effectiveScan(peer.port ?? 3847);
          const newIP = discovered.get(peer.name.toLowerCase());
          if (newIP) {
            comms.setPeerIpOverride?.(peer.name, newIP);
            log.info(`Discovered ${peer.name} at new IP ${newIP}`);
          }
        } catch (scanErr) {
          log.warn(`LAN discovery scan failed for ${peer.name}`, {
            error: scanErr instanceof Error ? scanErr.message : String(scanErr),
          });
        }
      }
    }
  }

  if (sent > 0 || failed > 0) {
    log.info('Heartbeat cycle complete', { sent, failed, total: peers.length });
  }
}

/** Exposed for testing — triggers the heartbeat run() directly. */
export function _runForTesting(): Promise<void> {
  return run();
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('peer-heartbeat', run);
}
