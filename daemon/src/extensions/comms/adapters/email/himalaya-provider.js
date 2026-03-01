/**
 * BMO Himalaya Email Adapter — wraps the himalaya CLI for IMAP accounts.
 *
 * Implements the kithkit ChannelAdapter interface for email via himalaya CLI.
 * Also provides BMO EmailProvider methods for richer email operations.
 *
 * Supports Gmail (IMAP via app password), Yahoo, and other IMAP providers
 * configured in himalaya.
 *
 * Ported from CC4Me v1 daemon/src/comms/adapters/email/himalaya-provider.ts
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../../../core/logger.js';
const execFileAsync = promisify(execFile);
const log = createLogger('bmo-email-himalaya');
const HIMALAYA_BIN = '/opt/homebrew/bin/himalaya';
// ── BmoHimalayaAdapter ───────────────────────────────────────
/**
 * BMO Himalaya email adapter — ChannelAdapter + EmailProvider.
 *
 * Usage:
 *   const adapter = new BmoHimalayaAdapter('gmail');
 *   if (adapter.isConfigured()) {
 *     registerAdapter(adapter);
 *   }
 */
export class BmoHimalayaAdapter {
    name;
    account;
    _inboundBuffer = [];
    constructor(account = 'gmail') {
        this.account = account;
        this.name = `email-himalaya-${account}`;
    }
    /** Check if himalaya is installed and the account is configured. */
    isConfigured() {
        try {
            execFileSync(HIMALAYA_BIN, ['account', 'list'], {
                encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
            });
            return true;
        }
        catch {
            return false;
        }
    }
    // ── ChannelAdapter interface ─────────────────────────────
    /** Send an email via himalaya. Requires metadata.to and metadata.subject. */
    async send(message) {
        try {
            const to = message.metadata?.to;
            const subject = message.metadata?.subject ?? 'Message from BMO';
            if (!to) {
                log.error('Cannot send email: no recipient (metadata.to)');
                return false;
            }
            await this.sendEmail(to, subject, message.text, message.metadata);
            return true;
        }
        catch (err) {
            log.error('Email send failed', { error: err instanceof Error ? err.message : String(err) });
            return false;
        }
    }
    /** Return buffered inbound messages. */
    async receive() {
        const messages = [...this._inboundBuffer];
        this._inboundBuffer = [];
        return messages;
    }
    /** Format message for email (plain text). */
    formatMessage(text, verbosity) {
        switch (verbosity) {
            case 'headlines':
                return text.split('\n')[0]?.substring(0, 200) ?? text;
            case 'verbose':
                return text;
            case 'normal':
            default:
                return text;
        }
    }
    /** Himalaya email capabilities (plain text). */
    capabilities() {
        return { markdown: false, images: false, buttons: false, html: false, maxLength: null };
    }
    // ── EmailProvider methods ────────────────────────────────
    /** List inbox envelopes. */
    async listInbox(limit = 10, unreadOnly = false) {
        const args = ['envelope', 'list', '-a', this.account, '--page-size', String(limit)];
        if (unreadOnly)
            args.push('not', 'flag', 'seen');
        const raw = await this._run(args);
        return this._parseEnvelopes(raw).map(e => this._envelopeToMessage(e));
    }
    /** Read a specific email body. */
    async readEmail(id) {
        try {
            const body = await this._run(['message', 'read', '-a', this.account, id]);
            const bodyText = typeof body === 'string' ? body : JSON.parse(body);
            return { id, subject: '', from: '', date: '', isRead: true, body: bodyText };
        }
        catch (err) {
            log.error(`Failed to read message ${id}`, { error: err.message });
            return null;
        }
    }
    /** Mark an email as read (add Seen flag). */
    async markAsRead(id) {
        await this._run(['flag', 'add', '-a', this.account, id, 'Seen'], { json: false });
    }
    /** Move an email to a folder. */
    async moveEmail(id, folder) {
        await this._run(['message', 'move', '-a', this.account, folder, '--', id], { json: false });
    }
    /** Search emails by subject or sender. */
    async searchEmails(query, limit = 10) {
        const args = [
            'envelope', 'list', '-a', this.account,
            '--page-size', String(limit),
            'subject', query, 'or', 'from', query,
        ];
        const raw = await this._run(args);
        return this._parseEnvelopes(raw).map(e => this._envelopeToMessage(e));
    }
    /** Send an email via himalaya template + send. */
    async sendEmail(to, subject, body, options) {
        const headers = ['-H', `To:${to}`, '-H', `Subject:${subject}`];
        if (options?.cc) {
            for (const cc of options.cc)
                headers.push('-H', `Cc:${cc}`);
        }
        if (options?.bcc) {
            for (const bcc of options.bcc)
                headers.push('-H', `Bcc:${bcc}`);
        }
        const template = await this._run(['template', 'write', '-a', this.account, ...headers, body], { json: false });
        await this._run(['message', 'send', '-a', this.account], { json: false, input: template });
        log.info(`Email sent via ${this.name}`, { to, subject });
    }
    // ── Internals ─────────────────────────────────────────────
    async _run(args, opts = {}) {
        const { json = true, input } = opts;
        const fullArgs = json ? ['-o', 'json', ...args] : args;
        try {
            const { stdout } = await execFileAsync(HIMALAYA_BIN, fullArgs, {
                encoding: 'utf8', timeout: 30000, ...(input ? { input } : {}),
            });
            return stdout.split('\n').filter(l => !l.includes(' WARN ')).join('\n').trim();
        }
        catch (err) {
            const stderr = err.stderr || '';
            throw new Error(`himalaya ${args[0]} failed: ${stderr || err.message}`);
        }
    }
    _parseEnvelopes(raw) {
        if (!raw)
            return [];
        return JSON.parse(raw);
    }
    _envelopeToMessage(env) {
        return {
            id: env.id,
            subject: env.subject,
            from: env.from?.name ? `${env.from.name} <${env.from.addr}>` : (env.from?.addr || 'unknown'),
            date: env.date,
            isRead: env.flags?.includes('Seen') ?? false,
        };
    }
}
//# sourceMappingURL=himalaya-provider.js.map