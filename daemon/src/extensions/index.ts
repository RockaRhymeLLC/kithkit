/**
 * Agent Extension — entry point for all agent-specific daemon capabilities.
 *
 * Implements the kithkit Extension interface to add:
 * - Communication channels (Telegram, email, voice)
 * - Agent-to-agent messaging (LAN + P2P)
 * - Scheduler task handlers
 * - Infrastructure services (backup, health checks)
 *
 * This is the single entry point — all extension modules register through here.
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
import { asAgentConfig, type AgentConfig } from './config.js';
import {
  initComms,
  shutdownComms,
  createTelegramRouteHandler,
  createShortcutRouteHandler,
} from './comms/index.js';
import { initAgentAccessControl } from './access-control.js';
import { registerAgentHealthChecks as registerAgentHealthChecksExtended } from './health-extended.js';
import { getAgentExtendedStatus } from './extended-status.js';
import {
  initAgentComms,
  stopAgentComms,
  handleAgentMessage,
  sendAgentMessage,
  getAgentStatus,
  updatePeerState,
  sendViaLAN,
  getPeerState,
  logCommsEntry,
  setUnifiedRouter,
} from './comms/agent-comms.js';
import { initNetworkSDK, stopNetworkSDK, handleIncomingP2P, getNetworkClient } from './comms/network/sdk-bridge.js';
import { UnifiedA2ARouter } from '../a2a/router.js';
import { handleA2ARoute, setA2ARouter } from '../a2a/handler.js';
import { registerWithRelay } from './comms/network/registration.js';
import { handleNetworkRoute, setNetworkApiConfig, setNetworkApiRouter } from './comms/network/api.js';
import type { WireEnvelope } from './comms/network/sdk-types.js';
import { initVoice, stopVoice } from './voice/index.js';
import { registerAgentTasks, REAL_TASK_NAMES } from './automation/tasks/index.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { enableVectorSearch } from '../api/memory.js';
import { readKeychain } from '../core/keychain.js';
import { sendMessage as sendDbMessage } from '../agents/message-router.js';

const log = createLogger('agent-extension');

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

let _config: AgentConfig | null = null;
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

  res.setHeader('Deprecation', 'true');

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
      ? await getAgentExtendedStatus(_config)
      : { agent: 'Agent', session: 'stopped', channel: 'unknown', todos: { open: 0, inProgress: 0, blocked: 0 }, services: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  } catch (err) {
    log.error('Failed to gather extended status', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agent: _config?.agent?.name ?? 'Agent', error: 'Status collection failed' }));
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
// Real implementations come in s-m29 (agent extension).

function stubHandler(name: string) {
  return async () => {
    log.debug(`Task handler stub: ${name}`);
  };
}

// ── Health Checks ───────────────────────────────────────────

function registerAgentHealthChecks(): void {
  registerCheck('agent-extension', () => ({
    ok: _initialized,
    message: _initialized ? 'Agent extension loaded' : 'Agent extension not initialized',
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
const AGENT_TASK_HANDLERS = [
  'health-check',
  'memory-consolidation',

  'weekly-progress-report',
] as const;

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asAgentConfig(config);

  // Initialize agent comms (Telegram, email adapters)
  await initComms(_config);
  _telegramRouteHandler = createTelegramRouteHandler();
  _shortcutRouteHandler = createShortcutRouteHandler();

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();


  // Initialize agent-to-agent comms (LAN + P2P SDK)
  initAgentComms(_config);
  setNetworkApiConfig(_config);

  // Initialize unified A2A router
  const a2aRouter = new UnifiedA2ARouter({
    config: _config,
    sendViaLAN,
    getNetworkClient,
    getPeerState,
    logCommsEntry,
    readKeychain,
    sendDbMessage: (msg) => sendDbMessage(msg as Parameters<typeof sendDbMessage>[0]),
  });
  setA2ARouter(a2aRouter);
  setUnifiedRouter(a2aRouter);
  setNetworkApiRouter(a2aRouter);

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

  // Register agent-specific routes
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/shortcut', handleShortcut);
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/message', handleAgentMessageRoute);
  registerRoute('/agent/send', handleAgentSend);
  registerRoute('/agent/status', handleAgentStatusEndpoint);
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);
  registerRoute('/api/network/*', handleNetworkRoute);
  registerRoute('/api/a2a/*', handleA2ARoute);

  // Set up scheduler with in-process handlers
  const schedulerConfig = config.scheduler?.tasks ?? [];
  _scheduler = new Scheduler({
    tasks: schedulerConfig,
    tickIntervalMs: 1000,
  });

  // Register core task handlers (context-watchdog, todo-reminder, etc.)
  registerCoreTasks(_scheduler);

  // Register real agent task handlers (s-m29)
  registerAgentTasks(_scheduler);

  // Register stub handlers for remaining agent tasks (not yet implemented)
  for (const taskName of AGENT_TASK_HANDLERS) {
    if (REAL_TASK_NAMES.has(taskName)) continue; // Already registered by registerAgentTasks
    if (_scheduler.getTask(taskName)) {
      _scheduler.registerHandler(taskName, stubHandler(taskName));
    }
  }

  // Load external task handlers from configured directories (tasks_dirs)
  await _scheduler.loadExternalTasks(config.scheduler.tasks_dirs ?? []);

  // Wire scheduler to the tasks API
  setScheduler(_scheduler);
  _scheduler.start();

  // Initialize agent access control (5-tier, channel-aware)
  initAgentAccessControl();

  // Register health checks (extension + comprehensive system checks)
  registerAgentHealthChecks();
  registerAgentHealthChecksExtended(_config);

  _initialized = true;
  log.info('Agent extension initialized', {
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
  log.info('Agent extension shut down');
}

// ── Export ───────────────────────────────────────────────────

/**
 * The agent extension — register this with the kithkit daemon.
 *
 * Usage in a bootstrap file:
 *   import { registerExtension } from './core/extensions.js';
 *   import { agentExtension } from './extensions/index.js';
 *   registerExtension(agentExtension);
 */
export const agentExtension: Extension = {
  name: 'agent',
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
