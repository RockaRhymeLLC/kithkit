/**
 * BMO Graph Email Adapter — M365 email via Microsoft Graph API.
 *
 * Implements the kithkit ChannelAdapter interface for email sending/receiving
 * via Graph API with client credentials OAuth2.
 *
 * Also implements the BMO EmailProvider interface for richer email operations
 * (search, mark-as-read, attachments) used by email triage tasks.
 *
 * Ported from CC4Me v1 daemon/src/comms/adapters/email/graph-provider.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readKeychain } from '../../../../core/keychain.js';
import { createLogger } from '../../../../core/logger.js';
const log = createLogger('bmo-email-graph');
async function getAzureCredentials() {
    const [clientId, tenantId, clientSecret, userEmail] = await Promise.all([
        readKeychain('credential-azure-client-id'),
        readKeychain('credential-azure-tenant-id'),
        readKeychain('credential-azure-secret-value'),
        readKeychain('credential-azure-user-email'),
    ]);
    return { clientId, tenantId, clientSecret, userEmail };
}
// ── BmoGraphAdapter ──────────────────────────────────────────
/**
 * BMO Graph email adapter — ChannelAdapter + EmailProvider.
 *
 * Usage:
 *   const adapter = new BmoGraphAdapter();
 *   if (await adapter.isConfigured()) {
 *     registerAdapter(adapter);
 *   }
 */
export class BmoGraphAdapter {
    name = 'email-graph';
    _tokenCache = null;
    _creds = null;
    _inboundBuffer = [];
    /** Check if Graph API credentials are available in Keychain. */
    async isConfigured() {
        const creds = await this._getCreds();
        return !!(creds.clientId && creds.tenantId && creds.clientSecret && creds.userEmail);
    }
    // ── ChannelAdapter interface ─────────────────────────────
    /** Send an email. Requires metadata.to and metadata.subject. */
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
    /** Format message for email. */
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
    /** Email channel capabilities. */
    capabilities() {
        return { markdown: false, images: true, buttons: false, html: true, maxLength: null };
    }
    // ── EmailProvider methods ────────────────────────────────
    /** List inbox messages. */
    async listInbox(limit = 10, unreadOnly = false) {
        let endpoint = `${await this._userPath()}/messages?$top=${limit}&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc`;
        if (unreadOnly)
            endpoint += `&$filter=isRead eq false`;
        const data = await this._graphRequest(endpoint);
        return (data?.value ?? []).map(e => ({
            id: e.id,
            subject: e.subject,
            from: e.from?.emailAddress?.address ?? 'unknown',
            date: e.receivedDateTime,
            isRead: e.isRead,
        }));
    }
    /** Read a specific email by ID. */
    async readEmail(id) {
        const e = await this._graphRequest(`${await this._userPath()}/messages/${id}?$select=id,subject,from,receivedDateTime,body,isRead`);
        if (!e)
            return null;
        let body = '';
        if (e.body?.content) {
            body = e.body.contentType === 'html'
                ? e.body.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
                : e.body.content;
        }
        return { id: e.id, subject: e.subject, from: e.from?.emailAddress?.address ?? 'unknown', date: e.receivedDateTime, isRead: e.isRead, body };
    }
    /** Mark an email as read. */
    async markAsRead(id) {
        await this._graphRequest(`${await this._userPath()}/messages/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ isRead: true }),
        });
    }
    /** Search emails by query. */
    async searchEmails(query, limit = 10) {
        const endpoint = `${await this._userPath()}/messages?$top=${limit}&$search="${encodeURIComponent(query)}"&$select=id,subject,from,receivedDateTime,bodyPreview`;
        const data = await this._graphRequest(endpoint);
        return (data?.value ?? []).map(e => ({
            id: e.id, subject: e.subject,
            from: e.from?.emailAddress?.address ?? 'unknown',
            date: e.receivedDateTime, isRead: true, preview: e.bodyPreview,
        }));
    }
    /** Send an email via Graph API. */
    async sendEmail(to, subject, body, options) {
        const message = {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: to } }],
        };
        if (options?.cc?.length) {
            message.ccRecipients = options.cc.map(addr => ({ emailAddress: { address: addr } }));
        }
        if (options?.bcc?.length) {
            message.bccRecipients = options.bcc.map(addr => ({ emailAddress: { address: addr } }));
        }
        if (options?.attachments?.length) {
            const attachments = [];
            for (const filePath of options.attachments) {
                if (!fs.existsSync(filePath))
                    throw new Error(`Attachment not found: ${filePath}`);
                const fileData = fs.readFileSync(filePath);
                attachments.push({
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name: path.basename(filePath),
                    contentType: getMimeType(filePath),
                    contentBytes: fileData.toString('base64'),
                });
            }
            message.attachments = attachments;
        }
        await this._graphRequest(`${await this._userPath()}/sendMail`, {
            method: 'POST',
            body: JSON.stringify({ message }),
        });
        log.info(`Email sent via Graph to ${to}`);
    }
    // ── Internals ─────────────────────────────────────────────
    async _getCreds() {
        if (!this._creds)
            this._creds = await getAzureCredentials();
        return this._creds;
    }
    async _getToken() {
        if (this._tokenCache && Date.now() < this._tokenCache.expiresAt) {
            return this._tokenCache.token;
        }
        const creds = await this._getCreds();
        const response = await fetch(`https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=${encodeURIComponent(creds.clientId)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${encodeURIComponent(creds.clientSecret)}&grant_type=client_credentials`,
        });
        if (!response.ok)
            throw new Error(`Token request failed: ${response.status}`);
        const data = await response.json();
        this._tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
        return data.access_token;
    }
    async _graphRequest(endpoint, options = {}) {
        const token = await this._getToken();
        const url = endpoint.startsWith('http') ? endpoint : `https://graph.microsoft.com/v1.0${endpoint}`;
        const response = await fetch(url, {
            ...options,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(`Graph API ${response.status}: ${err.error?.message ?? response.statusText}`);
        }
        if (response.status === 204 || response.status === 202)
            return null;
        const text = await response.text();
        if (!text)
            return null;
        return JSON.parse(text);
    }
    async _userPath() {
        const creds = await this._getCreds();
        return `/users/${encodeURIComponent(creds.userEmail)}`;
    }
}
// ── Helpers ──────────────────────────────────────────────────
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const types = {
        '.pdf': 'application/pdf',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
        '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.md': 'text/markdown',
    };
    return types[ext] ?? 'application/octet-stream';
}
//# sourceMappingURL=graph-provider.js.map