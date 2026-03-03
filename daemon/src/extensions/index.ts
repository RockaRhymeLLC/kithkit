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
import fs from 'node:fs';
import type { KithkitConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { registerRoute } from '../core/route-registry.js';
import { registerCheck } from '../core/extended-status.js';
import { setScheduler, _getSchedulerForTesting } from '../api/tasks.js';
import { Scheduler } from '../automation/scheduler.js';
import type { Extension } from '../core/extensions.js';
import { asAgentConfig, type AgentConfig } from './config.js';
import { createBmoTelegramAdapter, type BmoTelegramAdapter } from './comms/adapters/telegram.js';
import { registerAdapter, unregisterAdapter } from '../comms/channel-router.js';
import { initAgentAccessControl } from './access-control.js';
import { registerAgentHealthChecks } from './health-extended.js';
import { getAgentExtendedStatus } from './extended-status.js';
import {
  initAgentComms,
  stopAgentComms,
  handleAgentMessage,
  sendAgentMessage,
  sendViaLAN,
  logCommsEntry,
  getAgentStatus,
} from './comms/agent-comms.js';
import { initNetworkSDK, stopNetworkSDK, handleIncomingP2P, getNetworkClient } from './comms/network/sdk-bridge.js';
import { registerWithRelay } from './comms/network/registration.js';
import { handleNetworkRoute } from './comms/network/api.js';
import type { WireEnvelope } from './comms/network/sdk-types.js';
import { routeOutgoingMessage, signalResponseComplete } from './comms/channel-router.js';
import { getNewestTranscript } from '../core/session-bridge.js';
import { initVoice, stopVoice } from './voice/index.js';
import { registerAgentTasks, REAL_TASK_NAMES } from './automation/tasks/index.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { enableVectorSearch } from '../api/memory.js';
import { readKeychain } from '../core/keychain.js';
import { sendMessage } from '../agents/message-router.js';
import { UnifiedA2ARouter, setA2ARouter, handleA2ARoute, type RouterDeps } from '../a2a/index.js';

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

let _config: AgentConfig | null = null;
let _scheduler: Scheduler | null = null;
let _initialized = false;
let _telegramAdapter: BmoTelegramAdapter | null = null;

async function handleTelegramWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  if (!_telegramAdapter) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stub: true }));
    return true;
  }

  try {
    const body = await readBody(req);
    const update = JSON.parse(body);
    await _telegramAdapter.handleUpdate(update);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log.error('Telegram webhook error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
  return true;
}

async function handleShortcut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  if (!_telegramAdapter) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not initialized' }));
    return true;
  }

  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const result = await _telegramAdapter.handleShortcut(data);
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    log.error('Shortcut error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal error' }));
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
    const ourStatus = getAgentStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ourStatus));
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

// ── Hook Response Handler ────────────────────────────────────

/**
 * Extract the last assistant text message from a JSONL transcript file.
 * Reads the file from the end to find the most recent assistant message.
 */
function extractLastAssistantText(transcriptPath: string): string | null {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // Walk backwards to find the last assistant message with text
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
          const contentArr = entry.message.content;
          if (!Array.isArray(contentArr)) continue;
          const textParts = contentArr
            .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
            .map((c: { text: string }) => c.text);
          if (textParts.length > 0) {
            return textParts.join('\n');
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    log.warn('Failed to read transcript', { path: transcriptPath, error: String(err) });
  }
  return null;
}

// Track the last processed message to avoid duplicate routing
let _lastRoutedMessageId: string | null = null;

async function handleHookResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : {};
    const hookEvent: string = parsed.hook_event ?? 'unknown';
    const transcriptPath: string = parsed.transcript_path || getNewestTranscript() || '';

    log.debug('Hook response received', { hookEvent, transcriptPath: transcriptPath.slice(-40) });

    // Signal response complete (stop typing indicators)
    signalResponseComplete();

    // For Stop/SubagentStop events, extract and route the assistant response
    if ((hookEvent === 'Stop' || hookEvent === 'SubagentStop') && transcriptPath) {
      const text = extractLastAssistantText(transcriptPath);
      if (text) {
        // Deduplicate: use a hash of the first 200 chars + length as a rough message ID
        const msgId = `${text.length}:${text.slice(0, 200)}`;
        if (msgId !== _lastRoutedMessageId) {
          _lastRoutedMessageId = msgId;
          routeOutgoingMessage(text);
          log.debug('Routed assistant response', { hookEvent, chars: text.length });
        } else {
          log.debug('Skipped duplicate response', { hookEvent, chars: text.length });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hook_event: hookEvent }));
  } catch (err) {
    log.error('Hook response error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
  }
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

function registerLocalHealthChecks(): void {
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
const R2_TASK_HANDLERS = [
  'health-check',
  'memory-consolidation',

  'weekly-progress-report',
] as const;

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asAgentConfig(config);

  // Initialize Telegram adapter
  try {
    _telegramAdapter = await createBmoTelegramAdapter();
    registerAdapter(_telegramAdapter);
    log.info('Telegram adapter initialized and registered');
  } catch (err) {
    log.warn('Telegram adapter init failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();


  // Initialize agent-to-agent comms (LAN + P2P SDK)
  initAgentComms(_config);

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

  // Initialize unified A2A router (PR #136)
  const a2aRouter = new UnifiedA2ARouter({
    config: _config as unknown as Record<string, unknown>,
    sendViaLAN,
    getNetworkClient,
    getAgentCommsSecret: () => readKeychain('credential-agent-comms-secret'),
    logCommsEntry,
    sendMessage: sendMessage as unknown as RouterDeps['sendMessage'],
  });
  setA2ARouter(a2aRouter);

  // Register R2-specific routes
  registerRoute('/api/a2a/*', handleA2ARoute);
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/shortcut', handleShortcut);
  registerRoute('/agent/p2p', handleAgentP2P);
  registerRoute('/agent/message', handleAgentMessageRoute);
  registerRoute('/agent/send', handleAgentSend);
  registerRoute('/agent/status', handleAgentStatusEndpoint);
  registerRoute('/agent/extended-status', handleExtendedStatus);
  registerRoute('/api/context', handleContextApi);
  registerRoute('/hook/response', handleHookResponse);
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
  registerAgentTasks(_scheduler);

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
  initAgentAccessControl();

  // Register health checks (extension + comprehensive system checks)
  registerLocalHealthChecks();
  registerAgentHealthChecks(_config);

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
  if (_telegramAdapter) {
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

/**
 * The R2 extension — register this with the kithkit daemon.
 *
 * Usage in a bootstrap file:
 *   import { registerExtension } from './core/extensions.js';
 *   import { agentExtension } from './extensions/index.js';
 *   registerExtension(agentExtension);
 */
export const agentExtension: Extension = {
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
