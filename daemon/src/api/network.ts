/**
 * Network API — peer registry view.
 *
 * Route:
 *   GET /api/network/peers — returns the live peer registry as an array
 *
 * Source:
 *   Peer configs: extensions/comms/agent-comms.ts :: getAllConfiguredPeers()
 *   Peer states:  extensions/comms/agent-comms.ts :: getPeerState(name) / _peerStates
 *
 * Response shape (per element):
 *   {
 *     peer: string,        // peer name from agent-comms config
 *     online: boolean,     // true when last heartbeat status is idle or local-dns-indeterminate
 *     lastSeen: string | null,  // ISO timestamp of last state update, null if never seen
 *     route: 'lan' | 'relay' | 'unknown',  // route inferred from last heartbeat status
 *     latencyMs?: number   // NOT present — no live per-peer latency is persisted in the registry
 *   }
 */

import type http from 'node:http';
import { json } from './helpers.js';
import { getAllConfiguredPeers, getPeerState } from '../extensions/comms/agent-comms.js';

// ── Types ────────────────────────────────────────────────────

export interface PeerEntry {
  peer: string;
  online: boolean;
  lastSeen: string | null;
  route: 'lan' | 'relay' | 'unknown';
  // latencyMs intentionally omitted — no live source in the peer registry
}

// ── Helpers ──────────────────────────────────────────────────

function peerStateToEntry(name: string): PeerEntry {
  const state = getPeerState(name);

  if (!state) {
    return {
      peer: name,
      online: false,
      lastSeen: null,
      route: 'unknown',
    };
  }

  const online = state.status === 'idle' || state.status === 'local-dns-indeterminate';

  let route: 'lan' | 'relay' | 'unknown';
  switch (state.status) {
    case 'idle':
      route = 'lan';
      break;
    case 'local-dns-indeterminate':
      route = 'relay';
      break;
    default:
      route = 'unknown';
  }

  return {
    peer: name,
    online,
    lastSeen: new Date(state.updatedAt).toISOString(),
    route,
  };
}

// ── Route Handler ────────────────────────────────────────────

export async function handleNetworkRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method === 'GET' && pathname === '/api/network/peers') {
    const peers = getAllConfiguredPeers();
    const entries: PeerEntry[] = peers.map((p) => peerStateToEntry(p.name));
    json(res, 200, entries);
    return true;
  }

  return false;
}
