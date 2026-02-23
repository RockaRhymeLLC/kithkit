/**
 * BMO JMAP Email Adapter — Fastmail email via JMAP protocol.
 *
 * Implements the kithkit ChannelAdapter interface for email sending/receiving
 * via the JMAP API with bearer token auth.
 *
 * Also provides BMO EmailProvider methods for richer email operations
 * (search, mark-as-read, attachments) used by email triage tasks.
 *
 * Ported from CC4Me v1 daemon/src/comms/adapters/email/jmap-provider.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
  ChannelCapabilities,
} from '../../../../comms/adapter.js';
import { readKeychain } from '../../../../core/keychain.js';
import { createLogger } from '../../../../core/logger.js';

const log = createLogger('bmo-email-jmap');

// ── Types ────────────────────────────────────────────────────

export interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  isRead: boolean;
  preview?: string;
  body?: string;
}

export interface SendOptions {
  cc?: string[];
  bcc?: string[];
  attachments?: string[];
}

// ── Credentials ──────────────────────────────────────────────

interface JmapCredentials {
  token: string | null;
  email: string | null;
}

async function getJmapCredentials(): Promise<JmapCredentials> {
  const [token, email] = await Promise.all([
    readKeychain('credential-fastmail-token'),
    readKeychain('credential-fastmail-email'),
  ]);
  return { token, email };
}

// ── JMAP Session ─────────────────────────────────────────────

interface JmapSession {
  apiUrl: string;
  uploadUrl: string;
  primaryAccounts: Record<string, string>;
}

// ── BmoJmapAdapter ───────────────────────────────────────────

/**
 * BMO JMAP email adapter — ChannelAdapter + EmailProvider.
 *
 * Usage:
 *   const adapter = new BmoJmapAdapter();
 *   if (await adapter.isConfigured()) {
 *     registerAdapter(adapter);
 *   }
 */
export class BmoJmapAdapter implements ChannelAdapter {
  readonly name = 'email-jmap';

  private _creds: JmapCredentials | null = null;
  private _inboundBuffer: InboundMessage[] = [];

  /** Check if JMAP credentials are available in Keychain. */
  async isConfigured(): Promise<boolean> {
    const creds = await this._getCreds();
    return !!(creds.token);
  }

  // ── ChannelAdapter interface ─────────────────────────────

  /** Send an email. Requires metadata.to and metadata.subject. */
  async send(message: OutboundMessage): Promise<boolean> {
    try {
      const to = message.metadata?.to as string;
      const subject = message.metadata?.subject as string ?? 'Message from BMO';
      if (!to) {
        log.error('Cannot send email: no recipient (metadata.to)');
        return false;
      }
      await this.sendEmail(to, subject, message.text, message.metadata as SendOptions | undefined);
      return true;
    } catch (err) {
      log.error('Email send failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Return buffered inbound messages. */
  async receive(): Promise<InboundMessage[]> {
    const messages = [...this._inboundBuffer];
    this._inboundBuffer = [];
    return messages;
  }

  /** Format message for email. */
  formatMessage(text: string, verbosity: Verbosity): string {
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

  /** JMAP email capabilities. */
  capabilities(): ChannelCapabilities {
    return { markdown: false, images: true, buttons: false, html: true, maxLength: null };
  }

  // ── EmailProvider methods ────────────────────────────────

  /** List inbox messages. */
  async listInbox(limit = 10, unreadOnly = false): Promise<EmailMessage[]> {
    const session = await this._getSession();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;
    const inboxId = await this._getInboxId(session.apiUrl, accountId);

    const filter: Record<string, unknown> = { inMailbox: inboxId };
    if (unreadOnly) filter.notKeyword = '$seen';

    const data = await this._jmapRequest(session.apiUrl, accountId, [
      ['Email/query', {
        accountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, 'a'],
      ['Email/get', {
        accountId,
        properties: ['id', 'subject', 'from', 'receivedAt', 'keywords', 'preview'],
        '#ids': { resultOf: 'a', name: 'Email/query', path: '/ids/*' },
      }, 'b'],
    ]);

    const queryResult = data.methodResponses[0]![1] as { ids: string[] };
    if (!queryResult.ids?.length) return [];

    const emails = (data.methodResponses[1]![1] as { list: Array<{
      id: string;
      subject: string;
      from: Array<{ email: string }>;
      receivedAt: string;
      keywords: Record<string, boolean>;
      preview?: string;
    }> }).list;

    return (emails ?? []).map(e => ({
      id: e.id,
      subject: e.subject,
      from: e.from?.[0]?.email ?? 'unknown',
      date: e.receivedAt,
      isRead: !!e.keywords?.['$seen'],
      preview: e.preview,
    }));
  }

  /** Read a specific email by ID. */
  async readEmail(id: string): Promise<EmailMessage | null> {
    const session = await this._getSession();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;

    const data = await this._jmapRequest(session.apiUrl, accountId, [
      ['Email/get', {
        accountId,
        ids: [id],
        properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'keywords', 'textBody', 'bodyValues'],
        fetchTextBodyValues: true,
      }, 'a'],
    ]);

    const e = (data.methodResponses[0]![1] as { list: Array<{
      id: string;
      subject: string;
      from: Array<{ email: string }>;
      receivedAt: string;
      keywords: Record<string, boolean>;
      textBody: Array<{ partId: string }>;
      bodyValues: Record<string, { value: string }>;
    }> }).list[0];

    if (!e) return null;

    const bodyPart = e.textBody?.[0];
    const body = bodyPart && e.bodyValues?.[bodyPart.partId]
      ? e.bodyValues[bodyPart.partId]!.value
      : '';

    return {
      id: e.id,
      subject: e.subject,
      from: e.from?.[0]?.email ?? 'unknown',
      date: e.receivedAt,
      isRead: !!e.keywords?.['$seen'],
      body,
    };
  }

  /** Mark an email as read. */
  async markAsRead(id: string): Promise<void> {
    const session = await this._getSession();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;

    await this._jmapRequest(session.apiUrl, accountId, [
      ['Email/set', {
        accountId,
        update: { [id]: { 'keywords/$seen': true } },
      }, 'a'],
    ]);
  }

  /** Search emails by query. */
  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    const session = await this._getSession();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;

    const data = await this._jmapRequest(session.apiUrl, accountId, [
      ['Email/query', {
        accountId,
        filter: { text: query },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      }, 'a'],
      ['Email/get', {
        accountId,
        properties: ['id', 'subject', 'from', 'receivedAt', 'preview'],
        '#ids': { resultOf: 'a', name: 'Email/query', path: '/ids/*' },
      }, 'b'],
    ]);

    const emails = (data.methodResponses[1]![1] as { list: Array<{
      id: string;
      subject: string;
      from: Array<{ email: string }>;
      receivedAt: string;
      preview?: string;
    }> }).list;

    return (emails ?? []).map(e => ({
      id: e.id,
      subject: e.subject,
      from: e.from?.[0]?.email ?? 'unknown',
      date: e.receivedAt,
      isRead: true,
      preview: e.preview,
    }));
  }

  /** Send an email via JMAP. */
  async sendEmail(to: string, subject: string, body: string, options?: SendOptions): Promise<void> {
    const session = await this._getSession();
    const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail']!;
    const creds = await this._getCreds();

    // Get drafts/sent mailbox IDs and identity
    const setupData = await this._jmapRequest(session.apiUrl, accountId, [
      ['Mailbox/query', { accountId, filter: { role: 'drafts' } }, 'drafts'],
      ['Mailbox/query', { accountId, filter: { role: 'sent' } }, 'sent'],
      ['Identity/get', { accountId }, 'id'],
    ]);

    const draftsId = (setupData.methodResponses[0]![1] as { ids: string[] }).ids[0]!;
    const sentId = (setupData.methodResponses[1]![1] as { ids: string[] }).ids[0]!;
    const identities = (setupData.methodResponses[2]![1] as { list: Array<{ id: string; email: string }> }).list;
    const identity = identities.find(i => i.email === creds.email) ?? identities[0]!;

    // Upload attachments
    const attachments: Array<{ blobId: string; type: string; name: string; size: number }> = [];
    if (options?.attachments?.length) {
      for (const filePath of options.attachments) {
        if (!fs.existsSync(filePath)) throw new Error(`Attachment not found: ${filePath}`);
        const fileData = fs.readFileSync(filePath);
        const url = session.uploadUrl.replace('{accountId}', accountId);
        const uploadResp = await fetch(url, {
          method: 'POST',
          headers: { ...this._getHeaders(), 'Content-Type': 'application/octet-stream' },
          body: fileData,
        });
        if (!uploadResp.ok) throw new Error(`Upload failed: ${uploadResp.status}`);
        const blob = await uploadResp.json() as { blobId: string };
        attachments.push({
          blobId: blob.blobId,
          type: getMimeType(filePath),
          name: path.basename(filePath),
          size: fs.statSync(filePath).size,
        });
      }
    }

    // Build draft email
    const draft: Record<string, unknown> = {
      mailboxIds: { [draftsId]: true },
      from: [{ email: creds.email }],
      to: [{ email: to }],
      subject,
      keywords: { '$draft': true },
      textBody: [{ partId: 'body', type: 'text/plain' }],
      bodyValues: { body: { value: body } },
    };

    if (options?.cc?.length) draft.cc = options.cc.map(addr => ({ email: addr }));
    if (options?.bcc?.length) draft.bcc = options.bcc.map(addr => ({ email: addr }));
    if (attachments.length) draft.attachments = attachments;

    // Build move-to-sent patch
    const updatePatch: Record<string, unknown> = {};
    updatePatch[`mailboxIds/${draftsId}`] = null;
    updatePatch[`mailboxIds/${sentId}`] = true;
    updatePatch['keywords/$draft'] = null;

    // Create + submit in one request
    const sendData = await this._jmapRequest(session.apiUrl, accountId, [
      ['Email/set', { accountId, create: { draft } }, '0'],
      ['EmailSubmission/set', {
        accountId,
        create: { sendIt: { emailId: '#draft', identityId: identity.id } },
        onSuccessUpdateEmail: { '#sendIt': updatePatch },
      }, '1'],
    ]);

    const emailResult = sendData.methodResponses[0]![1] as { created?: { draft?: unknown } };
    if (!emailResult.created?.draft) {
      throw new Error('JMAP email creation failed');
    }

    const submitResult = sendData.methodResponses[1]![1] as { created?: { sendIt?: unknown } };
    if (!submitResult.created?.sendIt) {
      throw new Error('JMAP email submission failed');
    }

    log.info(`Email sent via JMAP to ${to}`);
  }

  // ── Internals ─────────────────────────────────────────────

  private async _getCreds(): Promise<JmapCredentials> {
    if (!this._creds) this._creds = await getJmapCredentials();
    return this._creds;
  }

  private _getHeaders(): Record<string, string> {
    // Use cached creds — callers must ensure _getCreds() was called first
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this._creds!.token}`,
    };
  }

  private async _getSession(): Promise<JmapSession> {
    await this._getCreds();
    const response = await fetch('https://api.fastmail.com/.well-known/jmap', {
      method: 'GET',
      headers: this._getHeaders(),
    });
    if (!response.ok) throw new Error(`JMAP session failed: ${response.status}`);
    return response.json() as Promise<JmapSession>;
  }

  private async _jmapRequest(apiUrl: string, _accountId: string, methodCalls: unknown[][]): Promise<{ methodResponses: unknown[][] }> {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission'],
        methodCalls,
      }),
    });
    if (!response.ok) throw new Error(`JMAP request failed: ${response.status}`);
    return response.json() as Promise<{ methodResponses: unknown[][] }>;
  }

  private async _getInboxId(apiUrl: string, accountId: string): Promise<string> {
    const data = await this._jmapRequest(apiUrl, accountId, [
      ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'a'],
    ]);
    return (data.methodResponses[0]![1] as { ids: string[] }).ids[0]!;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.md': 'text/markdown',
  };
  return types[ext] ?? 'application/octet-stream';
}
