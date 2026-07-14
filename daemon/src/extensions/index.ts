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
import crypto from 'node:crypto';
import type { KithkitConfig } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { registerRoute } from '../core/route-registry.js';
import { registerCheck } from '../core/extended-status.js';
import { setScheduler, _getSchedulerForTesting } from '../api/tasks.js';
import { Scheduler } from '../automation/scheduler.js';
import type { Extension } from '../core/extensions.js';
import { asAgentConfig, type AgentConfig, type A2ASigningPosture } from './config.js';
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
  refreshAgentCommsConfig,
} from './comms/agent-comms.js';
import { initNetworkSDK, stopNetworkSDK, handleIncomingP2P, getNetworkClient } from './comms/network/sdk-bridge.js';
import type { P2PHandleResult } from './comms/network/sdk-bridge.js';
import { registerWithRelay } from './comms/network/registration.js';
import { runRegistrationRetryLoop } from './comms/network/retry.js';
import { handleNetworkRoute } from './comms/network/api.js';
import type { WireEnvelope } from './comms/network/sdk-types.js';
import { registerCoreTasks } from '../automation/tasks/index.js';
import { JobsWatcher } from '../automation/jobs-watcher.js';
import { commsSessionExists } from '../core/session-bridge.js';
import { enableVectorSearch } from '../api/memory.js';
import { initWikiVectorSearch } from '../api/wiki.js';
import { startEmbedWorker, stopEmbedWorker } from '../memory/embed-client.js';
import { getProjectDir } from '../core/config.js';
import { readKeychain } from '../core/keychain.js';
import { parseBody } from '../api/helpers.js';
import { UnifiedA2ARouter } from '../a2a/router.js';
import { handleA2ARoute, setA2ARouter } from '../a2a/handler.js';
import { sendMessage } from '../agents/message-router.js';
import { RateLimiter } from '../core/rate-limiter.js';
import { registerAdapter, unregisterAdapter } from '../comms/channel-router.js';
import { createCommsTelegramAdapter, type CommsTelegramAdapter, type TelegramUpdate } from './comms/adapters/telegram.js';
import { parseApprovalCallback, answerCallbackQuery } from '../comms/approval-card-telegram.js';
import { resolveGate } from '../comms/approval-gate.js';
import { initTeamsExtension, shutdownTeamsExtension } from './teams/index.js';

const log = createLogger('agent-extension');

// ── State ────────────────────────────────────────────────────

const p2pRateLimiter = new RateLimiter(30, 60_000); // 30 req/min per IP

let _config: AgentConfig | null = null;
let _scheduler: Scheduler | null = null;
let _jobsWatcher: JobsWatcher | null = null;
let _initialized = false;
let _instanceShutdown: (() => Promise<void> | void) | null = null;
let _retryAbortController: AbortController | null = null;
let _telegramAdapter: CommsTelegramAdapter | null = null;

// Injectable seam for the Keychain reader — production uses readKeychain;
// tests inject a stub so the real HMAC computation runs against known values
// without touching the macOS Keychain.
let _keychainReader: (service: string) => Promise<string | null> = readKeychain;

// ── A2A Signing Enforcement ─────────────────────────────────

/**
 * Evaluate whether an incoming A2A request passes HMAC signing requirements.
 *
 * Three-state Keychain outcome:
 *   null return  → key not configured → accept (current permissive behaviour)
 *   throw        → Keychain inaccessible → enforce: reject  / permissive: warn+accept
 *   string       → key configured → enforce: require valid sig / permissive: warn+accept
 *
 * The HMAC verification itself (crypto.createHmac) is NOT injectable — it runs
 * unconditionally on both production and test paths. Only the Keychain reader is
 * injectable so tests can supply a known secret without touching macOS Keychain.
 *
 * Exported for direct unit testing (non-vacuous mutation-kill coverage).
 */
export async function _checkA2ASignatureEnforcement(
  bodyStr: string,
  signature: string | undefined,
  posture: A2ASigningPosture,
): Promise<{ action: 'accept' | 'reject' | 'warn'; reason?: string }> {
  let secret: string | null = null;
  let keychainFailed = false;

  try {
    secret = await _keychainReader('credential-agent-comms-secret');
  } catch {
    keychainFailed = true;
  }

  if (keychainFailed) {
    if (posture === 'enforce') {
      return { action: 'reject', reason: 'Signature verification unavailable (Keychain error)' };
    }
    return { action: 'warn', reason: 'Keychain unavailable — accepting without verification' };
  }

  // No key configured — preserve current permissive behaviour regardless of posture
  if (secret === null) {
    return { action: 'accept' };
  }

  // Key is configured — verify or enforce based on posture
  if (!signature) {
    if (posture === 'enforce') {
      return { action: 'reject', reason: 'Signature required' };
    }
    return { action: 'warn', reason: 'No signature (transition period)' };
  }

  // Real HMAC verification — crypto.createHmac is never mocked
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(bodyStr);
  const expected = hmac.digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { action: 'reject', reason: 'Invalid signature' };
  }

  return { action: 'accept' };
}

// ── Route Handlers ──────────────────────────────────────────

/**
 * Read raw request body as a string (needed for HMAC verification).
 * Respects the pre-buffered _rawBody from metrics middleware if available.
 */
function parseBodyRaw(req: http.IncomingMessage): Promise<string> {
  const pre = (req as unknown as Record<string, unknown>)._rawBody;
  if (pre instanceof Buffer) {
    return Promise.resolve(pre.toString());
  }
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX = 1024 * 1024; // 1MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Request body too large')); return; }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleAgentP2P(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  // Rate limit by source IP
  const clientIp = req.socket.remoteAddress ?? 'unknown';
  if (!p2pRateLimiter.check(clientIp)) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '60',
    });
    res.end(JSON.stringify({ ok: false, error: 'Rate limit exceeded' }));
    return true;
  }

  try {
    const bodyStr = await parseBodyRaw(req);
    const envelope = JSON.parse(bodyStr) as WireEnvelope;

    // Enforce HMAC signature per configured posture (#584).
    // Default: enforce — /agent/p2p is internet-reachable via relay.bmobot.ai.
    const p2pPosture: A2ASigningPosture = _config?.a2a?.security?.p2p ?? 'enforce';
    const signature = req.headers['x-signature'] as string | undefined;
    const sigResult = await _checkA2ASignatureEnforcement(bodyStr, signature, p2pPosture);
    if (sigResult.action === 'reject') {
      log.warn('P2P message rejected: signing enforcement', {
        reason: sigResult.reason,
        sender: (envelope as unknown as Record<string, unknown>).sender,
      });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: sigResult.reason ?? 'Unauthorized' }));
      return true;
    }
    if (sigResult.action === 'warn') {
      log.warn('P2P message accepted with signing warning', {
        reason: sigResult.reason,
        sender: (envelope as unknown as Record<string, unknown>).sender,
      });
    }

    const p2pResult: P2PHandleResult = await handleIncomingP2P(envelope);
    if (!p2pResult.ok) {
      if (p2pResult.permanent) {
        // Permanent reject (4xx) — SDK rejected the envelope (bad/invalid content).
        // Sender MUST NOT retry; retrying will not fix a client-side envelope error.
        log.warn('P2P message permanently rejected by SDK (bad envelope)', {
          sender: (envelope as unknown as Record<string, unknown>).sender,
        });
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Message rejected: invalid envelope' }));
      } else {
        // Transient failure (5xx) — SDK unavailable; envelope was NOT stored.
        // Sender should retry later once the SDK initialises.
        log.warn('P2P message not persisted (SDK unavailable)', {
          sender: (envelope as unknown as Record<string, unknown>).sender,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Service temporarily unavailable' }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
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
    // Read raw body first so we can verify HMAC before parsing (#584).
    // parseBodyRaw respects the pre-buffered _rawBody from metrics middleware.
    const bodyStr = await parseBodyRaw(req);
    const parsed = JSON.parse(bodyStr) as unknown;

    // Check signature enforcement for /agent/message.
    // Default: permissive — trusted home LAN; flip to enforce in kithkit.config.yaml.
    const msgPosture: A2ASigningPosture = _config?.a2a?.security?.message ?? 'permissive';
    const msgSig = req.headers['x-signature'] as string | undefined;
    const msgSigResult = await _checkA2ASignatureEnforcement(bodyStr, msgSig, msgPosture);
    if (msgSigResult.action === 'reject') {
      log.warn('Agent message rejected: signing enforcement', { reason: msgSigResult.reason });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msgSigResult.reason ?? 'Unauthorized' }));
      return true;
    }
    if (msgSigResult.action === 'warn') {
      log.warn('Agent message accepted with signing warning', { reason: msgSigResult.reason });
    }

    const result = await handleAgentMessage(parsed);
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

async function handleTelegramStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    adapter: 'comms-telegram',
    mode: 'polling',
  }));
  return true;
}

async function handleTelegramWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_telegramAdapter) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Telegram adapter not initialized' }));
    return true;
  }
  try {
    const body = await parseBody(req);
    const update = body as TelegramUpdate;

    // ── Approval callback_query interception ─────────────────
    // Inline keyboard button taps from approval cards arrive as callback_query
    // updates. Intercept them here before forwarding to the regular adapter.
    if (update.callback_query) {
      const cq = update.callback_query;
      const callbackData = cq.data ?? '';
      const parsed = parseApprovalCallback(callbackData);

      if (parsed) {
        // This is an approval card callback — resolve the gate
        const result = resolveGate(parsed.approval_id, parsed.decision);

        let ackText: string;
        if (result === 'ok') {
          ackText = parsed.decision === 'approved' ? '✅ Approved — sending now.' : '❌ Rejected — send aborted.';
          log.info('Approval decision via Telegram inline button', {
            approval_id: parsed.approval_id,
            decision: parsed.decision,
          });
        } else if (result === 'already_resolved') {
          ackText = 'This approval has already been decided.';
        } else {
          ackText = 'Approval not found or expired.';
        }

        // Answer callback query to dismiss the Telegram loading spinner
        answerCallbackQuery(cq.id, ackText).catch(() => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }
      // Not an approval callback — fall through to regular handleUpdate
    }
    // ── End approval interception ─────────────────────────────

    await _telegramAdapter.handleUpdate(update);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log.error('Telegram webhook error', { error: err instanceof Error ? err.message : String(err) });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid update' }));
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
    // @ts-ignore — instance/index.js is repo-specific and absent in upstream kithkit; handled by catch below
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

// ── Network Registration Retry ──────────────────────────────

/**
 * Register with the relay and initialize the Network SDK.
 * Retries on failure with exponential backoff (5s base, 5min cap, 10 attempts).
 * Cancelled immediately when `signal` fires — preventing zombie retry loops
 * during daemon restart cycles. Registration state is recorded per-community
 * via network-state.ts so GET /api/network/status reflects actual outcome.
 */
async function registerWithRetry(config: AgentConfig, signal: AbortSignal): Promise<void> {
  return runRegistrationRetryLoop(
    config,
    signal,
    registerWithRelay,
    async (c) => {
      const sdkOk = await initNetworkSDK(c as unknown as Record<string, unknown>);
      if (sdkOk) log.info('Network SDK ready');
    },
  );
}

// ── Extension Implementation ────────────────────────────────

function onConfigChange(config: KithkitConfig): void {
  // Update P2P rate limiter
  const inMax = config.security?.rate_limits?.incoming_max_per_minute;
  if (typeof inMax === 'number') {
    p2pRateLimiter.reload(inMax, 60_000);
    log.info('P2P rate limiter reloaded', { incomingMaxPerMinute: inMax });
  }

  // Reload scheduler tasks so new/removed/updated tasks take effect
  if (_scheduler) {
    _scheduler.reload(config.scheduler?.tasks ?? []);
    log.info('Scheduler reloaded', { taskCount: config.scheduler?.tasks?.length ?? 0 });
  }

  // Refresh agent-comms peer config so peer list changes take effect
  refreshAgentCommsConfig(config);
  log.info('Agent-comms config refreshed');
}

async function onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
  _config = asAgentConfig(config);

  // Sync P2P rate limiter to configured incoming limit
  onConfigChange(config);

  // Start P2P rate limiter cleanup
  p2pRateLimiter.startCleanup();

  // Start the ONNX embed worker child process BEFORE enabling vector search.
  // Isolation prevents the native libc++ mutex abort that fires when fork()
  // and ONNX inference coexist in the same process (kithkit#469/#471).
  try {
    const projectDir = getProjectDir();
    await startEmbedWorker(projectDir);
    log.info('Embed worker started');
  } catch (err) {
    log.error('Embed worker failed to start — vector search will be unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Degraded mode: no vector search rather than crashing the daemon
  }

  // Enable vector search (sqlite-vec + ONNX embeddings)
  enableVectorSearch();

  // Enable wiki vector search (creates wiki_vec and vec_wiki_map after sqlite-vec loads)
  initWikiVectorSearch();

  // Initialize agent-to-agent comms (LAN + P2P SDK)
  initAgentComms(_config);

  // ── Telegram ─────────────────────────────────────────────
  const fullConfig = config as KithkitConfig & {
    channels?: {
      telegram?: {
        enabled?: boolean;
        bot_token?: string;
        safe_senders?: Array<{ chat_id: number; name: string }>;
        poll_interval_ms?: number;
        max_message_length?: number;
        allowed_chat_ids?: number[];
      };
    };
  };
  const telegramConfig = fullConfig.channels?.telegram;
  if (!telegramConfig?.enabled) {
    log.warn('Telegram not enabled in config (channels.telegram.enabled)');
  } else if (!telegramConfig.bot_token) {
    log.error('No bot_token in channels.telegram config');
  } else {
    let safeSenders = telegramConfig.safe_senders ?? [];
    if (safeSenders.length === 0 && telegramConfig.allowed_chat_ids?.length) {
      safeSenders = telegramConfig.allowed_chat_ids.map((id, i) => ({
        chat_id: id,
        name: `User${i + 1}`,
      }));
    }
    try {
      _telegramAdapter = await createCommsTelegramAdapter({
        bot_token: telegramConfig.bot_token,
        safe_senders: safeSenders,
        poll_interval_ms: telegramConfig.poll_interval_ms ?? 3000,
        max_message_length: telegramConfig.max_message_length ?? 4000,
      });
      registerAdapter(_telegramAdapter);
      log.info('Telegram adapter registered with channel router');
    } catch (err) {
      log.error('Failed to initialize Telegram adapter', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  registerRoute('/telegram', handleTelegramWebhook);
  registerRoute('/telegram/status', handleTelegramStatus);

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

  // Network SDK (P2P messaging) — non-blocking, with exponential backoff retry.
  // AbortController lets onShutdown() cancel the loop rather than leaving a zombie.
  if (_config.network?.enabled) {
    _retryAbortController = new AbortController();
    registerWithRetry(_config, _retryAbortController.signal).catch(err => log.error('registerWithRetry failed', {
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

  // Hot-load agent-specific jobs from the watched directory (opt-in)
  const hotLoadConfig = config.scheduler.hot_load_jobs;
  if (hotLoadConfig?.enabled !== false) {
    const jobsDir = hotLoadConfig?.dir ?? '.kithkit/scheduled-jobs';
    _jobsWatcher = new JobsWatcher(_scheduler, jobsDir);
    _jobsWatcher.start();
  }

  // Wire scheduler to the tasks API
  setScheduler(_scheduler);
  _scheduler.start();

  // Initialize agent access control (5-tier, channel-aware)
  initAgentAccessControl();

  // Register basic extension health check
  registerAgentHealthChecks();

  // ── Teams Bot Framework extension ──────────────────────────
  // Reads credentials from Keychain; safe to call when Teams is not configured
  // (logs a warning and returns without registering routes/adapter).
  await initTeamsExtension();

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
  // Cancel the registration retry loop before stopping the SDK — prevents zombie loops
  // from the previous run still being alive when the next onInit fires.
  if (_retryAbortController) {
    _retryAbortController.abort();
    _retryAbortController = null;
  }

  // Shutdown instance extensions first
  if (_instanceShutdown) {
    await _instanceShutdown();
  }
  if (_telegramAdapter) {
    await _telegramAdapter.shutdown();
    unregisterAdapter('telegram');
    _telegramAdapter = null;
  }
  shutdownTeamsExtension();
  p2pRateLimiter.stop();
  await stopNetworkSDK();
  stopAgentComms();
  if (_jobsWatcher) {
    _jobsWatcher.stop();
    _jobsWatcher = null;
  }
  if (_scheduler) {
    _scheduler.stop();
    _scheduler = null;
  }
  // Stop the ONNX embed worker child process (symmetric to voice stopWorker)
  stopEmbedWorker();
  _initialized = false;
  log.info('Agent extension shut down');
}

// ── Export ───────────────────────────────────────────────────

export const agentExtension: Extension = {
  name: 'agent',
  onInit,
  onShutdown,
  onConfigChange,
};

// For testing
export function _getStateForTesting() {
  return { config: _config, scheduler: _scheduler, initialized: _initialized };
}

export function _setSchedulerForTesting(s: Scheduler | null): void {
  _scheduler = s;
}

export function _resetForTesting(): void {
  if (_retryAbortController) {
    _retryAbortController.abort();
    _retryAbortController = null;
  }
  if (_jobsWatcher) {
    _jobsWatcher.stop();
    _jobsWatcher = null;
  }
  _config = null;
  _scheduler = null;
  _initialized = false;
  _instanceShutdown = null;
  _telegramAdapter = null;
  _keychainReader = readKeychain;
}

// ── A2A Signing Test Seams ───────────────────────────────────

/** Override the Keychain reader in tests (supply a known secret without touching macOS Keychain). */
export function _setKeychainReaderForTesting(reader: (service: string) => Promise<string | null>): void {
  _keychainReader = reader;
}

/** Restore the real Keychain reader after tests. Also called by _resetForTesting(). */
export function _resetKeychainReaderForTesting(): void {
  _keychainReader = readKeychain;
}

/** Set _config directly for tests that need a specific a2a.security posture. */
export function _setConfigForTesting(config: AgentConfig | null): void {
  _config = config;
}

/** Expose the handler for HTTP-level integration tests. */
export { handleAgentP2P as _handleAgentP2PForTesting };
export { handleAgentMessageRoute as _handleAgentMessageRouteForTesting };
