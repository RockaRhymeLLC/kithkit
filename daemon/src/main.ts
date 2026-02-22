/**
 * Kithkit Daemon — entry point.
 * HTTP server, module init, route registration.
 * Binds to localhost only for security.
 */

import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './core/config.js';
import { initLogger, createLogger } from './core/logger.js';
import { getHealth } from './core/health.js';

export const VERSION = '0.1.0';

// ── Bootstrap ────────────────────────────────────────────────

const projectDir = path.resolve(process.argv[2] ?? process.cwd());
const config = loadConfig(projectDir);

initLogger({
  logDir: path.resolve(projectDir, config.daemon.log_dir),
  minLevel: config.daemon.log_level,
  maxSizeMB: config.daemon.log_rotation.max_size_mb,
  maxFiles: config.daemon.log_rotation.max_files,
});

const log = createLogger('main');

log.info('Kithkit daemon starting', {
  agent: config.agent.name,
  port: config.daemon.port,
  projectDir,
  version: VERSION,
});

// ── HTTP Server ──────────────────────────────────────────────

function addTimestamp(res: http.ServerResponse): void {
  res.setHeader('X-Timestamp', new Date().toISOString());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${config.daemon.port}`);

  addTimestamp(res);

  // Health endpoint
  if (req.method === 'GET' && url.pathname === '/health') {
    const health = getHealth(VERSION);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  // Status endpoint (quick)
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      daemon: 'running',
      agent: config.agent.name,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
});

// ── Start ────────────────────────────────────────────────────

const HOST = '127.0.0.1'; // localhost only — no remote access

const MAX_BIND_RETRIES = 3;
const BIND_RETRY_DELAY_MS = 1000;
let bindAttempt = 0;

function tryListen(): void {
  server.listen(config.daemon.port, HOST, () => {
    log.info(`HTTP server listening on ${HOST}:${config.daemon.port}`);
  });
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && bindAttempt < MAX_BIND_RETRIES) {
    bindAttempt++;
    log.warn(`Port ${config.daemon.port} in use, retrying in ${BIND_RETRY_DELAY_MS}ms (attempt ${bindAttempt}/${MAX_BIND_RETRIES})`);
    setTimeout(tryListen, BIND_RETRY_DELAY_MS);
  } else {
    log.error(`Server error: ${err.message}`);
    process.exit(1);
  }
});

tryListen();

// ── Graceful shutdown ────────────────────────────────────────

function shutdown(signal: string): void {
  log.info(`Shutting down (${signal})`);
  server.close(() => {
    log.info('Daemon stopped');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log.info('Daemon initialized');

// Export for testing
export { server, config };
