/**
 * Channel Router — wraps the kithkit channel-router with agent-specific behavior.
 *
 * Adds:
 * - channel.txt file management (agent's active channel state)
 * - Telegram typing indicators
 * - Voice-pending callback support
 * - Response hook for web voice
 * - Direct Telegram send (bypasses channel check)
 *
 * This module bridges between the kithkit channel-router (multi-adapter dispatch)
 * and the agent's channel.txt-based routing model (single active channel at a time).
 *
 * Ported from CC4Me v1 daemon/src/comms/channel-router.ts
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { getDatabase } from '../../core/db.js';
import {
  registerAdapter,
  routeMessage as kithkitRouteMessage,
} from '../../comms/channel-router.js';
import type { ChannelAdapter, OutboundMessage } from '../../comms/adapter.js';

const log = createLogger('channel-router');

// ── Types ────────────────────────────────────────────────────

export type AgentChannel = 'terminal' | 'telegram' | 'telegram-verbose' | 'silent' | 'voice';
type MessageHandler = (text: string) => void;

// ── State ────────────────────────────────────────────────────

let _telegramAdapter: (ChannelAdapter & { startTyping?(): Promise<void>; stopTyping?(): void }) | null = null;
let _voicePendingCallback: MessageHandler | null = null;
let _responseHook: MessageHandler | null = null;

const CHANNEL_FILE_REL = '.kithkit/state/channel.txt';

// ── Channel file management ──────────────────────────────────

/** Get agent's current active channel from state file. */
export function getChannel(): AgentChannel {
  try {
    const content = fs.readFileSync(resolveProjectPath(CHANNEL_FILE_REL), 'utf8').trim();
    if (['terminal', 'telegram', 'telegram-verbose', 'silent', 'voice'].includes(content)) {
      return content as AgentChannel;
    }
  } catch { /* missing file */ }
  return 'terminal';
}

/** Set agent's active channel. Also updates last_active_channel for text channels. */
export function setChannel(channel: AgentChannel): void {
  fs.writeFileSync(resolveProjectPath(CHANNEL_FILE_REL), channel + '\n');
  log.info(`Channel set to: ${channel}`);
  // Track text channels as last active (voice is an input method, not a channel)
  if (channel !== 'voice' && channel !== 'silent') {
    updateLastActiveChannel(channel);
  }
}

// ── Last active channel tracking ─────────────────────────────
// Tracks the last text channel that sent an inbound message.
// Voice input does NOT update this — voice is an input method, not a channel.
// Used by the voice pipeline to route responses to the right text channel.

const TEXT_CHANNELS: AgentChannel[] = ['telegram', 'telegram-verbose', 'terminal'];

/**
 * Update last_active_channel when an inbound message arrives from a text channel.
 * Stored in the feature_state DB table for persistence across daemon restarts.
 */
export function updateLastActiveChannel(channel: AgentChannel): void {
  if (!TEXT_CHANNELS.includes(channel)) return;
  try {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO feature_state (feature, state, updated_at)
       VALUES ('last_active_channel', ?, ?)
       ON CONFLICT(feature) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ channel, updated_at: now }), now);
    log.debug(`Last active channel updated: ${channel}`);
  } catch (err) {
    log.warn('Failed to update last_active_channel', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get the last active text channel. Defaults to 'telegram' if none recorded.
 */
export function getLastActiveChannel(): AgentChannel {
  try {
    const db = getDatabase();
    const row = db.prepare(
      `SELECT state FROM feature_state WHERE feature = 'last_active_channel'`,
    ).get() as { state: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.state);
      if (parsed.channel && TEXT_CHANNELS.includes(parsed.channel)) {
        return parsed.channel as AgentChannel;
      }
    }
  } catch { /* missing or parse error */ }
  return 'telegram';
}

// ── Adapter registration ─────────────────────────────────────

/**
 * Register the Telegram adapter with both kithkit channel-router and agent router.
 * Captures a reference for typing indicator control.
 */
export function registerTelegramAdapter(adapter: ChannelAdapter & { startTyping?(): Promise<void>; stopTyping?(): void }): void {
  _telegramAdapter = adapter;
  registerAdapter(adapter);
  log.info('Telegram adapter registered with channel router');
}

/**
 * Register an email adapter with the kithkit channel-router.
 */
export function registerEmailAdapter(adapter: ChannelAdapter): void {
  registerAdapter(adapter);
  log.info(`Email adapter registered: ${adapter.name}`);
}

// ── Typing indicators ────────────────────────────────────────

/** Start the Telegram typing indicator. */
export function startTypingIndicator(): void {
  if (_telegramAdapter?.startTyping) {
    _telegramAdapter.startTyping();
  }
}

/** Signal response complete — stop typing. */
export function signalResponseComplete(): void {
  if (_telegramAdapter?.stopTyping) {
    _telegramAdapter.stopTyping();
  }
}

// ── Voice-pending ────────────────────────────────────────────

/** Register a one-shot callback for the next assistant response (voice pipeline). */
export function registerVoicePending(callback: MessageHandler): void {
  _voicePendingCallback = callback;
  log.debug('Voice-pending callback registered');
}

export function clearVoicePending(): void {
  _voicePendingCallback = null;
}

export function isVoicePending(): boolean {
  return _voicePendingCallback !== null;
}

// ── Response hook ────────────────────────────────────────────

/** Register a one-shot response hook (fires after normal routing). */
export function setResponseHook(callback: MessageHandler): void {
  _responseHook = callback;
}

export function clearResponseHook(): void {
  _responseHook = null;
}

// ── Direct send ──────────────────────────────────────────────

/** Send directly to Telegram, bypassing channel check. */
export function sendDirectTelegram(text: string): boolean {
  if (!_telegramAdapter) {
    log.warn('sendDirectTelegram: no adapter registered');
    return false;
  }
  _telegramAdapter.send({ text }).catch(() => {});
  return true;
}

// ── Outgoing message routing ─────────────────────────────────

/**
 * Route an outgoing message based on the agent's active channel.
 *
 * Called by transcript-stream when it detects a new assistant message.
 * Maps the agent's channel.txt to kithkit adapter dispatch.
 */
export function routeOutgoingMessage(text: string, thinking?: string): void {
  // Clear voice-pending (voice input defaults to active channel for faster delivery)
  if (_voicePendingCallback) {
    _voicePendingCallback = null;
    log.info('Voice-pending cleared, routing via normal channel');
  }

  const channel = getChannel();

  switch (channel) {
    case 'terminal':
    case 'silent':
    case 'voice':
      log.debug(`Channel is ${channel}, not forwarding: ${text.length} chars`);
      break;

    case 'telegram':
      if (_telegramAdapter) {
        kithkitRouteMessage({ text }, ['telegram']).catch(err => {
          log.error('Telegram route error', { error: err instanceof Error ? err.message : String(err) });
        });
      } else {
        log.warn('Telegram message dropped: no adapter registered');
      }
      break;

    case 'telegram-verbose':
      if (_telegramAdapter) {
        if (thinking) {
          kithkitRouteMessage({ text: `💭 ${thinking}` }, ['telegram']).catch(() => {});
        }
        kithkitRouteMessage({ text }, ['telegram']).catch(err => {
          log.error('Telegram route error (verbose)', { error: err instanceof Error ? err.message : String(err) });
        });
      } else {
        log.warn('Telegram message dropped: no adapter registered');
      }
      break;
  }

  // Fire one-shot response hook
  if (_responseHook) {
    const hook = _responseHook;
    _responseHook = null;
    try { hook(text); } catch (err) {
      log.error('Response hook error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ── Init ─────────────────────────────────────────────────────

/** Initialize the channel router. */
export function initChannelRouter(): void {
  log.info(`Channel router initialized (current: ${getChannel()})`);
}

// ── Testing ──────────────────────────────────────────────────

export function _resetForTesting(): void {
  _telegramAdapter = null;
  _voicePendingCallback = null;
  _responseHook = null;
}
