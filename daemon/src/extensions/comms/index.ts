/**
 * Comms Extension — registers Telegram adapter, agent-comms, and core tasks.
 *
 * This is the main extension entry point for kithkit agent-to-agent communication.
 * It wires up:
 * - Telegram polling adapter (inbound + outbound)
 * - Agent-to-agent messaging (LAN direct)
 * - Channel router registration
 * - Core scheduler tasks
 */

import http from 'node:http';
import type { Extension } from '../../core/extensions.js';
import type { KithkitConfig } from '../../core/config.js';
import type { AgentConfig } from '../config.js';
import { createLogger } from '../../core/logger.js';
import { registerAdapter, unregisterAdapter } from '../../comms/channel-router.js';
import { registerRoute, type RouteHandler } from '../../core/route-registry.js';
import { createCommsTelegramAdapter, type CommsTelegramAdapter } from './telegram.js';
import {
  initAgentComms,
  stopAgentComms,
  handleAgentMessage,
  sendAgentMessage,
  getAgentStatus,
  sendViaLAN,
  logCommsEntry,
  setRouter,
} from './agent-comms.js';
import {
  initNetworkSDK,
  stopNetworkSDK,
  handleIncomingP2P,
  getNetworkClient,
} from './network/sdk-bridge.js';
import { handleNetworkRoute } from './network/api.js';
import { UnifiedA2ARouter } from '../../a2a/router.js';
import { handleA2ARoute, setA2ARouter } from '../../a2a/handler.js';
import { readKeychain } from '../../core/keychain.js';
import { sendMessage } from '../../agents/message-router.js';


const log = createLogger('comms-extension');

// ── State ────────────────────────────────────────────────────

let _telegramAdapter: CommsTelegramAdapter | null = null;
let _config: KithkitConfig | null = null;

// ── Helpers ──────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Route Handlers ──────────────────────────────────────────

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
    log.error('Agent message endpoint error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
  return true;
}

async function handleAgentSendRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  try {
    const body = await readBody(req);
    const { to, type, text, ...extra } = JSON.parse(body);
    if (!to || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Deprecation': 'true', 'Link': '</api/a2a/send>; rel="successor-version"' });
      res.end(JSON.stringify({ error: "'to' and 'type' are required" }));
      return true;
    }
    const result = await sendAgentMessage(to, type, text ?? '', extra);
    const status = (result as { ok: boolean }).ok ? 200 : 502;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Deprecation': 'true', 'Link': '</api/a2a/send>; rel="successor-version"' });
    res.end(JSON.stringify(result));
  } catch (err) {
    log.error('Agent send endpoint error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(400, { 'Content-Type': 'application/json', 'Deprecation': 'true', 'Link': '</api/a2a/send>; rel="successor-version"' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  }
  return true;
}

async function handleAgentStatusRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getAgentStatus()));
  return true;
}

// ── Extension ────────────────────────────────────────────────

export const commsExtension: Extension = {
  name: 'comms',

  async onInit(config: KithkitConfig, _server: http.Server): Promise<void> {
    log.info('Comms extension initializing...');
    _config = config;

    // ── Agent-to-Agent Comms ────────────────────────────────
    initAgentComms(config);
    registerRoute('/agent/message', handleAgentMessageRoute as RouteHandler);
    registerRoute('/agent/send', handleAgentSendRoute as RouteHandler);
    registerRoute('/agent/status', handleAgentStatusRoute as RouteHandler);
    log.info('Agent comms routes registered');

    // ── Unified A2A Router ─────────────────────────────────
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
    registerRoute('/api/a2a/*', handleA2ARoute as RouteHandler);
    log.info('Unified A2A route registered');


    // ── A2A Network SDK ─────────────────────────────────────
    try {
      const networkOk = await initNetworkSDK(config as AgentConfig);
      if (networkOk) {
        registerRoute('/api/network/*', handleNetworkRoute as RouteHandler);
        registerRoute('/agent/p2p', (async (req, res) => {
          if (req.method !== 'POST') return false;
          try {
            const body = await readBody(req);
            const envelope = JSON.parse(body);
            await handleIncomingP2P(envelope);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid envelope' }));
          }
          return true;
        }) as RouteHandler);
        log.info('A2A Network SDK initialized and routes registered');
      } else {
        log.warn('A2A Network SDK not available — LAN-only mode');
      }
    } catch (err) {
      log.error('A2A Network SDK init failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Telegram ────────────────────────────────────────────
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

    // Register a status route for telegram
    registerRoute('/telegram/status', (async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        adapter: 'comms-telegram',
        mode: 'polling',
      }));
      return true;
    }) as RouteHandler);

    log.info('Comms extension initialized');
  },

  async onRoute(
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    _pathname: string,
    _searchParams: URLSearchParams,
  ): Promise<boolean> {
    return false;
  },

  async onShutdown(): Promise<void> {
    log.info('Comms extension shutting down...');

    await stopNetworkSDK();
    stopAgentComms();

    if (_telegramAdapter) {
      await _telegramAdapter.shutdown();
      unregisterAdapter('telegram');
      _telegramAdapter = null;
    }

    log.info('Comms extension shut down');
  },
};
