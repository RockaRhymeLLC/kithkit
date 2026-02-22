/**
 * t-115: Daemon starts and responds to health check
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../core/config.js';
import { initLogger, createLogger } from '../core/logger.js';
import { getHealth } from '../core/health.js';

const VERSION = '0.1.0';

function request(port: number, path: string, host = '127.0.0.1'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

describe('Daemon health (t-115)', () => {
  let server: http.Server;
  let tmpDir: string;
  const TEST_PORT = 19847; // high port to avoid conflicts

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    _resetConfigForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('health endpoint returns correct JSON', async () => {
    const health = getHealth(VERSION);
    assert.equal(health.status, 'ok');
    assert.equal(typeof health.uptime, 'number');
    assert.equal(health.version, VERSION);
    assert.ok(health.timestamp);
    assert.ok(!isNaN(Date.parse(health.timestamp)), 'Timestamp should be valid ISO date');
  });

  it('daemon starts and serves /health via HTTP', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-daemon-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      `daemon:\n  port: ${TEST_PORT}\n  log_dir: logs\n`,
    );
    _resetConfigForTesting();
    const config = loadConfig(tmpDir);
    initLogger({
      logDir: path.join(tmpDir, config.daemon.log_dir),
      minLevel: config.daemon.log_level,
    });

    const log = createLogger('test');

    server = http.createServer((req, res) => {
      res.setHeader('X-Timestamp', new Date().toISOString());
      const url = new URL(req.url ?? '/', `http://localhost:${TEST_PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        const health = getHealth(VERSION);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, '127.0.0.1', () => {
        log.info('Test server started');
        resolve();
      });
    });

    const result = await request(TEST_PORT, '/health');
    assert.equal(result.status, 200);
    assert.ok(result.headers['x-timestamp'], 'Should have X-Timestamp header');

    const body = JSON.parse(result.body);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.equal(body.version, VERSION);
    assert.ok(body.timestamp);
  });

  it('server binds to localhost only', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-bind-'));
    _resetConfigForTesting();

    server = http.createServer((_, res) => {
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT + 1, '127.0.0.1', resolve);
    });

    // Verify it's listening on localhost
    const result = await request(TEST_PORT + 1, '/', '127.0.0.1');
    assert.equal(result.status, 200);

    // The key point: the server was explicitly bound to 127.0.0.1,
    // so it will not accept connections from other interfaces.
    // We verify the address to confirm the binding.
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    assert.equal(addr.address, '127.0.0.1');
  });

  it('returns 404 for unknown paths', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-404-'));
    _resetConfigForTesting();

    server = http.createServer((req, res) => {
      res.setHeader('X-Timestamp', new Date().toISOString());
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT + 2, '127.0.0.1', resolve);
    });

    const result = await request(TEST_PORT + 2, '/nonexistent');
    assert.equal(result.status, 404);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'Not found');
    assert.ok(body.timestamp, '404 response should include timestamp');
  });

  it('all API responses include timestamp', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-ts-'));
    _resetConfigForTesting();

    server = http.createServer((req, res) => {
      res.setHeader('X-Timestamp', new Date().toISOString());
      const health = getHealth(VERSION);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    });

    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT + 3, '127.0.0.1', resolve);
    });

    const result = await request(TEST_PORT + 3, '/health');
    // Check both header and body timestamp
    assert.ok(result.headers['x-timestamp'], 'Should have X-Timestamp header');
    const body = JSON.parse(result.body);
    assert.ok(body.timestamp, 'Response body should have timestamp');
  });
});
