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
import { commsExtension } from './comms/index.js';
import { initAgentAccessControl } from './access-control.js';
import { registerAgentHealthChecks as registerAgentHealthChecksExtended } from './health-extended.js';
import { getAgentExtendedStatus } from './extended-status.js';
import { initVoice, stopVoice } from './voice/index.js';
import { registerAgentTasks, REAL_TASK_NAMES } from './automation/tasks/index.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { enableVectorSearch } from '../api/memory.js';

const log = createLogger('agent-extension');

// ── State ────────────────────────────────────────────────────

let _config: AgentConfig | null = null;
let _scheduler: Scheduler | null = null;
let _initialized = false;

// ── Route Handlers ──────────────────────────────────────────

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

  // Delegate all comms initialization and route registration to commsExtension.
  // This handles: agent comms, unified A2A router, network SDK, Telegram adapter,
  // and registers: /agent/message, /agent/send, /agent/status, /api/a2a/*,
  //   /api/network/*, /agent/p2p, /telegram/status
  await commsExtension.onInit!(config, _server);

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();

  // Initialize voice extension (registers its own routes)
  if (_config.channels?.voice) {
    await initVoice(_config.channels.voice);
  }

  // Register agent-specific routes
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);

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
  await commsExtension.onShutdown!();
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
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
