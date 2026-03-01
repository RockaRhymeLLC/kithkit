/**
 * BMO Access Control — 5-tier file-backed sender classification.
 *
 * Extends the framework's 3-tier access control (safe/unknown/blocked)
 * with BMO's 'approved' and 'denied' tiers, plus channel-aware classification,
 * expiry-aware approval checks, and file-backed persistent state.
 *
 * Classification tiers (checked in order):
 *   1. blocked  → silently drop
 *   2. safe     → full access (from kithkit.config.yaml)
 *   3. approved → inject with [3rdParty] tag (from 3rd-party-senders.json)
 *   4. denied   → re-trigger approval flow
 *   5. unknown  → hold, notify primary, wait for approval
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerTier } from '../core/access-control.js';
import { getProjectDir } from '../core/config.js';
import { getDatabase } from '../core/db.js';
import { createLogger } from '../core/logger.js';
const log = createLogger('bmo-access-control');
// ── State file I/O ──────────────────────────────────────────
function getStateFilePath() {
    return path.join(getProjectDir(), '.claude', 'state', '3rd-party-senders.json');
}
function getSafeSendersPath() {
    return path.join(getProjectDir(), '.claude', 'state', 'safe-senders.json');
}
/**
 * Read state fresh from disk every time (no stale cache).
 */
export function readState() {
    try {
        const raw = fs.readFileSync(getStateFilePath(), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return { approved: [], denied: [], blocked: [], pending: [] };
    }
}
function writeState(state) {
    const filePath = getStateFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}
// ── Safe sender check (channel-aware, contacts DB backed) ───
function isSafeSender(id, channel) {
    try {
        const db = getDatabase();
        if (channel === 'telegram') {
            const row = db.prepare(
                "SELECT id, role, tags FROM contacts WHERE telegram_id = ?"
            ).get(id);
            if (!row) return false;
            let tags = [];
            try { tags = JSON.parse(row.tags); } catch { /* ignore */ }
            return tags.includes('tier:safe') || row.role === 'owner';
        }
        if (channel === 'email') {
            // Email field can contain comma-separated addresses
            const rows = db.prepare(
                "SELECT id, role, tags, email FROM contacts WHERE email IS NOT NULL AND email != ''"
            ).all();
            for (const row of rows) {
                const emails = row.email.split(',').map(e => e.trim().toLowerCase());
                if (emails.includes(id.toLowerCase())) {
                    let tags = [];
                    try { tags = JSON.parse(row.tags); } catch { /* ignore */ }
                    if (tags.includes('tier:safe') || row.role === 'owner') return true;
                }
            }
            return false;
        }
        return false;
    }
    catch (err) {
        // Fallback to file-based check if DB unavailable
        log.warn('isSafeSender: DB lookup failed, falling back to file', {
            error: err instanceof Error ? err.message : String(err)
        });
        try {
            const raw = fs.readFileSync(getSafeSendersPath(), 'utf8');
            const data = JSON.parse(raw);
            if (channel === 'telegram') {
                return (data.telegram?.users ?? []).includes(id);
            }
            if (channel === 'email') {
                return (data.email?.addresses ?? []).includes(id);
            }
            return false;
        }
        catch {
            return false;
        }
    }
}
// ── Channel-aware classification ────────────────────────────
/**
 * Classify a sender into one of the five BMO tiers.
 * This is the full channel-aware classifier — used internally and
 * also registered with the framework via registerTier().
 */
export function classifyBmoSender(id, channel) {
    const state = readState();
    // 1. Blocked — check first (highest priority)
    if (state.blocked.some(s => s.id === id && s.channel === channel)) {
        return 'blocked';
    }
    // 2. Safe sender (from safe-senders.json, channel-aware)
    if (isSafeSender(id, channel)) {
        return 'safe';
    }
    // 3. Approved 3rd party (with expiry check)
    const approved = state.approved.find(s => s.id === id && s.channel === channel);
    if (approved) {
        if (approved.expires && new Date(approved.expires) < new Date()) {
            return 'unknown'; // expired — triggers re-approval
        }
        return 'approved';
    }
    // 4. Denied (recently)
    if (state.denied.some(s => s.id === id && s.channel === channel)) {
        return 'denied';
    }
    // 5. Unknown
    return 'unknown';
}
// ── CRUD operations ─────────────────────────────────────────
export function addApproved(sender) {
    const state = readState();
    state.denied = state.denied.filter(s => !(s.id === sender.id && s.channel === sender.channel));
    state.pending = state.pending.filter(s => !(s.id === sender.id && s.channel === sender.channel));
    state.approved = state.approved.filter(s => !(s.id === sender.id && s.channel === sender.channel));
    state.approved.push({ ...sender, approved_date: new Date().toISOString() });
    writeState(state);
    log.info(`Added approved sender: ${sender.name} (${sender.id}) on ${sender.channel}`);
}
export function addDenied(id, channel, name, reason) {
    const state = readState();
    state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
    const existing = state.denied.find(s => s.id === id && s.channel === channel);
    if (existing) {
        existing.denial_count += 1;
        existing.denied_date = new Date().toISOString();
        existing.reason = reason;
    }
    else {
        state.denied.push({ id, channel, name, denied_date: new Date().toISOString(), denial_count: 1, reason });
    }
    writeState(state);
    log.info(`Denied sender: ${name} (${id}) on ${channel} — reason: ${reason}`);
}
export function addBlocked(id, channel, name, blockedBy, reason) {
    const state = readState();
    state.denied = state.denied.filter(s => !(s.id === id && s.channel === channel));
    state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
    state.approved = state.approved.filter(s => !(s.id === id && s.channel === channel));
    if (!state.blocked.some(s => s.id === id && s.channel === channel)) {
        state.blocked.push({ id, channel, name, blocked_date: new Date().toISOString(), blocked_by: blockedBy, reason });
    }
    writeState(state);
    log.info(`Blocked sender: ${name} (${id}) on ${channel} — by: ${blockedBy}, reason: ${reason}`);
}
export function addPending(id, channel, name, message) {
    const state = readState();
    if (state.pending.some(s => s.id === id && s.channel === channel))
        return;
    state.pending.push({ id, channel, name, requested_date: new Date().toISOString(), message });
    writeState(state);
    log.info(`Added pending sender: ${name} (${id}) on ${channel}`);
}
export function removeSender(id, channel) {
    const state = readState();
    state.approved = state.approved.filter(s => !(s.id === id && s.channel === channel));
    state.denied = state.denied.filter(s => !(s.id === id && s.channel === channel));
    state.blocked = state.blocked.filter(s => !(s.id === id && s.channel === channel));
    state.pending = state.pending.filter(s => !(s.id === id && s.channel === channel));
    writeState(state);
    log.info(`Removed sender ${id} from all lists on ${channel}`);
}
export function unblockSender(id, channel) {
    const state = readState();
    state.blocked = state.blocked.filter(s => !(s.id === id && s.channel === channel));
    writeState(state);
    log.info(`Unblocked sender ${id} on ${channel}`);
}
export function getDenialCount(id, channel) {
    const state = readState();
    return state.denied.find(s => s.id === id && s.channel === channel)?.denial_count ?? 0;
}
export function getPending(id, channel) {
    return readState().pending.find(s => s.id === id && s.channel === channel);
}
export function isPending(id, channel) {
    return getPending(id, channel) !== undefined;
}
// ── Rate limiting (channel-aware) ───────────────────────────
const _incomingWindows = new Map();
const _outgoingBuckets = new Map();
export function checkIncomingRate(senderId, channel, maxPerMinute = 30) {
    const key = `${channel}:${senderId}`;
    const now = Date.now();
    let timestamps = _incomingWindows.get(key) ?? [];
    timestamps = timestamps.filter(t => now - t < 60_000);
    if (timestamps.length >= maxPerMinute) {
        _incomingWindows.set(key, timestamps);
        return false;
    }
    timestamps.push(now);
    _incomingWindows.set(key, timestamps);
    return true;
}
export function checkOutgoingRate(recipientId, channel, maxPerMinute = 20) {
    const key = `${channel}:${recipientId}`;
    const now = Date.now();
    let bucket = _outgoingBuckets.get(key);
    if (!bucket) {
        bucket = { tokens: maxPerMinute, lastRefill: now };
        _outgoingBuckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(maxPerMinute, bucket.tokens + (elapsed / 60_000) * maxPerMinute);
    bucket.lastRefill = now;
    if (bucket.tokens < 1)
        return false;
    bucket.tokens -= 1;
    return true;
}
// ── Framework Integration ───────────────────────────────────
/**
 * Register BMO's 5-tier classifier with the kithkit framework.
 * The framework calls registered classifiers before its own defaults.
 * We use a single classifier that handles all BMO tiers.
 *
 * Note: The framework classifier takes a single senderId string.
 * For channel-aware classification, the Telegram adapter calls
 * classifyBmoSender() directly. This framework hook catches
 * any sender checks that go through the framework's classifySender().
 */
export function initBmoAccessControl() {
    registerTier('bmo-extended', (senderId) => {
        // Parse channel from senderId if encoded (e.g., "telegram:12345")
        const colonIdx = senderId.indexOf(':');
        if (colonIdx > 0) {
            const channel = senderId.slice(0, colonIdx);
            const id = senderId.slice(colonIdx + 1);
            return classifyBmoSender(id, channel);
        }
        // No channel prefix — return null to let the framework handle it
        return null;
    });
    log.info('BMO access control initialized (5-tier, channel-aware)');
}
// ── Testing ─────────────────────────────────────────────────
export function _resetForTesting() {
    _incomingWindows.clear();
    _outgoingBuckets.clear();
}
//# sourceMappingURL=access-control.js.map