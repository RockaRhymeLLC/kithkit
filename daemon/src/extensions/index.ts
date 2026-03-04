/**
 * Agent Extension — entry point for all agent-specific daemon capabilities.
 *
 * Implements the kithkit Extension interface to add:
 * - Agent-to-agent messaging (LAN + P2P + unified A2A router)
 * - Scheduler task handlers
 * - Framework routes (comms, A2A, context, hooks)
 * - Dynamic instance loader for repo-specific extensions
 *
 * This is the single entry point — all extension modules register through here.
 * Zero modifications to upstream kithkit framework files.
 *
 * Instance-specific extensions are loaded dynamically from
 * ./instance/index.ts if it exists. That file is gitignored upstream and never
 * syncs to the public repo.
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
import { registerCoreTasks } from '../automation/tasks/index.js';
import { commsSessionExists } from '../core/session-bridge.js';
import { enableVectorSearch } from '../api/memory.js';
import { readKeychain } from '../core/keychain.js';
import { parseBody } from '../api/helpers.js';
import { UnifiedA2ARouter } from '../a2a/router.js';
import { handleA2ARoute, setA2ARouter } from '../a2a/handler.js';
import { sendMessage } from '../agents/message-router.js';

const log = createLogger('agent-extension');

// ── State ────────────────────────────────────────────────────

let _config: AgentConfig | null = null;
let _scheduler: Scheduler | null = null;
let _initialized = false;
let _instanceShutdown: (() => Promise<void> | void) | null = null;

// ── Route Handlers ──────────────────────────────────────────

async function handleAgentP2P(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const envelope = await parseBody(req) as unknown as WireEnvelope;
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
    const parsed = await parseBody(req);
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
    const body = await parseBody(req);
    const { peer, type, text, ...extra } = body;
    if (!peer || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'peer and type are required' }));
      return true;
    }
    const result = await sendAgentMessage(peer as string, type as string, (text as string) ?? '', extra);
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

// ── Health Checks ───────────────────────────────────────────

function registerAgentHealthChecks(): void {
  registerCheck('agent-extension', () => ({
    ok: _initialized,
    message: _initialized ? 'Agent extension loaded' : 'Agent extension not initialized',
  }));
}

// ── Instance Loader ──────────────────────────────────────────

/**
 * Dynamically load instance-specific extensions from ./instance/index.ts.
 * If the file doesn't exist (upstream/generic kithkit), silently returns empty.
 * If it exists, calls register() and stores the optional shutdown() hook.
 */
async function loadInstanceExtensions(
  config: KithkitConfig,
  server: http.Server,
  scheduler: Scheduler,
): Promise<{ shutdown?: () => Promise<void> | void }> {
  try {
<<<<<<< HEAD
    // @ts-ignore — instance/ is gitignored (agent-specific); absent in CI/upstream
=======
    // @ts-expect-error instance/ only exists in personal instance repos
>>>>>>> upstream/main
    const mod = await import('./instance/index.js');
    if (typeof mod.register === 'function') {
      await mod.register(config, server, scheduler);
    }
    return { shutdown: mod.shutdown };
  } catch (err: unknown) {
    // instance/ directory doesn't exist — that's fine (upstream/generic kithkit)
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ERR_MODULE_NOT_FOUND') {
      return {};
    }
    throw err; // Real errors should propagate
  }
}

// ── Extension Implementation ────────────────────────────────

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asAgentConfig(config);

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();

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

  // Register framework routes
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/message', handleAgentMessageRoute);
  registerRoute('/agent/send', handleAgentSend);
  registerRoute('/agent/status', handleAgentStatusEndpoint);
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);
  registerRoute('/api/network/*', handleNetworkRoute);
  registerRoute('/api/a2a/*', handleA2ARoute);
  registerRoute('/hook/response', handleHookResponse);

  // Set up scheduler with in-process handlers
  const schedulerConfig = config.scheduler?.tasks ?? [];
  _scheduler = new Scheduler({
    tasks: schedulerConfig,
    tickIntervalMs: 1000,
    sessionExists: commsSessionExists,
  });

  // Register core task handlers (context-watchdog, todo-reminder, etc.)
  registerCoreTasks(_scheduler);

  // Load external task handlers from configured directories (tasks_dirs)
  await _scheduler.loadExternalTasks(config.scheduler.tasks_dirs ?? []);

  // Wire scheduler to the tasks API
  setScheduler(_scheduler);
  _scheduler.start();

  // Initialize agent access control (5-tier, channel-aware)
  initAgentAccessControl();

  // Register basic extension health check
  registerAgentHealthChecks();

  // Load instance-specific extensions (if instance/ directory exists)
  const instanceResult = await loadInstanceExtensions(config, _server, _scheduler);
  _instanceShutdown = instanceResult.shutdown ?? null;

  _initialized = true;
  log.info('Agent extension initialized', {
    network: _config.network?.enabled ?? false,
    agentComms: _config['agent-comms']?.enabled ?? false,
    tasks: _scheduler.getTasks().length,
    a2aRouter: true,
    instanceLoaded: _instanceShutdown !== null,
  });
}

async function onShutdown(): Promise<void> {
  // Shutdown instance extensions first
  if (_instanceShutdown) {
    await _instanceShutdown();
  }
  await stopNetworkSDK();
  stopAgentComms();
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
  _instanceShutdown = null;
}
