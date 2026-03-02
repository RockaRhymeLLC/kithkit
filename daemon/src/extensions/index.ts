/**
 * R2 Extension — entry point for all R2-specific daemon capabilities.
 *
 * Implements the kithkit Extension interface to add:
 * - Communication channels (Telegram, email, voice)
 * - Agent-to-agent messaging (LAN + P2P)
 * - Scheduler task handlers
 * - Infrastructure services (backup, health checks)
 *
 * This is the single entry point — all R2 modules register through here.
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
import { asR2Config, type R2Config } from './config.js';
import {
  initComms,
  shutdownComms,
  createTelegramRouteHandler,
  createShortcutRouteHandler,
} from './comms/index.js';
import { initR2AccessControl } from './access-control.js';
import { registerR2HealthChecks as registerR2HealthChecksExtended } from './health-extended.js';
import { getR2ExtendedStatus } from './extended-status.js';
import {
  initAgentComms,
  stopAgentComms,
  handleAgentMessage,
  sendAgentMessage,
  getAgentStatus,
  updatePeerState,
} from './comms/agent-comms.js';
import { initNetworkSDK, stopNetworkSDK, handleIncomingP2P } from './comms/network/sdk-bridge.js';
import { registerWithRelay } from './comms/network/registration.js';
import { handleNetworkRoute, setNetworkApiConfig } from './comms/network/api.js';
import type { WireEnvelope } from './comms/network/sdk-types.js';
import { initVoice, stopVoice } from './voice/index.js';
import { registerR2Tasks, REAL_TASK_NAMES } from './automation/tasks/index.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { enableVectorSearch } from '../api/memory.js';
import { readKeychain } from '../core/keychain.js';

const log = createLogger('r2-extension');

// ── Helpers ──────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  // Check for pre-buffered body from main.ts metrics middleware
  const rawBody = (req as unknown as Record<string, unknown>)._rawBody;
  if (rawBody instanceof Buffer) {
    return Promise.resolve(rawBody.toString());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── State ────────────────────────────────────────────────────

let _config: R2Config | null = null;
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

  try {
    const body = await readBody(req);
    const envelope = JSON.parse(body) as WireEnvelope;
    const handled = await handleIncomingP2P(envelope);
    res.writeHead(handled ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: handled }));
  } catch (err) {
    log.error('P2P endpoint error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
  }
  return true;
}

async function handleAgentMessageRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const body = await readBody(req);
    const parsed = JSON.parse(body);
    const result = await handleAgentMessage(token, parsed);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    log.error('Agent message endpoint error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
  return true;
}

async function handleAgentSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await readBody(req);
    const { peer, type, text, ...extra } = JSON.parse(body);
    if (!peer || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'peer and type are required' }));
      return true;
    }
    const result = await sendAgentMessage(peer, type, text, extra);
    res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    log.error('Agent send endpoint error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
  return true;
}

async function handleAgentStatusEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method === 'GET') {
    // Simple status check (lightweight, for peer heartbeats)
    const status = getAgentStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return true;
  }
  if (req.method === 'POST') {
    // Heartbeat exchange: peer POSTs their state, gets ours back
    try {
      const body = await readBody(req);
      const peerState = JSON.parse(body);
      if (peerState.agent) {
        updatePeerState(peerState.agent, {
          status: peerState.status ?? 'unknown',
          updatedAt: Date.now(),
          latencyMs: peerState.latencyMs,
        });
      }
      const ourStatus = getAgentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ourStatus));
    } catch (err) {
      log.error('Agent status POST error', { error: err instanceof Error ? err.message : String(err) });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return true;
  }
  return false;
}

async function handleExtendedStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  try {
    const status = _config
      ? await getR2ExtendedStatus(_config)
      : { agent: 'R2D2', session: 'stopped', channel: 'unknown', todos: { open: 0, inProgress: 0, blocked: 0 }, services: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } catch (err) {
    log.error('Failed to gather extended status', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent: _config?.agent?.name ?? 'R2D2', error: 'Status collection failed' }));
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

function registerR2HealthChecks(): void {
  registerCheck('r2-extension', () => ({
    ok: _initialized,
    message: _initialized ? 'R2 extension loaded' : 'R2 extension not initialized',
  }));
}

// ── Extension Implementation ────────────────────────────────

/** Extension task names that get in-process handlers.
 * NOTE: Do NOT include core tasks here (context-watchdog, todo-reminder,
 * approval-audit, backup, orchestrator-idle, message-delivery) — those are
 * registered by registerCoreTasks() and would be overwritten by stubs.
 *
 * Instance-specific tasks (morning-briefing, blog-reminder, nightly-todo,
 * a2a-digest, email-check, memory-sync, supabase-keep-alive) have been moved
 * to per-agent directories and are loaded via scheduler.tasks_dirs. */
const R2_TASK_HANDLERS = [
  'health-check',
  'memory-consolidation',

  'weekly-progress-report',
] as const;

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asR2Config(config);

  // Initialize R2 comms (Telegram, email adapters)
  await initComms(_config);
  _telegramRouteHandler = createTelegramRouteHandler();
  _shortcutRouteHandler = createShortcutRouteHandler();

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();


  // Initialize agent-to-agent comms (LAN + P2P SDK)
  initAgentComms(_config);
  setNetworkApiConfig(_config);

  // Network SDK (P2P messaging) — non-blocking
  if (_config.network?.enabled) {
    registerWithRelay(_config)
      .then(() => initNetworkSDK(_config!))
      .then(ok => { if (ok) log.info('Network SDK ready'); })
      .catch(err => log.warn('Network init failed (LAN-only mode)', {
        error: err instanceof Error ? err.message : String(err),
      }));
  }

  // Initialize voice extension (registers its own routes)
  if (_config.channels?.voice) {
    await initVoice(_config.channels.voice);
  }

  // Register R2-specific routes
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/shortcut', handleShortcut);
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/message', handleAgentMessageRoute);
  registerRoute('/agent/send', handleAgentSend);
  registerRoute('/agent/status', handleAgentStatusEndpoint);
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);
  registerRoute('/api/network/*', handleNetworkRoute);

  // Set up scheduler with in-process handlers
  const schedulerConfig = config.scheduler?.tasks ?? [];
  _scheduler = new Scheduler({
    tasks: schedulerConfig,
    tickIntervalMs: 1000,
  });

  // Register core task handlers (context-watchdog, todo-reminder, etc.)
  registerCoreTasks(_scheduler);

  // Register real R2 task handlers (s-m29)
  registerR2Tasks(_scheduler);

  // Register stub handlers for remaining R2 tasks (not yet implemented)
  for (const taskName of R2_TASK_HANDLERS) {
    if (REAL_TASK_NAMES.has(taskName)) continue; // Already registered by registerR2Tasks
    if (_scheduler.getTask(taskName)) {
      _scheduler.registerHandler(taskName, stubHandler(taskName));
    }
  }

  // Load external task handlers from configured directories (tasks_dirs)
  await _scheduler.loadExternalTasks(config.scheduler.tasks_dirs ?? []);

  // Wire scheduler to the tasks API
  setScheduler(_scheduler);
  _scheduler.start();

  // Initialize R2 access control (5-tier, channel-aware)
  initR2AccessControl();

  // Register health checks (extension + comprehensive system checks)
  registerR2HealthChecks();
  registerR2HealthChecksExtended(_config);

  _initialized = true;
  log.info('R2 extension initialized', {
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
  stopVoice();
  await stopNetworkSDK();
  stopAgentComms();
  shutdownComms();
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
  _telegramRouteHandler = null;
  _shortcutRouteHandler = null;
  _initialized = false;
  log.info('R2 extension shut down');
}

// ── Export ───────────────────────────────────────────────────

/**
 * The R2 extension — register this with the kithkit daemon.
 *
 * Usage in a bootstrap file:
 *   import { registerExtension } from './core/extensions.js';
 *   import { r2Extension } from './extensions/index.js';
 *   registerExtension(r2Extension);
 */
export const r2Extension: Extension = {
  name: 'r2',
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
