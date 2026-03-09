/**
 * LAN Peer Discovery — finds kithkit peers by scanning the ARP table.
 *
 * When a configured peer becomes unreachable at its known IP, this module
 * scans the local network to find it at a new address.
 */

import { execFile } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('lan-discovery');

interface DiscoveredPeer {
  name: string;
  ip: string;
}

/**
 * Parse the ARP table to get candidate IPs on the local network.
 * Runs `arp -a` and extracts IPv4 addresses.
 */
function getArpIPs(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        log.warn('ARP table read failed', { error: err.message });
        resolve([]);
        return;
      }
      // Parse lines like: ? (192.168.12.169) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
      const ips: string[] = [];
      for (const line of stdout.split('\n')) {
        const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
        if (match) ips.push(match[1]);
      }
      resolve(ips);
    });
  });
}

/**
 * Probe a single IP to check if it's running a kithkit daemon.
 * Uses curl with a 1-second timeout to hit /status.
 * Returns the agent name if found, null otherwise.
 */
function probeIP(ip: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const url = `http://${ip}:${port}/status`;
    execFile('curl', ['-s', '--connect-timeout', '1', '--max-time', '2', url],
      { timeout: 3000 }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(stdout);
          if (data.agent) {
            resolve(data.agent.toLowerCase());
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
  });
}

/**
 * Scan the local network for kithkit peers.
 * Gets IPs from ARP table, probes each one in parallel.
 * Returns a map of agentName -> IP.
 */
export async function scanForPeers(port = 3847): Promise<Map<string, string>> {
  const ips = await getArpIPs();
  if (ips.length === 0) {
    log.debug('No ARP entries found');
    return new Map();
  }

  log.info('Scanning for peers', { candidates: ips.length, port });

  const results = await Promise.all(
    ips.map(async (ip) => {
      const name = await probeIP(ip, port);
      return name ? { name, ip } : null;
    })
  );

  const peers = new Map<string, string>();
  for (const r of results) {
    if (r) {
      peers.set(r.name, r.ip);
      log.info('Discovered peer', { name: r.name, ip: r.ip });
    }
  }

  return peers;
}
