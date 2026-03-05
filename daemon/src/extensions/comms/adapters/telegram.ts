/**
 * BMO Telegram Adapter — implements kithkit ChannelAdapter for Telegram.
 *
 * Handles:
 * - Outbound message delivery via Telegram Bot API
 * - Inbound webhook processing (text, photos, documents, voice, reactions)
 * - Access control (safe/approved/pending/blocked sender tiers)
 * - Typing indicator management
 * - Session wakeup (starts tmux session on first message)
 * - Browser hand-off command interception
 * - Siri Shortcut endpoint
 * - Webhook deduplication
 *
 * Ported from CC4Me v1 daemon/src/comms/adapters/telegram.ts
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
  ChannelCapabilities,
} from '../../../comms/adapter.js';
import { readKeychain } from '../../../core/keychain.js';
import { resolveProjectPath, loadConfig } from '../../../core/config.js';
import { commsSessionExists, startSession, injectToComms, COMMS_SESSION } from '../../../core/session-bridge.js';
import { classifySender, checkRateLimit, registerTier } from '../../../core/access-control.js';
import { createLogger } from '../../../core/logger.js';
import { updateLastActiveChannel } from '../channel-router.js';
import { markdownToTelegramHtml, hasMarkdownPatterns, hasHtmlTags } from './telegram-format.js';

const log = createLogger('bmo-telegram');

const MEDIA_DIR_REL = '.claude/state/telegram-media';
const REPLY_CHAT_ID_REL = '.claude/state/reply-chat-id.txt';
const CHANNEL_FILE_REL = '.claude/state/channel.txt';

// ── Keychain helpers ─────────────────────────────────────────

let _botToken: string | null = null;
let _chatId: string | null = null;
let _shortcutToken: string | null = null;

async function getBotToken(): Promise<string | null> {
  if (_botToken) return _botToken;
  _botToken = await readKeychain('credential-telegram-bot');
  return _botToken;
}

async function getChatId(): Promise<string | null> {
  if (_chatId) return _chatId;
  _chatId = await readKeychain('credential-telegram-chat-id');
  return _chatId;
}

async function getShortcutToken(): Promise<string | null> {
  if (_shortcutToken) return _shortcutToken;
  _shortcutToken = await readKeychain('credential-shortcut-auth');
  return _shortcutToken;
}

// ── Telegram types ──────────────────────────────────────────

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  message_reaction?: MessageReactionUpdated;
}

interface TelegramMessage {
  chat: { id: number; type?: 'private' | 'group' | 'supergroup' | 'channel' };
  from?: { id?: number; first_name?: string; is_bot?: boolean };
  text?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string; file_name?: string };
  voice?: { file_id: string; duration?: number; mime_type?: string };
  audio?: { file_id: string; duration?: number; file_name?: string; mime_type?: string };
  caption?: string;
}

interface ReactionType {
  type: 'emoji' | 'custom_emoji' | 'paid';
  emoji?: string;
  custom_emoji_id?: string;
}

interface MessageReactionUpdated {
  chat: { id: number; type?: string };
  message_id: number;
  date: number;
  user?: { id?: number; first_name?: string; is_bot?: boolean };
  actor_chat?: { id: number };
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

interface MessageContext {
  senderId: string;
  replyChatId: string;
  isSelf: boolean;
  firstName: string;
  chatType: string;
}

// ── Channel file management ─────────────────────────────────

type Channel = 'terminal' | 'telegram' | 'telegram-verbose' | 'silent' | 'voice';

function getChannel(): Channel {
  try {
    const content = fs.readFileSync(resolveProjectPath(CHANNEL_FILE_REL), 'utf8').trim();
    if (['terminal', 'telegram', 'telegram-verbose', 'silent', 'voice'].includes(content)) {
      return content as Channel;
    }
  } catch { /* missing file */ }
  return 'terminal';
}

function setChannel(channel: Channel): void {
  fs.writeFileSync(resolveProjectPath(CHANNEL_FILE_REL), channel + '\n');
}

// ── Reply chat ID persistence ────────────────────────────────

let _replyChatId: string | null = null;

function loadReplyChatId(): string | null {
  try {
    return fs.readFileSync(resolveProjectPath(REPLY_CHAT_ID_REL), 'utf-8').trim() || null;
  } catch { return null; }
}

function persistReplyChatId(chatId: string): void {
  try {
    fs.writeFileSync(resolveProjectPath(REPLY_CHAT_ID_REL), chatId + '\n', 'utf-8');
  } catch (err) {
    log.error('Failed to persist reply chat ID', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Webhook deduplication ────────────────────────────────────

const DEDUP_MAX_SIZE = 1000;
const _recentUpdateIds = new Set<number>();

function isDuplicateUpdate(updateId: number): boolean {
  if (_recentUpdateIds.has(updateId)) return true;
  _recentUpdateIds.add(updateId);
  if (_recentUpdateIds.size > DEDUP_MAX_SIZE) {
    const oldest = _recentUpdateIds.values().next().value!;
    _recentUpdateIds.delete(oldest);
  }
  return false;
}

// ── Message context extraction ───────────────────────────────

function getOwnBotId(token: string): string | null {
  return token.split(':')[0] ?? null;
}

function extractMessageContext(msg: TelegramMessage, botToken: string): MessageContext {
  const chatType = msg.chat.type ?? 'private';
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const replyChatId = msg.chat.id.toString();
  const senderId = isGroup && msg.from?.id ? msg.from.id.toString() : replyChatId;
  const ownBotId = getOwnBotId(botToken);
  const isSelf = msg.from?.is_bot === true && msg.from?.id?.toString() === ownBotId;

  return { senderId, replyChatId, isSelf, firstName: msg.from?.first_name ?? 'User', chatType };
}

// ── Typing indicator ─────────────────────────────────────────

let _typingInterval: ReturnType<typeof setInterval> | null = null;
let _typingCooldown = false;

function sendTypingIndicator(token: string, chatId: string): void {
  if (_typingCooldown) return;
  const data = JSON.stringify({ chat_id: chatId, action: 'typing' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendChatAction`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  });
  req.on('error', () => {});
  req.write(data);
  req.end();
}

function startTypingLoop(token: string, chatId: string): void {
  stopTypingLoop();
  _typingCooldown = false;
  sendTypingIndicator(token, chatId);
  _typingInterval = setInterval(() => sendTypingIndicator(token, chatId), 4000);
  setTimeout(() => stopTypingLoop(), 180_000);
}

function stopTypingLoop(): void {
  if (_typingInterval) {
    clearInterval(_typingInterval);
    _typingInterval = null;
    _typingCooldown = true;
    setTimeout(() => { _typingCooldown = false; }, 2000);
  }
}

// ── File download ────────────────────────────────────────────

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function downloadTelegramFile(token: string, fileId: string, filename: string): Promise<string | null> {
  try {
    const rawFileInfo = await httpsGet(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileInfo = JSON.parse(rawFileInfo);
    if (!fileInfo.ok || !fileInfo.result?.file_path) return null;

    const mediaDir = resolveProjectPath(MEDIA_DIR_REL);
    fs.mkdirSync(mediaDir, { recursive: true });
    const localPath = path.join(mediaDir, filename);

    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(localPath);
      https.get(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (e) => { fs.unlink(localPath, () => {}); reject(e); });
    });

    log.info(`Downloaded media: ${filename}`);
    return localPath;
  } catch (err) {
    log.error(`Failed to download file: ${fileId}`, { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── Retry helper ─────────────────────────────────────────────

/**
 * Retry a Telegram API call with exponential backoff.
 *
 * - Attempt 1: immediate
 * - On failure: wait retryAfterMs (429) or baseDelayMs * attempt (other errors)
 * - Max 3 attempts total
 * - Retries on: network error, timeout, HTTP 429, HTTP 5xx
 * - Does NOT retry on: HTTP 400, 401, 403
 */
async function withRetry<T>(
  fn: () => Promise<T | false>,
  maxAttempts = 3,
  baseDelayMs = 1000,
  retryAfterMs?: number,
): Promise<T | false> {
  let lastResult: T | false = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await fn();
    if (lastResult !== false) return lastResult;

    if (attempt < maxAttempts) {
      const delayMs = retryAfterMs != null ? retryAfterMs : baseDelayMs * attempt;
      log.warn(`Telegram request failed, retrying (attempt ${attempt}/${maxAttempts}) in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      // Reset retryAfterMs after first use — subsequent attempts use exponential backoff
      retryAfterMs = undefined;
    }
  }

  return lastResult;
}

// ── Send message ─────────────────────────────────────────────

/**
 * Inner send — single attempt. Returns false on failure, or a 429 sentinel
 * so the retry wrapper can honour Telegram's retry_after value.
 */
async function telegramSendOnce(
  text: string,
  token: string,
  data: string,
): Promise<boolean | { retry429: true; retryAfterMs: number }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30_000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const result = JSON.parse(body) as {
            ok: boolean;
            error_code?: number;
            parameters?: { retry_after?: number };
          };
          if (result.ok) {
            log.debug(`Sent to Telegram (${text.length} chars)`);
            stopTypingLoop();
            resolve(true);
          } else if (result.error_code === 429) {
            const retryAfterMs = (result.parameters?.retry_after ?? 5) * 1000;
            log.warn('Telegram 429: rate limited', { retryAfterMs });
            resolve({ retry429: true, retryAfterMs });
          } else if (
            result.error_code != null &&
            (result.error_code === 400 || result.error_code === 401 || result.error_code === 403)
          ) {
            // Non-retriable errors — log and fail permanently
            log.error('Telegram send failed (non-retriable)', { error_code: result.error_code, response: body });
            stopTypingLoop();
            resolve(false);
          } else {
            log.error('Telegram send failed', { response: body });
            stopTypingLoop();
            resolve(false);
          }
        } catch {
          log.error('Telegram send: unparseable response');
          stopTypingLoop();
          resolve(false);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      log.error('Telegram send error', { error: err.message });
      resolve(false);
    });

    req.write(data);
    req.end();
  });
}

async function telegramSend(text: string, chatId?: string): Promise<boolean> {
  const token = await getBotToken();
  const targetChatId = chatId ?? _replyChatId ?? await getChatId();
  if (!token || !targetChatId) {
    log.error('Cannot send: missing bot token or chat ID');
    return false;
  }

  // Strip MarkdownV2 escape sequences (legacy callers may still send them)
  const cleaned = text.replace(/\\([^a-zA-Z0-9\s])/g, '$1');
  const truncated = cleaned.length > 4000 ? cleaned.substring(0, 4000) + '...' : cleaned;

  // Detect formatting: pre-existing HTML tags get parse_mode but skip conversion;
  // markdown patterns get converted to HTML first.
  const alreadyHtml = hasHtmlTags(truncated);
  const hasMarkdown = !alreadyHtml && hasMarkdownPatterns(truncated);
  const formatted = hasMarkdown ? markdownToTelegramHtml(truncated) : truncated;
  const data = JSON.stringify({
    chat_id: targetChatId,
    text: formatted,
    ...(alreadyHtml || hasMarkdown ? { parse_mode: 'HTML' } : {}),
  });

  // Retry with backoff — track retryAfterMs from 429 responses
  let retryAfterMs: number | undefined;
  const result = await withRetry(
    async () => {
      const attempt = await telegramSendOnce(truncated, token, data);
      if (typeof attempt === 'object' && 'retry429' in attempt) {
        retryAfterMs = attempt.retryAfterMs;
        return false;
      }
      return attempt;
    },
    3,
    1000,
    retryAfterMs,
  );

  return result !== false;
}

// ── Send photo ───────────────────────────────────────────────

export async function sendPhoto(photoBuffer: Buffer, chatId?: string, caption?: string): Promise<boolean> {
  const token = await getBotToken();
  const targetChatId = chatId ?? _replyChatId ?? await getChatId();
  if (!token || !targetChatId) {
    log.error('Cannot send photo: missing bot token or chat ID');
    return false;
  }

  const boundary = `----FormBoundary${Date.now()}`;
  const parts: Buffer[] = [];

  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${targetChatId}\r\n`));
  if (caption) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(photoBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise<boolean>((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendPhoto`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 30_000,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on('end', () => {
        try {
          const result = JSON.parse(responseBody) as { ok: boolean };
          if (result.ok) {
            resolve(true);
          } else {
            log.error('Telegram sendPhoto failed', { response: responseBody });
            resolve(false);
          }
        } catch {
          log.error('Telegram sendPhoto: unparseable response');
          resolve(false);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      log.error('Telegram sendPhoto error', { error: err.message });
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send a file (photo buffer) via Telegram with retry on network/429/5xx errors.
 * Returns true on success, false if all attempts fail.
 */
export async function telegramSendFile(photoBuffer: Buffer, chatId?: string, caption?: string): Promise<boolean> {
  const ok = await withRetry(() => sendPhoto(photoBuffer, chatId, caption));
  return ok !== false;
}

// ── Inbound message buffer ───────────────────────────────────

let _inboundBuffer: InboundMessage[] = [];

// ── Session wakeup + injection ───────────────────────────────

let _sessionStarting = false;
let _pendingMessages: Array<{ text: string; senderId: string; replyChatId: string; firstName: string; chatType?: string }> = [];

async function injectWithSessionWakeup(
  text: string, senderId: string, replyChatId: string, firstName: string, isThirdParty: boolean, chatType?: string,
): Promise<void> {
  const token = await getBotToken();

  if (!commsSessionExists()) {
    log.info('No session found, waking up...');
    setChannel('telegram');
    if (token) startTypingLoop(token, replyChatId);
    _pendingMessages.push({ text, senderId, replyChatId, firstName, chatType });

    if (!_sessionStarting) {
      _sessionStarting = true;
      const started = startSession(COMMS_SESSION);
      if (started) {
        await new Promise(resolve => setTimeout(resolve, 12_000));
      }
      _sessionStarting = false;

      for (const msg of _pendingMessages) {
        doInject(msg.text, msg.firstName, isThirdParty, msg.chatType, msg.replyChatId);
      }
      _pendingMessages = [];
    }
    return;
  }

  if (_sessionStarting) {
    _pendingMessages.push({ text, senderId, replyChatId, firstName, chatType });
    return;
  }

  if (token) startTypingLoop(token, replyChatId);
  doInject(text, firstName, isThirdParty, chatType, replyChatId);
}

function doInject(text: string, firstName: string, isThirdParty: boolean, chatType?: string, chatId?: string): void {
  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const channelTag = isGroup ? `Telegram - group:${chatId}` : 'Telegram';
  const prefix = isThirdParty ? `[3rdParty][${channelTag}]` : `[${channelTag}]`;
  const formatted = `${prefix} ${firstName}: ${text}`;
  const ok = injectToComms(formatted, { pressEnter: true });
  if (ok) {
    log.info(`Injected ${isThirdParty ? '3rd-party ' : ''}message from ${firstName} (${text.substring(0, 50)}...)`);
  }
}

// ── Access control integration ───────────────────────────────

/** BMO 3rd-party approval state */
const _approvalQueues: Map<string, Array<{ text: string; firstName: string }>> = new Map();
let _pendingApprovalContext: {
  senderChatId: string;
  senderReplyChatId: string;
  senderName: string;
} | null = null;

/**
 * Register BMO's extended sender classification.
 * Checks config owner/allowed_users first, then safe-senders/3rd-party-senders files.
 */
function registerBmoTiers(): void {
  // Read owner and allowed_users from channels.telegram config
  const rawConfig = loadConfig() as unknown as Record<string, unknown>;
  const channels = rawConfig.channels as Record<string, unknown> | undefined;
  const telegramConfig = channels?.telegram as Record<string, unknown> | undefined;
  const configOwner = telegramConfig?.owner != null ? String(telegramConfig.owner) : null;
  const configAllowed = Array.isArray(telegramConfig?.allowed_users)
    ? (telegramConfig!.allowed_users as unknown[]).map(id => String(id))
    : [];

  const configSafeIds = new Set<string>();
  if (configOwner) configSafeIds.add(configOwner);
  for (const id of configAllowed) configSafeIds.add(id);

  if (configSafeIds.size > 0) {
    log.info('Telegram config safe IDs', { ids: [...configSafeIds] });
  }

  // Load safe-senders.json and 3rd-party-senders.json
  const safeSenders = loadJsonFile<Array<{ telegram_id?: string }>>('.claude/state/safe-senders.json') ?? [];
  const thirdParty = loadJsonFile<Array<{ id?: string; channels?: Record<string, unknown> }>>('.claude/state/3rd-party-senders.json') ?? [];

  const fileSafeIds = new Set<string>();
  for (const s of safeSenders) {
    if (s.telegram_id) fileSafeIds.add(s.telegram_id);
  }

  const approvedIds = new Set<string>();
  const pendingIds = new Set<string>();
  for (const tp of thirdParty) {
    if (tp.id) {
      // Check if approved vs pending based on presence of approval data
      if ((tp as Record<string, unknown>).approved_by) {
        approvedIds.add(tp.id);
      } else {
        pendingIds.add(tp.id);
      }
    }
  }

  registerTier('bmo-telegram', (senderId: string) => {
    if (configSafeIds.has(senderId)) return 'safe';
    if (fileSafeIds.has(senderId)) return 'safe';
    if (approvedIds.has(senderId)) return 'approved';
    if (pendingIds.has(senderId)) return 'pending';
    return null; // fall through to default
  });
}

function loadJsonFile<T>(relPath: string): T | null {
  try {
    const fullPath = resolveProjectPath(relPath);
    return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  } catch { return null; }
}

// ── Incoming message processing ──────────────────────────────

async function processIncomingMessage(text: string, senderId: string, replyChatId: string, firstName: string, chatType?: string): Promise<void> {
  const tier = classifySender(senderId);
  log.debug(`Sender ${firstName} (${senderId}) classified as: ${tier}`);

  if (tier === 'blocked') {
    log.info(`Dropped message from blocked sender: ${firstName} (${senderId})`);
    return;
  }

  if (tier === 'safe') {
    // Check for approval response from primary
    if (_pendingApprovalContext) {
      const primaryChatId = await getChatId();
      if (senderId === primaryChatId) {
        const lower = text.toLowerCase().trim();
        if (lower.startsWith('approve') || lower.startsWith('deny') || lower.startsWith('reject') || lower === 'no' || lower.startsWith('block')) {
          handleApprovalResponse(text, senderId);
          return;
        }
      }
    }

    await injectWithSessionWakeup(text, senderId, replyChatId, firstName, false, chatType);
    return;
  }

  if (tier === 'approved') {
    const rateResult = checkRateLimit(senderId);
    if (!rateResult.allowed) {
      await telegramSend("You're sending messages faster than I can process them. Please slow down.", replyChatId);
      return;
    }
    await injectWithSessionWakeup(text, senderId, replyChatId, firstName, true, chatType);
    return;
  }

  // Unknown sender — trigger approval flow
  const primaryChatId = await getChatId();
  if (!primaryChatId) {
    log.error('Cannot notify primary: no chat ID configured');
    return;
  }

  await telegramSend("I need to check with my human first — I'll get back to you when I hear from them.", replyChatId);

  const queue = _approvalQueues.get(senderId) ?? [];
  queue.push({ text, firstName });
  _approvalQueues.set(senderId, queue);

  _pendingApprovalContext = { senderChatId: senderId, senderReplyChatId: replyChatId, senderName: firstName };

  const preview = text.length > 200 ? text.substring(0, 200) + '...' : text;
  await telegramSend(
    `New message from unknown sender:\n\nName: ${firstName}\nTelegram ID: ${senderId}\nMessage: "${preview}"\n\nReply "approve", "approve for 1 week", "deny", or "block".`,
    primaryChatId,
  );
}

function handleApprovalResponse(text: string, _senderId: string): void {
  if (!_pendingApprovalContext) return;
  const ctx = _pendingApprovalContext;
  _pendingApprovalContext = null;

  const lower = text.toLowerCase().trim();

  if (lower.startsWith('approve')) {
    const agentName = loadConfig().agent.name;
    telegramSend(`Hi! I'm ${agentName}, a personal assistant. My human just approved you to chat with me.`, ctx.senderReplyChatId);
    telegramSend(`Approved ${ctx.senderName}. Processing their queued messages now.`);

    const queued = _approvalQueues.get(ctx.senderChatId) ?? [];
    _approvalQueues.delete(ctx.senderChatId);
    for (const msg of queued) {
      doInject(msg.text, msg.firstName, true);
    }
    log.info(`Primary approved sender: ${ctx.senderName} (${ctx.senderChatId})`);
  } else if (lower.startsWith('deny') || lower.startsWith('reject') || lower === 'no') {
    telegramSend(`Denied ${ctx.senderName}.`);
    telegramSend(`Sorry, I'm not able to help with that right now.`, ctx.senderReplyChatId);
    _approvalQueues.delete(ctx.senderChatId);
    log.info(`Primary denied sender: ${ctx.senderName} (${ctx.senderChatId})`);
  } else if (lower.startsWith('block')) {
    telegramSend(`Blocked ${ctx.senderName}.`);
    _approvalQueues.delete(ctx.senderChatId);
    log.info(`Primary blocked sender: ${ctx.senderName} (${ctx.senderChatId})`);
  }
}

// ── Reaction handling ────────────────────────────────────────

function handleReaction(reaction: MessageReactionUpdated): void {
  const userId = reaction.user?.id?.toString();
  const firstName = reaction.user?.first_name ?? 'Someone';

  if (userId) {
    const tier = classifySender(userId);
    if (tier === 'blocked') return;
  }

  const oldEmojis = new Set(reaction.old_reaction.filter(r => r.emoji).map(r => r.emoji!));
  const newEmojis = new Set(reaction.new_reaction.filter(r => r.emoji).map(r => r.emoji!));
  const added = [...newEmojis].filter(e => !oldEmojis.has(e));
  const removed = [...oldEmojis].filter(e => !newEmojis.has(e));

  if (added.length === 0 && removed.length === 0) return;

  const parts: string[] = [];
  if (added.length > 0) parts.push(`reacted ${added.join(' ')}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(' ')}`);

  const chatId = reaction.chat.id.toString();
  _replyChatId = chatId;
  persistReplyChatId(chatId);

  if (commsSessionExists()) {
    injectToComms(`[Telegram] ${firstName} ${parts.join(', ')} on a message`);
    log.info(`Reaction from ${firstName}: ${parts.join(', ')}`);
  }
}

// ── BmoTelegramAdapter class ─────────────────────────────────

/**
 * BMO Telegram adapter — implements kithkit ChannelAdapter.
 *
 * Created via `createBmoTelegramAdapter()`. Call `init()` after creation
 * to load keychain credentials and register access control tiers.
 */
export class BmoTelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';

  /** Initialize adapter — load keychain creds, restore state. */
  async init(): Promise<void> {
    // Pre-load keychain values
    await getBotToken();
    await getChatId();

    // Restore persisted reply chat ID
    _replyChatId = loadReplyChatId();
    if (_replyChatId) log.info(`Restored reply chat ID: ${_replyChatId}`);

    // Register BMO sender tiers
    registerBmoTiers();

    log.info('BMO Telegram adapter initialized');
  }

  /** Send a message via Telegram Bot API. */
  async send(message: OutboundMessage): Promise<boolean> {
    const chatId = message.metadata?.chatId as string | undefined;
    return telegramSend(message.text, chatId);
  }

  /** Return buffered inbound messages and clear the buffer. */
  async receive(): Promise<InboundMessage[]> {
    const messages = [..._inboundBuffer];
    _inboundBuffer = [];
    return messages;
  }

  /** Format a message according to verbosity. */
  formatMessage(text: string, verbosity: Verbosity): string {
    switch (verbosity) {
      case 'headlines':
        // First line only, truncated
        return text.split('\n')[0]?.substring(0, 200) ?? text;
      case 'verbose':
        return text;
      case 'normal':
      default:
        // Truncate to Telegram limit
        return text.length > 4000 ? text.substring(0, 4000) + '...' : text;
    }
  }

  /** Report Telegram channel capabilities. */
  capabilities(): ChannelCapabilities {
    return { markdown: true, images: true, buttons: true, html: true, maxLength: 4096 };
  }

  /** Process an incoming Telegram webhook update. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.update_id != null && isDuplicateUpdate(update.update_id)) {
      log.debug(`Duplicate update_id ${update.update_id}, skipping`);
      return;
    }

    if (update.message_reaction) {
      handleReaction(update.message_reaction);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    const token = await getBotToken();
    if (!token) { log.error('No bot token'); return; }

    const ctx = extractMessageContext(msg, token);
    if (ctx.isSelf) return;

    _replyChatId = ctx.replyChatId;
    persistReplyChatId(ctx.replyChatId);

    const { senderId, replyChatId, firstName, chatType } = ctx;

    // Track that Telegram is the last active text channel (for voice response routing)
    updateLastActiveChannel('telegram');

    // Buffer inbound for collectInbound()
    if (msg.text) {
      _inboundBuffer.push({
        from: firstName,
        text: msg.text,
        channel: 'telegram',
        metadata: { senderId, chatId: replyChatId },
        receivedAt: new Date().toISOString(),
      });
    }

    // Handle text
    if (msg.text) {
      await processIncomingMessage(msg.text, senderId, replyChatId, firstName, chatType);
      return;
    }

    // Handle photos
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]!;
      const filename = `photo_${Date.now()}.jpg`;
      const localPath = await downloadTelegramFile(token, photo.file_id, filename);
      if (localPath) {
        const caption = msg.caption ?? '';
        const text = caption ? `[Sent a photo: ${localPath}] ${caption}` : `[Sent a photo: ${localPath}]`;
        await processIncomingMessage(text, senderId, replyChatId, firstName, chatType);
      }
      return;
    }

    // Handle documents
    if (msg.document) {
      const filename = msg.document.file_name ?? `document_${Date.now()}`;
      const localPath = await downloadTelegramFile(token, msg.document.file_id, filename);
      if (localPath) {
        const caption = msg.caption ?? '';
        const text = caption ? `[Sent a document: ${localPath}] ${caption}` : `[Sent a document: ${localPath}]`;
        await processIncomingMessage(text, senderId, replyChatId, firstName, chatType);
      }
      return;
    }

    // Voice/audio — download and transcribe (STT integration deferred to s-m27)
    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id ?? msg.audio!.file_id;
      const ext = msg.voice ? 'ogg' : (msg.audio!.file_name?.split('.').pop() ?? 'mp3');
      const filename = `voice_${Date.now()}.${ext}`;
      const localPath = await downloadTelegramFile(token, fileId, filename);
      if (localPath) {
        // STT transcription is wired in s-m27 (voice extensions) — for now, notify user
        await telegramSend('(Voice message received — voice transcription not yet wired in v2. Please send as text.)', replyChatId);
      }
    }
  }

  /** Handle Siri Shortcut endpoint. */
  async handleShortcut(data: { text?: string; token?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const expectedToken = await getShortcutToken();
    if (!expectedToken) return { status: 500, body: { error: 'Auth not configured' } };
    if (!data.token || data.token !== expectedToken) return { status: 401, body: { error: 'Unauthorized' } };
    if (!data.text?.trim()) return { status: 400, body: { error: 'No message provided' } };

    const chatId = await getChatId() ?? '';
    const trimmed = data.text.trim();

    await telegramSend(`User (via Siri): ${trimmed}`, chatId);

    const token = await getBotToken();
    if (token) startTypingLoop(token, chatId);

    if (!commsSessionExists()) {
      setChannel('telegram');
      _pendingMessages.push({ text: trimmed, senderId: chatId, replyChatId: chatId, firstName: 'User' });
      if (!_sessionStarting) {
        _sessionStarting = true;
        startSession(COMMS_SESSION);
        await new Promise(resolve => setTimeout(resolve, 12_000));
        _sessionStarting = false;
        for (const msg of _pendingMessages) {
          doInject(msg.text, msg.firstName, false);
        }
        _pendingMessages = [];
      }
    } else {
      doInject(trimmed, 'User', false);
    }

    return { status: 200, body: { ok: true, message: `Delivered to ${loadConfig().agent.name}` } };
  }

  /** Stop typing indicator. */
  stopTyping(): void {
    stopTypingLoop();
  }

  /** Start typing indicator on the current reply chat. */
  async startTyping(): Promise<void> {
    const token = await getBotToken();
    const chatId = _replyChatId ?? await getChatId();
    if (token && chatId) startTypingLoop(token, chatId);
  }

  /** Send a message directly (bypasses channel router). */
  async sendDirect(text: string, chatId?: string): Promise<boolean> {
    return telegramSend(text, chatId);
  }

  /**
   * Send a message to the configured home group chat.
   * Group chat ID is read from channels.telegram.home_group_chat_id in config.
   * Returns false if no group chat ID is configured.
   */
  async sendToGroup(text: string): Promise<boolean> {
    const rawConfig = loadConfig() as unknown as Record<string, unknown>;
    const groupChatId = ((rawConfig.channels as Record<string, Record<string, unknown>> | undefined)
      ?.telegram?.home_group_chat_id) as string | undefined;
    if (!groupChatId) {
      log.warn('sendToGroup: channels.telegram.home_group_chat_id not configured');
      return false;
    }
    return telegramSend(text, groupChatId);
  }
}

/**
 * Create and initialize a BMO Telegram adapter.
 */
export async function createBmoTelegramAdapter(): Promise<BmoTelegramAdapter> {
  const adapter = new BmoTelegramAdapter();
  await adapter.init();
  return adapter;
}

// ── Testing ──────────────────────────────────────────────────

export function _resetForTesting(): void {
  _botToken = null;
  _chatId = null;
  _shortcutToken = null;
  _replyChatId = null;
  _recentUpdateIds.clear();
  _inboundBuffer = [];
  _sessionStarting = false;
  _pendingMessages = [];
  _approvalQueues.clear();
  _pendingApprovalContext = null;
  stopTypingLoop();
}
