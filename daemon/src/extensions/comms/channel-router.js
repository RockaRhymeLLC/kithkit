/**
 * BMO Channel Router — wraps the kithkit channel-router with BMO-specific behavior.
 *
 * Adds:
 * - channel.txt file management (BMO's active channel state)
 * - Telegram typing indicators
 * - Voice-pending callback support
 * - Response hook for web voice
 * - Direct Telegram send (bypasses channel check)
 *
 * This module bridges between the kithkit channel-router (multi-adapter dispatch)
 * and BMO's channel.txt-based routing model (single active channel at a time).
 *
 * Ported from CC4Me v1 daemon/src/comms/channel-router.ts
 */
import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import { registerAdapter, routeMessage as kithkitRouteMessage, } from '../../comms/channel-router.js';
const log = createLogger('bmo-channel-router');
// ── State ────────────────────────────────────────────────────
let _telegramAdapter = null;
let _voicePendingCallback = null;
let _responseHook = null;
const CHANNEL_FILE_REL = '.claude/state/channel.txt';
// ── Channel file management ──────────────────────────────────
/** Get BMO's current active channel from state file. */
export function getChannel() {
    try {
        const content = fs.readFileSync(resolveProjectPath(CHANNEL_FILE_REL), 'utf8').trim();
        if (['terminal', 'telegram', 'telegram-verbose', 'silent', 'voice'].includes(content)) {
            return content;
        }
    }
    catch { /* missing file */ }
    return 'terminal';
}
/** Set BMO's active channel. */
export function setChannel(channel) {
    fs.writeFileSync(resolveProjectPath(CHANNEL_FILE_REL), channel + '\n');
    log.info(`Channel set to: ${channel}`);
}
// ── Adapter registration ─────────────────────────────────────
/**
 * Register the Telegram adapter with both kithkit channel-router and BMO router.
 * Captures a reference for typing indicator control.
 */
export function registerTelegramAdapter(adapter) {
    _telegramAdapter = adapter;
    registerAdapter(adapter);
    log.info('Telegram adapter registered with BMO channel router');
}
/**
 * Register an email adapter with the kithkit channel-router.
 */
export function registerEmailAdapter(adapter) {
    registerAdapter(adapter);
    log.info(`Email adapter registered: ${adapter.name}`);
}
// ── Typing indicators ────────────────────────────────────────
/** Start the Telegram typing indicator. */
export function startTypingIndicator() {
    if (_telegramAdapter?.startTyping) {
        _telegramAdapter.startTyping();
    }
}
/** Signal response complete — stop typing. */
export function signalResponseComplete() {
    if (_telegramAdapter?.stopTyping) {
        _telegramAdapter.stopTyping();
    }
}
// ── Voice-pending ────────────────────────────────────────────
/** Register a one-shot callback for the next assistant response (voice pipeline). */
export function registerVoicePending(callback) {
    _voicePendingCallback = callback;
    log.debug('Voice-pending callback registered');
}
export function clearVoicePending() {
    _voicePendingCallback = null;
}
export function isVoicePending() {
    return _voicePendingCallback !== null;
}
// ── Response hook ────────────────────────────────────────────
/** Register a one-shot response hook (fires after normal routing). */
export function setResponseHook(callback) {
    _responseHook = callback;
}
export function clearResponseHook() {
    _responseHook = null;
}
// ── Direct send ──────────────────────────────────────────────
/** Send directly to Telegram, bypassing channel check. */
export function sendDirectTelegram(text) {
    if (!_telegramAdapter) {
        log.warn('sendDirectTelegram: no adapter registered');
        return false;
    }
    _telegramAdapter.send({ text }).catch(() => { });
    return true;
}
// ── Outgoing message routing ─────────────────────────────────
/**
 * Route an outgoing message based on BMO's active channel.
 *
 * Called by transcript-stream when it detects a new assistant message.
 * Maps BMO's channel.txt to kithkit adapter dispatch.
 */
export function routeOutgoingMessage(text, thinking) {
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
            }
            else {
                log.warn('Telegram message dropped: no adapter registered');
            }
            break;
        case 'telegram-verbose':
            if (_telegramAdapter) {
                if (thinking) {
                    kithkitRouteMessage({ text: `💭 ${thinking}` }, ['telegram']).catch(() => { });
                }
                kithkitRouteMessage({ text }, ['telegram']).catch(err => {
                    log.error('Telegram route error (verbose)', { error: err instanceof Error ? err.message : String(err) });
                });
            }
            else {
                log.warn('Telegram message dropped: no adapter registered');
            }
            break;
    }
    // Fire one-shot response hook
    if (_responseHook) {
        const hook = _responseHook;
        _responseHook = null;
        try {
            hook(text);
        }
        catch (err) {
            log.error('Response hook error', { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
// ── Init ─────────────────────────────────────────────────────
/** Initialize the BMO channel router. */
export function initBmoChannelRouter() {
    log.info(`BMO channel router initialized (current: ${getChannel()})`);
}
// ── Testing ──────────────────────────────────────────────────
export function _resetForTesting() {
    _telegramAdapter = null;
    _voicePendingCallback = null;
    _responseHook = null;
}
//# sourceMappingURL=channel-router.js.map