/**
 * BMO Extension — entry point for all BMO-specific daemon capabilities.
 *
 * Implements the kithkit Extension interface to add:
 * - Communication channels (Telegram, email, voice)
 * - Agent-to-agent messaging (LAN + P2P)
 * - Scheduler task handlers
 * - Infrastructure services (backup, health checks)
 *
 * This is the single entry point — all BMO modules register through here.
 * Zero modifications to upstream kithkit framework files.
 */

import http from 'node:http';
import type { KithkitConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { registerRoute } from '../core/route-registry.js';
import { registerCheck } from '../core/extended-status.js';
import { setScheduler, _getSchedulerForTesting } from '../api/tasks.js';
import { Scheduler } from '../automation/scheduler.js';
import type { Extension } from '../core/extensions.js';
import { asBmoConfig, type BmoConfig } from './config.js';
import {
  initComms,
  shutdownComms,
  createTelegramRouteHandler,
  createShortcutRouteHandler,
} from './comms/index.js';
import { initBmoAccessControl } from './access-control.js';
import { registerBmoHealthChecks as registerBmoHealthChecksExtended } from './health-extended.js';
import { getBmoExtendedStatus } from './extended-status.js';

const log = createLogger('bmo-extension');

// ── State ────────────────────────────────────────────────────

let _config: BmoConfig | null = null;
let _scheduler: Scheduler | null = null;
let _initialized = false;

// ── Route Handlers ──────────────────────────────────────────

// Telegram webhook — real handler from comms extensions (s-m24)
// Created lazily in onInit() after comms are initialized.
let _telegramRouteHandler: ReturnType<typeof createTelegramRouteHandler> | null = null;
let _shortcutRouteHandler: ReturnType<typeof createShortcutRouteHandler> | null = null;

async function handleTelegramWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (_telegramRouteHandler) {
    return _telegramRouteHandler(req, res, pathname, searchParams);
  }
  // Fallback if comms not initialized
  if (req.method !== 'POST') return false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, stub: true }));
  return true;
}

async function handleShortcut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (_shortcutRouteHandler) {
    return _shortcutRouteHandler(req, res, pathname, searchParams);
  }
  if (req.method !== 'POST') return false;
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not initialized' }));
  return true;
}

async function handleAgentP2P(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  // Stub — real implementation in s-m26 (A2A extensions)
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, stub: true }));
  return true;
}

async function handleAgentStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  try {
    const status = _config
      ? await getBmoExtendedStatus(_config)
      : { agent: 'BMO', session: 'stopped', channel: 'unknown', todos: { open: 0, inProgress: 0, blocked: 0 }, services: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } catch (err) {
    log.error('Failed to gather extended status', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent: _config?.agent?.name ?? 'BMO', error: 'Status collection failed' }));
  }
  return true;
}

async function handleContextApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  // Context loader endpoint — real implementation uses context-loader.ts
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ todos: [], decisions: [], calendar: [], memories: [] }));
  return true;
}

// ── Task Handler Stubs (replaced by s-m29) ──────────────────

// These are placeholder handlers registered so the scheduler knows
// to run them in-process rather than as subprocesses.
// Real implementations come in s-m29 (BMO scheduler tasks).

function stubHandler(name: string) {
  return async () => {
    log.debug(`Task handler stub: ${name}`);
  };
}

// ── Health Checks ───────────────────────────────────────────

function registerBmoHealthChecks(): void {
  registerCheck('bmo-extension', () => ({
    ok: _initialized,
    message: _initialized ? 'BMO extension loaded' : 'BMO extension not initialized',
  }));
}

// ── Extension Implementation ────────────────────────────────

/** BMO task names that get in-process handlers. */
const BMO_TASK_HANDLERS = [
  'context-watchdog',
  'todo-reminder',
  'email-check',
  'nightly-todo',
  'health-check',
  'memory-consolidation',
  'morning-briefing',
  'peer-heartbeat',
  'a2a-digest',
  'memory-sync',
  'lindee-inbox-watch',
  'supabase-keep-alive',
  'blog-reminder',
  'weekly-progress-report',
  'bounty-scanner',
] as const;

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asBmoConfig(config);

  // Initialize BMO comms (Telegram, email adapters)
  await initComms(_config);
  _telegramRouteHandler = createTelegramRouteHandler();
  _shortcutRouteHandler = createShortcutRouteHandler();

  // Register BMO-specific routes
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/shortcut', handleShortcut);
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/status', handleAgentStatus);
  registerRoute('/api/context', handleContextApi);

  // Set up scheduler with in-process handlers
  const schedulerConfig = config.scheduler?.tasks ?? [];
  _scheduler = new Scheduler({
    tasks: schedulerConfig,
    tickIntervalMs: 1000,
  });

  // Register in-process handlers for BMO tasks
  for (const taskName of BMO_TASK_HANDLERS) {
    if (_scheduler.getTask(taskName)) {
      _scheduler.registerHandler(taskName, stubHandler(taskName));
    }
  }

  // Wire scheduler to the tasks API
  setScheduler(_scheduler);
  _scheduler.start();

  // Initialize BMO access control (5-tier, channel-aware)
  initBmoAccessControl();

  // Register health checks (extension + comprehensive system checks)
  registerBmoHealthChecks();
  registerBmoHealthChecksExtended(_config);

  _initialized = true;
  log.info('BMO extension initialized', {
    channels: {
      telegram: _config.channels?.telegram?.enabled ?? false,
      email: _config.channels?.email?.enabled ?? false,
      voice: _config.channels?.voice?.enabled ?? false,
    },
    network: _config.network?.enabled ?? false,
    agentComms: _config['agent-comms']?.enabled ?? false,
    tasks: _scheduler.getTasks().length,
  });
}

async function onShutdown(): Promise<void> {
  shutdownComms();
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
  _telegramRouteHandler = null;
  _shortcutRouteHandler = null;
  _initialized = false;
  log.info('BMO extension shut down');
}

// ── Export ───────────────────────────────────────────────────

/**
 * The BMO extension — register this with the kithkit daemon.
 *
 * Usage in a bootstrap file:
 *   import { registerExtension } from './core/extensions.js';
 *   import { bmoExtension } from './extensions/index.js';
 *   registerExtension(bmoExtension);
 */
export const bmoExtension: Extension = {
  name: 'bmo',
  onInit,
  onShutdown,
};

// For testing
export function _getStateForTesting() {
  return { config: _config, scheduler: _scheduler, initialized: _initialized };
}

export function _resetForTesting(): void {
  _config = null;
  _scheduler = null;
  _initialized = false;
}
