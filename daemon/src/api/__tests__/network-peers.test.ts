/**
 * GET /api/network/peers — route existence and documented array shape.
 *
 * Verifies:
 *   1. Route does NOT 404 (regression guard for todo #114).
 *   2. Response is an array.
 *   3. Each element contains the required fields: peer, online, lastSeen, route.
 *   4. latencyMs is absent (no live source in the peer registry).
 *   5. With a configured peer + known state, values are mapped correctly.
 *
 * Source under test: daemon/src/api/network.ts → handleNetworkRoute
 * Registry source:   daemon/src/extensions/comms/agent-comms.ts
 *                      getAllConfiguredPeers(), getPeerState() / _peerStates
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  initAgentComms,
  stopAgentComms,
  updatePeerState,
} from '../../extensions/comms/agent-comms.js';
import { handleNetworkRoute } from '../network.js';
import type { KithkitConfig } from '../../core/config.js';

// ── Test server ───────────────────────────────────────────────────────────────

// Unique port — avoids collisions with other __tests__ suites
const TEST_PORT = 19898;

let server: http.Server;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${TEST_PORT}`);
      handleNetworkRoute(req, res, url.pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      }).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    server.listen(TEST_PORT, '127.0.0.1', () => resolve());
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: TEST_PORT,
      path,
      method: 'GET',
      headers: { Connection: 'close' },
      timeout: 5000,
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

// ── Config helpers ────────────────────────────────────────────────────────────

function makeConfig(peers: Array<{ name: string; host: string; port: number }>): KithkitConfig {
  return {
    agent: { name: 'test-agent' },
    daemon: { port: 3847, log_level: 'info', log_dir: 'logs', log_rotation: { max_size_mb: 10, max_files: 5 } },
    'agent-comms': {
      enabled: true,
      peers,
    },
    scheduler: { tasks: [] },
    security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
    network: {},
  } as unknown as KithkitConfig;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  stopAgentComms(); // clear any prior state
  await startServer();
});

afterEach(async () => {
  await stopServer();
  stopAgentComms();
});

describe('GET /api/network/peers — route existence', () => {
  it('does not 404 (todo #114 regression guard)', async () => {
    initAgentComms(makeConfig([]));
    const { status } = await get('/api/network/peers');
    assert.notEqual(status, 404, 'GET /api/network/peers must not 404');
    assert.equal(status, 200);
  });
});

describe('GET /api/network/peers — documented array shape', () => {
  it('returns an empty array when no peers are configured', async () => {
    initAgentComms(makeConfig([]));
    const { status, body } = await get('/api/network/peers');
    assert.equal(status, 200);
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed), 'response must be an array');
    assert.equal(parsed.length, 0);
  });

  it('returns one entry per configured peer with required shape fields', async () => {
    initAgentComms(makeConfig([{ name: 'bmo', host: 'bmo.lan', port: 3847 }]));

    const { status, body } = await get('/api/network/peers');
    assert.equal(status, 200);

    const parsed = JSON.parse(body) as unknown[];
    assert.ok(Array.isArray(parsed), 'response must be an array');
    assert.equal(parsed.length, 1);

    const entry = parsed[0] as Record<string, unknown>;
    assert.ok('peer' in entry, 'entry must have "peer" field');
    assert.ok('online' in entry, 'entry must have "online" field');
    assert.ok('lastSeen' in entry, 'entry must have "lastSeen" field');
    assert.ok('route' in entry, 'entry must have "route" field');

    assert.equal(typeof entry.peer, 'string');
    assert.equal(typeof entry.online, 'boolean');
    // lastSeen is null when peer has never been seen
    assert.equal(entry.lastSeen, null);
    assert.equal(entry.route, 'unknown');
  });

  it('latencyMs is absent — no live source in the peer registry', async () => {
    initAgentComms(makeConfig([{ name: 'bmo', host: 'bmo.lan', port: 3847 }]));
    const { body } = await get('/api/network/peers');
    const parsed = JSON.parse(body) as Record<string, unknown>[];
    const entry = parsed[0]!;
    assert.ok(!('latencyMs' in entry), 'latencyMs must not be present — no live source');
  });

  it('maps idle state to online=true, route=lan, and a lastSeen ISO timestamp', async () => {
    initAgentComms(makeConfig([{ name: 'bmo', host: 'bmo.lan', port: 3847 }]));
    const now = Date.now();
    updatePeerState('bmo', { status: 'idle', updatedAt: now });

    const { body } = await get('/api/network/peers');
    const parsed = JSON.parse(body) as Record<string, unknown>[];
    const entry = parsed[0]!;

    assert.equal(entry.peer, 'bmo');
    assert.equal(entry.online, true);
    assert.equal(entry.route, 'lan');
    assert.equal(typeof entry.lastSeen, 'string');
    assert.equal(entry.lastSeen, new Date(now).toISOString());
  });

  it('maps local-dns-indeterminate to online=true, route=relay', async () => {
    initAgentComms(makeConfig([{ name: 'bmo', host: 'bmo.lan', port: 3847 }]));
    updatePeerState('bmo', { status: 'local-dns-indeterminate', updatedAt: Date.now() });

    const { body } = await get('/api/network/peers');
    const parsed = JSON.parse(body) as Record<string, unknown>[];
    const entry = parsed[0]!;

    assert.equal(entry.online, true);
    assert.equal(entry.route, 'relay');
  });

  it('maps unreachable to online=false, route=unknown', async () => {
    initAgentComms(makeConfig([{ name: 'bmo', host: 'bmo.lan', port: 3847 }]));
    updatePeerState('bmo', { status: 'unreachable', updatedAt: Date.now() });

    const { body } = await get('/api/network/peers');
    const parsed = JSON.parse(body) as Record<string, unknown>[];
    const entry = parsed[0]!;

    assert.equal(entry.online, false);
    assert.equal(entry.route, 'unknown');
  });

  it('returns one entry per peer when multiple peers are configured', async () => {
    initAgentComms(makeConfig([
      { name: 'bmo', host: 'bmo.lan', port: 3847 },
      { name: 'r2d2', host: 'r2d2.lan', port: 3847 },
    ]));

    const { body } = await get('/api/network/peers');
    const parsed = JSON.parse(body) as Record<string, unknown>[];
    assert.equal(parsed.length, 2);
    const names = parsed.map((e) => e.peer as string).sort();
    assert.deepEqual(names, ['bmo', 'r2d2']);
  });
});

describe('GET /api/network/peers — non-GET methods', () => {
  it('does not handle POST (returns false → 404)', async () => {
    initAgentComms(makeConfig([]));

    const r = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: TEST_PORT, path: '/api/network/peers', method: 'POST', headers: { Connection: 'close' }, timeout: 5000 },
        (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 404, 'POST must not be handled by this route');
  });
});
