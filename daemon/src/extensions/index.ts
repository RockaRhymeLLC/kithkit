/**
 * Agent Extension — entry point for all agent-specific daemon capabilities.
 *
 * Implements the kithkit Extension interface to add:
 * - Communication channels (Telegram, email, voice)
 * - Agent-to-agent messaging (LAN + P2P + unified A2A router)
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
import { initAgentAccessControl } from './access-control.js';
import { registerAgentHealthChecks as registerAgentHealthChecksExtended } from './health-extended.js';
import { getAgentExtendedStatus } from './extended-status.js';
import {
  initAgentComms,
  stopAgentComms,
  handleAgentMessage,
  sendAgentMessage,
  getAgentStatus,
  sendViaLAN,
  logCommsEntry,
  setRouter,
} from './comms/agent-comms.js';
import { initNetworkSDK, stopNetworkSDK, handleIncomingP2P, getNetworkClient } from './comms/network/sdk-bridge.js';
import { registerWithRelay } from './comms/network/registration.js';
import { handleNetworkRoute } from './comms/network/api.js';
import type { WireEnvelope } from './comms/network/sdk-types.js';
import { initVoice, stopVoice } from './voice/index.js';
import { registerAgentTasks, REAL_TASK_NAMES } from './automation/tasks/index.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { enableVectorSearch } from '../api/memory.js';
import { readKeychain } from '../core/keychain.js';
import { parseBody } from '../api/helpers.js';
import { handleMemorySync } from './automation/tasks/memory-sync.js';
import { UnifiedA2ARouter } from '../a2a/router.js';
import { handleA2ARoute, setA2ARouter } from '../a2a/handler.js';
import { sendMessage } from '../agents/message-router.js';
import { registerAdapter, unregisterAdapter } from '../comms/channel-router.js';
import { createBmoTelegramAdapter, BmoTelegramAdapter } from './comms/adapters/telegram.js';
import {
  initCoworkBridge,
  shutdownCoworkBridge,
  handleCoworkRoute,
  setAuthToken,
  setPsk,
} from './cowork-bridge.js';

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
let _telegramAdapter: BmoTelegramAdapter | null = null;

// ── Route Handlers ──────────────────────────────────────────

async function handleTelegramWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await readBody(req);
    const update = JSON.parse(body);
    if (_telegramAdapter) {
      await _telegramAdapter.handleUpdate(update);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log.error('Telegram webhook error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid update' }));
  }
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
    await handleIncomingP2P(envelope);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
  if (req.method !== 'GET') return false;
  const status = getAgentStatus();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
  return true;
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
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ todos: [], decisions: [], calendar: [], memories: [] }));
  return true;
}

async function handleHookResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await parseBody(req);
    const { hook_event } = body as { hook_event?: string };
    log.debug('Hook response notification', { hook_event });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: new Date().toISOString() }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('Hook response endpoint error', { error: detail });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid request: ${detail}` }));
  }
  return true;
}

async function handleMemorySyncRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const body = await parseBody(req);
    const result = await handleMemorySync(authToken, body);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error('Memory sync endpoint error', { error: detail });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid request: ${detail}` }));
  }
  return true;
}

// ── Task Handler Stubs (replaced by s-m29) ──────────────────

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

/** Extension task names that get in-process handlers. */
const AGENT_TASK_HANDLERS = [
  'health-check',
  'memory-consolidation',
  'weekly-progress-report',
] as const;

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asAgentConfig(config);

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();

  // Load cowork credentials from Keychain before initializing bridge
  const [coworkToken, coworkPsk] = await Promise.all([
    readKeychain('credential-cowork-token').catch(() => null),
    readKeychain('credential-cowork-psk').catch(() => null),
  ]);
  if (coworkToken) {
    setAuthToken(coworkToken);
    log.info('Cowork auth token loaded from Keychain');
  }
  if (coworkPsk) {
    setPsk(coworkPsk);
    log.info('Cowork PSK loaded from Keychain');
  }

  // Initialize cowork WebSocket bridge (Chrome extension relay)
  initCoworkBridge(_server);

  // Initialize agent-to-agent comms (LAN + P2P SDK)
  initAgentComms(_config);

  // ── Unified A2A Router (PR #136) ─────────────────────────
  const router = new UnifiedA2ARouter({
    config: config as unknown as Record<string, unknown>,
    sendViaLAN,
    getNetworkClient,
    getAgentCommsSecret: () => readKeychain('credential-agent-comms-secret'),
    logCommsEntry,
    sendMessage: sendMessage as (req: { from: string; to: string; type: string; body: string; metadata?: Record<string, unknown> }) => { messageId: number; delivered: boolean },
  });
  setA2ARouter(router);
  setRouter(router);

  // Network SDK (P2P messaging) — non-blocking
  if (_config.network?.enabled) {
    registerWithRelay(_config)
      .then(() => initNetworkSDK(_config! as unknown as Record<string, unknown>))
      .then(ok => { if (ok) log.info('Network SDK ready'); })
      .catch(err => log.warn('Network init failed (LAN-only mode)', {
        error: err instanceof Error ? err.message : String(err),
      }));
  }

  // Initialize voice extension (registers its own routes)
  if (_config.channels?.voice) {
    await initVoice(_config.channels.voice);
  }

  // ── Telegram Adapter ─────────────────────────────────────
  // BMO adapter reads bot token + chat ID from macOS Keychain — no config fields needed.
  if (_config.channels?.telegram?.enabled) {
    try {
      _telegramAdapter = await createBmoTelegramAdapter();
      registerAdapter(_telegramAdapter);
      log.info('Telegram adapter registered with channel router');
    } catch (err) {
      log.error('Failed to initialize Telegram adapter', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Register agent-specific routes
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/message', handleAgentMessageRoute);
  registerRoute('/agent/send', handleAgentSend);
  registerRoute('/agent/status', handleAgentStatusEndpoint);
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);
  registerRoute('/api/network/*', handleNetworkRoute);
  registerRoute('/api/a2a/*', handleA2ARoute);
  registerRoute('/hook/response', handleHookResponse);
  registerRoute('/agent/memory-sync', handleMemorySyncRoute);
  registerRoute('/api/cowork/*', handleCoworkRoute);

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
    if (REAL_TASK_NAMES.has(taskName)) continue;
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
    a2aRouter: true,
  });
}

async function onShutdown(): Promise<void> {
  shutdownCoworkBridge();
  stopVoice();
  await stopNetworkSDK();
  stopAgentComms();
  if (_telegramAdapter) {
    _telegramAdapter.stopTyping();
    unregisterAdapter('telegram');
    _telegramAdapter = null;
  }
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
  _initialized = false;
  log.info('Agent extension shut down');
}

// ── Export ───────────────────────────────────────────────────

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
