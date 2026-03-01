/**
 * BMO Comms Extensions — initializes all BMO communication adapters.
 *
 * Called from the BMO extension entry point (extensions/index.ts) during onInit().
 * Registers Telegram and email adapters with the kithkit channel-router.
 */
import { createLogger } from '../../core/logger.js';
import { createBmoTelegramAdapter } from './adapters/telegram.js';
import { BmoGraphAdapter } from './adapters/email/graph-provider.js';
import { BmoHimalayaAdapter } from './adapters/email/himalaya-provider.js';
import { initBmoChannelRouter, registerTelegramAdapter, registerEmailAdapter, } from './channel-router.js';
const log = createLogger('bmo-comms');
// ── State ────────────────────────────────────────────────────
let _telegramAdapter = null;
let _graphAdapter = null;
let _himalayaAdapters = [];
// ── Init ─────────────────────────────────────────────────────
/**
 * Initialize all BMO communication adapters.
 * Called during BMO extension onInit().
 */
export async function initComms(config) {
    // Initialize BMO channel router
    initBmoChannelRouter();
    // Telegram
    if (config.channels?.telegram?.enabled) {
        try {
            _telegramAdapter = await createBmoTelegramAdapter();
            registerTelegramAdapter(_telegramAdapter);
            log.info('Telegram adapter enabled');
        }
        catch (err) {
            log.error('Failed to initialize Telegram adapter', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // Email providers
    if (config.channels?.email?.enabled && config.channels.email.providers) {
        for (const providerConfig of config.channels.email.providers) {
            try {
                switch (providerConfig.type) {
                    case 'graph': {
                        _graphAdapter = new BmoGraphAdapter();
                        if (await _graphAdapter.isConfigured()) {
                            registerEmailAdapter(_graphAdapter);
                            log.info('Graph email adapter enabled');
                        }
                        else {
                            log.warn('Graph email adapter not configured (missing credentials)');
                            _graphAdapter = null;
                        }
                        break;
                    }
                    case 'himalaya': {
                        const adapter = new BmoHimalayaAdapter(providerConfig.account ?? 'gmail');
                        if (adapter.isConfigured()) {
                            registerEmailAdapter(adapter);
                            _himalayaAdapters.push(adapter);
                            log.info(`Himalaya email adapter enabled: ${adapter.name}`);
                        }
                        else {
                            log.warn(`Himalaya adapter ${providerConfig.account ?? 'gmail'} not configured`);
                        }
                        break;
                    }
                    default:
                        log.warn(`Unknown email provider type: ${providerConfig.type}`);
                }
            }
            catch (err) {
                log.error(`Failed to initialize email provider: ${providerConfig.type}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    log.info('BMO comms initialized', {
        telegram: !!_telegramAdapter,
        emailAdapters: (_graphAdapter ? 1 : 0) + _himalayaAdapters.length,
    });
}
// ── Route Handlers ───────────────────────────────────────────
/**
 * Create the Telegram webhook route handler.
 * Replaces the stub from s-m23.
 */
export function createTelegramRouteHandler() {
    return async (req, res, _pathname, _searchParams) => {
        if (req.method !== 'POST')
            return false;
        if (!_telegramAdapter) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Telegram not enabled' }));
            return true;
        }
        try {
            const body = await readBody(req);
            const update = JSON.parse(body);
            await _telegramAdapter.handleUpdate(update);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        }
        catch (err) {
            log.error('Telegram webhook error', { error: err instanceof Error ? err.message : String(err) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, error: 'Processing error' }));
        }
        return true;
    };
}
/**
 * Create the Siri Shortcut route handler.
 */
export function createShortcutRouteHandler() {
    return async (req, res, _pathname, _searchParams) => {
        if (req.method !== 'POST')
            return false;
        if (!_telegramAdapter) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Telegram not enabled' }));
            return true;
        }
        try {
            const body = await readBody(req);
            const data = JSON.parse(body);
            const result = await _telegramAdapter.handleShortcut(data);
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
        }
        catch (err) {
            log.error('Shortcut handler error', { error: err instanceof Error ? err.message : String(err) });
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
        }
        return true;
    };
}
// ── Accessors ────────────────────────────────────────────────
/** Get the Telegram adapter (for direct access from other BMO modules). */
export function getTelegramAdapter() {
    return _telegramAdapter;
}
/** Get the Graph email adapter. */
export function getGraphAdapter() {
    return _graphAdapter;
}
/** Get all Himalaya adapters. */
export function getHimalayaAdapters() {
    return [..._himalayaAdapters];
}
// ── Helpers ──────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}
// ── Shutdown ─────────────────────────────────────────────────
/** Clean up comms resources. */
export function shutdownComms() {
    _telegramAdapter = null;
    _graphAdapter = null;
    _himalayaAdapters = [];
    log.info('BMO comms shut down');
}
// ── Testing ──────────────────────────────────────────────────
export function _resetForTesting() {
    _telegramAdapter = null;
    _graphAdapter = null;
    _himalayaAdapters = [];
}
//# sourceMappingURL=index.js.map