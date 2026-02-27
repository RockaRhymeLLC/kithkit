/**
 * Kithkit Daemon — entry point.
 * HTTP server, module init, route registration, extension hooks.
 * Binds to localhost only for security.
 */

import http from 'node:http';
import path from 'node:path';
import { loadConfig, type KithkitConfig } from './core/config.js';
import { openDatabase, closeDatabase } from './core/db.js';
import { initLogger, createLogger } from './core/logger.js';
import { getHealth } from './core/health.js';
import { handleStateRoute } from './api/state.js';
import { handleMemoryRoute } from './api/memory.js';
import { handleAgentsRoute, setProfilesDir } from './api/agents.js';
import { configure as configureTmux } from './agents/tmux.js';
import { recoverFromRestart } from './agents/recovery.js';
import { handleMessagesRoute } from './api/messages.js';
import { handleSendRoute } from './api/send.js';
import { handleTasksRoute } from './api/tasks.js';
import { handleConfigRoute } from './api/config.js';
import { handleOrchestratorRoute } from './api/orchestrator.js';
import { handleTimerRoute, initTimers } from './api/timer.js';
import { handleTaskQueueRoute } from './api/task-queue.js';
import {
  getExtension,
  isDegraded,
  setDegraded,
  registerExtension,
  _getExtensionForTesting,
  _resetExtensionForTesting,
  type Extension,
} from './core/extensions.js';
import {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  _resetRoutesForTesting,
  type RouteHandler,
} from './core/route-registry.js';
import {
  getExtendedHealth,
  getExtendedStatus,
  formatHealthText,
  registerCheck,
  getRegisteredChecks,
  _resetForTesting as _resetExtendedStatusForTesting,
  type CheckResult,
  type HealthCheckFn,
} from './core/extended-status.js';

export const VERSION = '0.1.0';

// Re-export extension system for consumers
export {
  registerExtension,
  isDegraded,
  _getExtensionForTesting,
  _resetExtensionForTesting,
  type Extension,
};

// Re-export route registry for extensions
export {
  registerRoute,
  matchRoute,
  getRegisteredRoutes,
  _resetRoutesForTesting,
  type RouteHandler,
};

// Re-export extended status for extensions
export {
  registerCheck,
  getRegisteredChecks,
  _resetExtendedStatusForTesting,
  type CheckResult,
  type HealthCheckFn,
};

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

// ── Database ─────────────────────────────────────────────────

openDatabase(projectDir);

// Reload persisted timers (must run after openDatabase)
initTimers();

// Wire up agent profiles directory
setProfilesDir(path.resolve(projectDir, '.claude', 'agents'));

// Configure tmux session management
configureTmux({ projectDir });

// Recover from previous daemon crash (clean orphans, mark interrupted jobs)
const recovery = recoverFromRestart();
if (recovery.orphansCleaned > 0 || recovery.failedJobsRecovered > 0) {
  log.info('Recovery completed', {
    orphansCleaned: recovery.orphansCleaned,
    failedJobsRecovered: recovery.failedJobsRecovered,
    agentsRestarted: recovery.agentsRestarted,
  });
}

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
    const extRoutes = getRegisteredRoutes();
    const ext = getExtension();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...health,
      degraded: isDegraded(),
      extension: ext ? ext.name : null,
      extensionRoutes: extRoutes,
    }));
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

  // Route handling — core API routes, then extension routes, then 404
  const handleRoutes = async (): Promise<void> => {
    // Extended health endpoint (async — must be inside handleRoutes)
    if (req.method === 'GET' && url.pathname === '/health/extended') {
      const health = await getExtendedHealth(VERSION);
      const accept = req.headers['accept'] ?? '';
      if (accept.includes('text/plain')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(formatHealthText(health));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      }
      return;
    }

    // Extended status endpoint (async — must be inside handleRoutes)
    if (req.method === 'GET' && url.pathname === '/status/extended') {
      const status = await getExtendedStatus(VERSION);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // Core API routes
    if (url.pathname.startsWith('/api/')) {
      const handlers = [
        () => handleAgentsRoute(req, res, url.pathname),
        () => handleOrchestratorRoute(req, res, url.pathname),
        () => handleTimerRoute(req, res, url.pathname),
        () => handleTaskQueueRoute(req, res, url.pathname, url.searchParams),
        () => handleSendRoute(req, res, url.pathname),
        () => handleStateRoute(req, res, url.pathname, url.searchParams),
        () => handleMessagesRoute(req, res, url.pathname, url.searchParams),
        () => handleMemoryRoute(req, res, url.pathname),
        () => handleTasksRoute(req, res, url.pathname),
        () => handleConfigRoute(req, res, url.pathname),
      ];
      for (const handler of handlers) {
        const handled = await handler();
        if (handled) return;
      }
    }

    // Registered routes (from registerRoute(), checked before 404, skipped if degraded)
    if (!isDegraded()) {
      const routeHandled = await matchRoute(req, res, url.pathname, url.searchParams);
      if (routeHandled) return;
    }

    // Extension direct onRoute (fallback for routes not using registerRoute)
    const ext = getExtension();
    if (ext?.onRoute && !isDegraded()) {
      const handled = await ext.onRoute(req, res, url.pathname, url.searchParams);
      if (handled) return;
    }

    // 404 fallback
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', timestamp: new Date().toISOString() }));
  };

  handleRoutes().catch((err) => {
    log.error('Request error', { path: url.pathname, error: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error', timestamp: new Date().toISOString() }));
    }
  });
});

// ── Start ────────────────────────────────────────────────────

const HOST = config.daemon.bind_host ?? '0.0.0.0'; // default: all interfaces for A2A

const MAX_BIND_RETRIES = 3;
const BIND_RETRY_DELAY_MS = 1000;
let bindAttempt = 0;

function tryListen(): void {
  server.listen(config.daemon.port, HOST, async () => {
    log.info(`HTTP server listening on ${HOST}:${config.daemon.port}`);

    // Extension init hook — runs after server is listening
    const ext = getExtension();
    if (ext?.onInit) {
      const initStart = Date.now();
      try {
        await ext.onInit(config, server);
        const initMs = Date.now() - initStart;
        log.info(`Extension "${ext.name}" initialized`, { durationMs: initMs });
      } catch (err) {
        const initMs = Date.now() - initStart;
        setDegraded(true);
        log.error(`Extension "${ext.name}" init failed — running in degraded mode`, {
          error: err instanceof Error ? err.message : String(err),
          durationMs: initMs,
        });
      }
    }
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

async function shutdown(signal: string): Promise<void> {
  log.info(`Shutting down (${signal})`);

  // Extension shutdown hook — runs before server.close()
  const ext = getExtension();
  if (ext?.onShutdown && !isDegraded()) {
    try {
      await ext.onShutdown();
      log.info(`Extension "${ext.name}" stopped`);
    } catch (err) {
      log.error(`Extension "${ext.name}" shutdown error`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  closeDatabase();
  log.info('Database closed');

  server.close(() => {
    log.info('Daemon stopped');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — shutting down', {
    error: err.message,
    stack: err.stack,
  });
  shutdown('uncaughtException').catch(() => process.exit(1));
});

log.info('Daemon initialized');

// Export for testing and extension use
export { server, config };
export type { KithkitConfig };
