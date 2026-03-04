/**
 * BMO Instance Extensions — all BMO-specific daemon capabilities.
 * This file is in .gitignore upstream and never syncs to the public repo.
 */

import http from 'node:http';
import type { KithkitConfig } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import type { Scheduler } from '../../automation/scheduler.js';
import { asAgentConfig, type AgentConfig } from '../config.js';
import { readKeychain } from '../../core/keychain.js';
import { parseBody } from '../../api/helpers.js';
import { registerAdapter, unregisterAdapter } from '../../comms/channel-router.js';

// BMO-specific imports
import {
  initCoworkBridge,
  shutdownCoworkBridge,
  handleCoworkRoute,
  setAuthToken,
  setPsk,
} from '../cowork-bridge.js';
import { createBmoTelegramAdapter, BmoTelegramAdapter } from '../comms/adapters/telegram.js';
import { initVoice, stopVoice } from '../voice/index.js';
import { handleMemorySync } from '../automation/tasks/memory-sync.js';
import { registerAgentTasks, REAL_TASK_NAMES } from '../automation/tasks/index.js';
import { registerAgentHealthChecks as registerAgentHealthChecksExtended } from '../health-extended.js';

const log = createLogger('bmo-instance');

let _telegramAdapter: BmoTelegramAdapter | null = null;
let _config: AgentConfig | null = null;

// readBody helper (same as framework version, needed for routes)
function readBody(req: http.IncomingMessage): Promise<string> {
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

// BMO-specific route handlers
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

// Stub handler for not-yet-implemented tasks
function stubHandler(name: string) {
  return async () => {
    log.debug(`Task handler stub: ${name}`);
  };
}

const AGENT_TASK_HANDLERS = [
  'health-check',
  'memory-consolidation',
  'weekly-progress-report',
] as const;

/**
 * Register all BMO-specific extensions.
 * Called dynamically by the framework's loadInstanceExtensions().
 */
export async function register(
  config: KithkitConfig,
  server: http.Server,
  scheduler: Scheduler,
): Promise<void> {
  _config = asAgentConfig(config);

  // Load cowork credentials from Keychain
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

  // Initialize cowork WebSocket bridge
  initCoworkBridge(server);

  // Voice extension
  if (_config.channels?.voice) {
    await initVoice(_config.channels.voice);
  }

  // BMO Telegram adapter
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

  // BMO-specific routes
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/agent/memory-sync', handleMemorySyncRoute);
  registerRoute('/api/cowork/*', handleCoworkRoute);

  // Register BMO-specific task handlers
  registerAgentTasks(scheduler);

  // Register stub handlers for remaining tasks
  for (const taskName of AGENT_TASK_HANDLERS) {
    if (REAL_TASK_NAMES.has(taskName)) continue;
    if (scheduler.getTask(taskName)) {
      scheduler.registerHandler(taskName, stubHandler(taskName));
    }
  }

  // Register extended health checks
  registerAgentHealthChecksExtended(_config);

  log.info('BMO instance extensions initialized', {
    cowork: true,
    telegram: !!_telegramAdapter,
    voice: !!_config.channels?.voice,
  });
}

/**
 * Shutdown all BMO-specific extensions.
 * Called by the framework's onShutdown().
 */
export async function shutdown(): Promise<void> {
  shutdownCoworkBridge();
  stopVoice();
  if (_telegramAdapter) {
    _telegramAdapter.stopTyping();
    unregisterAdapter('telegram');
    _telegramAdapter = null;
  }
  log.info('BMO instance extensions shut down');
}
