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
import fs from 'node:fs';
import path from 'node:path';
import { readKeychain } from '../../../core/keychain.js';
import { resolveProjectPath, loadConfig } from '../../../core/config.js';
import { sessionExists, startSession, injectText } from '../../../core/session-bridge.js';
import { classifySender, checkRateLimit, registerTier } from '../../../core/access-control.js';
import { getDatabase } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';
const log = createLogger('bmo-telegram');
const MEDIA_DIR_REL = '.claude/state/telegram-media';
const REPLY_CHAT_ID_REL = '.claude/state/reply-chat-id.txt';
const CHANNEL_FILE_REL = '.claude/state/channel.txt';
// ── Keychain helpers ─────────────────────────────────────────
let _botToken = null;
let _chatId = null;
let _shortcutToken = null;
async function getBotToken() {
    if (_botToken)
        return _botToken;
    _botToken = await readKeychain('credential-telegram-bot-token');
    return _botToken;
}
async function getChatId() {
    if (_chatId)
        return _chatId;
    _chatId = await readKeychain('credential-telegram-chat-id');
    return _chatId;
}
async function getShortcutToken() {
    if (_shortcutToken)
        return _shortcutToken;
    _shortcutToken = await readKeychain('credential-shortcut-auth-token');
    return _shortcutToken;
}
function getChannel() {
    try {
        const content = fs.readFileSync(resolveProjectPath(CHANNEL_FILE_REL), 'utf8').trim();
        if (['terminal', 'telegram', 'telegram-verbose', 'silent', 'voice'].includes(content)) {
            return content;
        }
    }
    catch { /* missing file */ }
    return 'terminal';
}
function setChannel(channel) {
    fs.writeFileSync(resolveProjectPath(CHANNEL_FILE_REL), channel + '\n');
}
// ── Reply chat ID persistence ────────────────────────────────
let _replyChatId = null;
function loadReplyChatId() {
    try {
        return fs.readFileSync(resolveProjectPath(REPLY_CHAT_ID_REL), 'utf-8').trim() || null;
    }
    catch {
        return null;
    }
}
function persistReplyChatId(chatId) {
    try {
        fs.writeFileSync(resolveProjectPath(REPLY_CHAT_ID_REL), chatId + '\n', 'utf-8');
    }
    catch (err) {
        log.error('Failed to persist reply chat ID', { error: err instanceof Error ? err.message : String(err) });
    }
}
// ── Webhook deduplication ────────────────────────────────────
const DEDUP_MAX_SIZE = 1000;
const _recentUpdateIds = new Set();
function isDuplicateUpdate(updateId) {
    if (_recentUpdateIds.has(updateId))
        return true;
    _recentUpdateIds.add(updateId);
    if (_recentUpdateIds.size > DEDUP_MAX_SIZE) {
        const oldest = _recentUpdateIds.values().next().value;
        _recentUpdateIds.delete(oldest);
    }
    return false;
}
// ── Message context extraction ───────────────────────────────
function getOwnBotId(token) {
    return token.split(':')[0] ?? null;
}
function extractMessageContext(msg, botToken) {
    const chatType = msg.chat.type ?? 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const replyChatId = msg.chat.id.toString();
    const senderId = isGroup && msg.from?.id ? msg.from.id.toString() : replyChatId;
    const ownBotId = getOwnBotId(botToken);
    const isSelf = msg.from?.is_bot === true && msg.from?.id?.toString() === ownBotId;
    return { senderId, replyChatId, isSelf, firstName: msg.from?.first_name ?? 'User' };
}
// ── Typing indicator ─────────────────────────────────────────
let _typingInterval = null;
let _typingCooldown = false;
function sendTypingIndicator(token, chatId) {
    if (_typingCooldown)
        return;
    const data = JSON.stringify({ chat_id: chatId, action: 'typing' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendChatAction`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    req.on('error', () => { });
    req.write(data);
    req.end();
}
function startTypingLoop(token, chatId) {
    stopTypingLoop();
    _typingCooldown = false;
    sendTypingIndicator(token, chatId);
    _typingInterval = setInterval(() => sendTypingIndicator(token, chatId), 4000);
    setTimeout(() => stopTypingLoop(), 180_000);
}
function stopTypingLoop() {
    if (_typingInterval) {
        clearInterval(_typingInterval);
        _typingInterval = null;
        _typingCooldown = true;
        setTimeout(() => { _typingCooldown = false; }, 2000);
    }
}
// ── File download ────────────────────────────────────────────
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk.toString(); });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}
async function downloadTelegramFile(token, fileId, filename) {
    try {
        const rawFileInfo = await httpsGet(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        const fileInfo = JSON.parse(rawFileInfo);
        if (!fileInfo.ok || !fileInfo.result?.file_path)
            return null;
        const mediaDir = resolveProjectPath(MEDIA_DIR_REL);
        fs.mkdirSync(mediaDir, { recursive: true });
        const localPath = path.join(mediaDir, filename);
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(localPath);
            https.get(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`, (res) => {
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', (e) => { fs.unlink(localPath, () => { }); reject(e); });
        });
        log.info(`Downloaded media: ${filename}`);
        return localPath;
    }
    catch (err) {
        log.error(`Failed to download file: ${fileId}`, { error: err instanceof Error ? err.message : String(err) });
        return null;
    }
}
// ── Send message ─────────────────────────────────────────────
async function telegramSend(text, chatId) {
    const token = await getBotToken();
    const targetChatId = chatId ?? _replyChatId ?? await getChatId();
    if (!token || !targetChatId) {
        log.error('Cannot send: missing bot token or chat ID');
        return false;
    }
    const truncated = text.length > 4000 ? text.substring(0, 4000) + '...' : text;
    const data = JSON.stringify({ chat_id: targetChatId, text: truncated });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${token}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => {
                try {
                    const result = JSON.parse(body);
                    if (result.ok) {
                        log.debug(`Sent to Telegram (${truncated.length} chars)`);
                        resolve(true);
                    }
                    else {
                        log.error('Telegram send failed', { response: body });
                        resolve(false);
                    }
                }
                catch {
                    log.error('Telegram send: unparseable response');
                    resolve(false);
                }
                stopTypingLoop();
            });
        });
        req.on('error', (err) => {
            log.error('Telegram send error', { error: err.message });
            resolve(false);
        });
        req.write(data);
        req.end();
    });
}
// ── Send photo ───────────────────────────────────────────────
export async function sendPhoto(photoBuffer, chatId, caption) {
    const token = await getBotToken();
    const targetChatId = chatId ?? _replyChatId ?? await getChatId();
    if (!token || !targetChatId) {
        log.error('Cannot send photo: missing bot token or chat ID');
        return;
    }
    const boundary = `----FormBoundary${Date.now()}`;
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${targetChatId}\r\n`));
    if (caption) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`));
    parts.push(photoBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendPhoto`,
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk.toString(); });
        res.on('end', () => {
            try {
                const result = JSON.parse(responseBody);
                if (!result.ok)
                    log.error('Telegram sendPhoto failed', { response: responseBody });
            }
            catch {
                log.error('Telegram sendPhoto: unparseable response');
            }
        });
    });
    req.on('error', (err) => { log.error('Telegram sendPhoto error', { error: err.message }); });
    req.write(body);
    req.end();
}
// ── Inbound message buffer ───────────────────────────────────
let _inboundBuffer = [];
// ── Session wakeup + injection ───────────────────────────────
let _sessionStarting = false;
let _pendingMessages = [];
async function injectWithSessionWakeup(text, senderId, replyChatId, firstName, isThirdParty) {
    const token = await getBotToken();
    if (!sessionExists()) {
        log.info('No session found, waking up...');
        setChannel('telegram');
        if (token)
            startTypingLoop(token, replyChatId);
        _pendingMessages.push({ text, senderId, replyChatId, firstName });
        if (!_sessionStarting) {
            _sessionStarting = true;
            const started = startSession();
            if (started) {
                await new Promise(resolve => setTimeout(resolve, 12_000));
            }
            _sessionStarting = false;
            for (const msg of _pendingMessages) {
                doInject(msg.text, msg.firstName, isThirdParty);
            }
            _pendingMessages = [];
        }
        return;
    }
    if (_sessionStarting) {
        _pendingMessages.push({ text, senderId, replyChatId, firstName });
        return;
    }
    if (token)
        startTypingLoop(token, replyChatId);
    doInject(text, firstName, isThirdParty);
}
function doInject(text, firstName, isThirdParty) {
    const prefix = isThirdParty ? '[3rdParty][Telegram]' : '[Telegram]';
    const formatted = `${prefix} ${firstName}: ${text}`;
    const ok = injectText(formatted, { pressEnter: true });
    if (ok) {
        log.info(`Injected ${isThirdParty ? '3rd-party ' : ''}message from ${firstName} (${text.substring(0, 50)}...)`);
    }
}
// ── Access control integration ───────────────────────────────
/** BMO 3rd-party approval state */
const _approvalQueues = new Map();
let _pendingApprovalContext = null;
/**
 * Register BMO's extended sender classification.
 * Adds 'approved' and 'pending' tiers using the safe-senders/3rd-party-senders files.
 */
function registerBmoTiers() {
    // Load safe senders from contacts DB (contacts with telegram_id and tier:safe tag)
    // Also load 3rd-party state from JSON file if it exists
    const thirdParty = loadJsonFile('.claude/state/3rd-party-senders.json') ?? [];
    const safeIds = new Set();
    const ownerIds = new Set();
    try {
        const db = getDatabase();
        const rows = db.prepare(
            "SELECT telegram_id, role, tags FROM contacts WHERE telegram_id IS NOT NULL AND telegram_id != ''"
        ).all();
        for (const row of rows) {
            let tags = [];
            try { tags = JSON.parse(row.tags); } catch { /* ignore */ }
            if (tags.includes('tier:safe') || row.role === 'owner') {
                safeIds.add(row.telegram_id);
            }
            if (row.role === 'owner') {
                ownerIds.add(row.telegram_id);
            }
        }
        log.info(`Loaded ${safeIds.size} safe Telegram senders from contacts DB`);
    } catch (err) {
        log.warn('Failed to load contacts from DB, falling back to file', {
            error: err instanceof Error ? err.message : String(err)
        });
        // Fallback: try the old safe-senders.json
        const safeSenders = loadJsonFile('.claude/state/safe-senders.json') ?? [];
        for (const s of safeSenders) {
            if (s.telegram_id) safeIds.add(s.telegram_id);
        }
    }
    const approvedIds = new Set();
    const pendingIds = new Set();
    for (const tp of thirdParty) {
        if (tp.id) {
            if (tp.approved_by) {
                approvedIds.add(tp.id);
            } else {
                pendingIds.add(tp.id);
            }
        }
    }
    registerTier('bmo-telegram', (senderId) => {
        if (safeIds.has(senderId))
            return 'safe';
        if (approvedIds.has(senderId))
            return 'approved';
        if (pendingIds.has(senderId))
            return 'pending';
        return null; // fall through to default
    });
}
function loadJsonFile(relPath) {
    try {
        const fullPath = resolveProjectPath(relPath);
        return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    }
    catch {
        return null;
    }
}
// ── Incoming message processing ──────────────────────────────
async function processIncomingMessage(text, senderId, replyChatId, firstName) {
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
        await injectWithSessionWakeup(text, senderId, replyChatId, firstName, false);
        return;
    }
    if (tier === 'approved') {
        const rateResult = checkRateLimit(senderId);
        if (!rateResult.allowed) {
            await telegramSend("You're sending messages faster than I can process them. Please slow down.", replyChatId);
            return;
        }
        await injectWithSessionWakeup(text, senderId, replyChatId, firstName, true);
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
    await telegramSend(`New message from unknown sender:\n\nName: ${firstName}\nTelegram ID: ${senderId}\nMessage: "${preview}"\n\nReply "approve", "approve for 1 week", "deny", or "block".`, primaryChatId);
}
function handleApprovalResponse(text, _senderId) {
    if (!_pendingApprovalContext)
        return;
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
    }
    else if (lower.startsWith('deny') || lower.startsWith('reject') || lower === 'no') {
        telegramSend(`Denied ${ctx.senderName}.`);
        telegramSend(`Sorry, I'm not able to help with that right now.`, ctx.senderReplyChatId);
        _approvalQueues.delete(ctx.senderChatId);
        log.info(`Primary denied sender: ${ctx.senderName} (${ctx.senderChatId})`);
    }
    else if (lower.startsWith('block')) {
        telegramSend(`Blocked ${ctx.senderName}.`);
        _approvalQueues.delete(ctx.senderChatId);
        log.info(`Primary blocked sender: ${ctx.senderName} (${ctx.senderChatId})`);
    }
}
// ── Reaction handling ────────────────────────────────────────
function handleReaction(reaction) {
    const userId = reaction.user?.id?.toString();
    const firstName = reaction.user?.first_name ?? 'Someone';
    if (userId) {
        const tier = classifySender(userId);
        if (tier === 'blocked')
            return;
    }
    const oldEmojis = new Set(reaction.old_reaction.filter(r => r.emoji).map(r => r.emoji));
    const newEmojis = new Set(reaction.new_reaction.filter(r => r.emoji).map(r => r.emoji));
    const added = [...newEmojis].filter(e => !oldEmojis.has(e));
    const removed = [...oldEmojis].filter(e => !newEmojis.has(e));
    if (added.length === 0 && removed.length === 0)
        return;
    const parts = [];
    if (added.length > 0)
        parts.push(`reacted ${added.join(' ')}`);
    if (removed.length > 0)
        parts.push(`removed ${removed.join(' ')}`);
    const chatId = reaction.chat.id.toString();
    _replyChatId = chatId;
    persistReplyChatId(chatId);
    if (sessionExists()) {
        injectText(`[Telegram] ${firstName} ${parts.join(', ')} on a message`);
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
export class BmoTelegramAdapter {
    name = 'telegram';
    /** Initialize adapter — load keychain creds, restore state. */
    async init() {
        // Pre-load keychain values
        await getBotToken();
        await getChatId();
        // Restore persisted reply chat ID
        _replyChatId = loadReplyChatId();
        if (_replyChatId)
            log.info(`Restored reply chat ID: ${_replyChatId}`);
        // Register BMO sender tiers
        registerBmoTiers();
        log.info('BMO Telegram adapter initialized');
    }
    /** Send a message via Telegram Bot API. */
    async send(message) {
        const chatId = message.metadata?.chatId;
        return telegramSend(message.text, chatId);
    }
    /** Return buffered inbound messages and clear the buffer. */
    async receive() {
        const messages = [..._inboundBuffer];
        _inboundBuffer = [];
        return messages;
    }
    /** Format a message according to verbosity. */
    formatMessage(text, verbosity) {
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
    capabilities() {
        return { markdown: true, images: true, buttons: true, html: false, maxLength: 4096 };
    }
    /** Process an incoming Telegram webhook update. */
    async handleUpdate(update) {
        if (update.update_id != null && isDuplicateUpdate(update.update_id)) {
            log.debug(`Duplicate update_id ${update.update_id}, skipping`);
            return;
        }
        if (update.message_reaction) {
            handleReaction(update.message_reaction);
            return;
        }
        const msg = update.message;
        if (!msg)
            return;
        const token = await getBotToken();
        if (!token) {
            log.error('No bot token');
            return;
        }
        const ctx = extractMessageContext(msg, token);
        if (ctx.isSelf)
            return;
        _replyChatId = ctx.replyChatId;
        persistReplyChatId(ctx.replyChatId);
        const { senderId, replyChatId, firstName } = ctx;
        // Switch active channel to telegram so outgoing responses route correctly
        setChannel('telegram');
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
            await processIncomingMessage(msg.text, senderId, replyChatId, firstName);
            return;
        }
        // Handle photos
        if (msg.photo && msg.photo.length > 0) {
            const photo = msg.photo[msg.photo.length - 1];
            const filename = `photo_${Date.now()}.jpg`;
            const localPath = await downloadTelegramFile(token, photo.file_id, filename);
            if (localPath) {
                const caption = msg.caption ?? '';
                const text = caption ? `[Sent a photo: ${localPath}] ${caption}` : `[Sent a photo: ${localPath}]`;
                await processIncomingMessage(text, senderId, replyChatId, firstName);
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
                await processIncomingMessage(text, senderId, replyChatId, firstName);
            }
            return;
        }
        // Voice/audio — download and transcribe (STT integration deferred to s-m27)
        if (msg.voice || msg.audio) {
            const fileId = msg.voice?.file_id ?? msg.audio.file_id;
            const ext = msg.voice ? 'ogg' : (msg.audio.file_name?.split('.').pop() ?? 'mp3');
            const filename = `voice_${Date.now()}.${ext}`;
            const localPath = await downloadTelegramFile(token, fileId, filename);
            if (localPath) {
                // STT transcription is wired in s-m27 (voice extensions) — for now, notify user
                await telegramSend('(Voice message received — voice transcription not yet wired in v2. Please send as text.)', replyChatId);
            }
        }
    }
    /** Handle Siri Shortcut endpoint. */
    async handleShortcut(data) {
        const expectedToken = await getShortcutToken();
        if (!expectedToken)
            return { status: 500, body: { error: 'Auth not configured' } };
        if (!data.token || data.token !== expectedToken)
            return { status: 401, body: { error: 'Unauthorized' } };
        if (!data.text?.trim())
            return { status: 400, body: { error: 'No message provided' } };
        const chatId = await getChatId() ?? '';
        const trimmed = data.text.trim();
        await telegramSend(`User (via Siri): ${trimmed}`, chatId);
        const token = await getBotToken();
        if (token)
            startTypingLoop(token, chatId);
        if (!sessionExists()) {
            setChannel('telegram');
            _pendingMessages.push({ text: trimmed, senderId: chatId, replyChatId: chatId, firstName: 'User' });
            if (!_sessionStarting) {
                _sessionStarting = true;
                startSession();
                await new Promise(resolve => setTimeout(resolve, 12_000));
                _sessionStarting = false;
                for (const msg of _pendingMessages) {
                    doInject(msg.text, msg.firstName, false);
                }
                _pendingMessages = [];
            }
        }
        else {
            doInject(trimmed, 'User', false);
        }
        return { status: 200, body: { ok: true, message: `Delivered to ${loadConfig().agent.name}` } };
    }
    /** Stop typing indicator. */
    stopTyping() {
        stopTypingLoop();
    }
    /** Start typing indicator on the current reply chat. */
    async startTyping() {
        const token = await getBotToken();
        const chatId = _replyChatId ?? await getChatId();
        if (token && chatId)
            startTypingLoop(token, chatId);
    }
    /** Send a message directly (bypasses channel router). */
    async sendDirect(text, chatId) {
        return telegramSend(text, chatId);
    }
}
/**
 * Create and initialize a BMO Telegram adapter.
 */
export async function createBmoTelegramAdapter() {
    const adapter = new BmoTelegramAdapter();
    await adapter.init();
    return adapter;
}
// ── Testing ──────────────────────────────────────────────────
export function _resetForTesting() {
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
//# sourceMappingURL=telegram.js.map