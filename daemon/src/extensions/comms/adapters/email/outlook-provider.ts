/**
 * BMO Outlook Email Adapter — wraps the Python IMAP script for Outlook accounts.
 *
 * Implements the kithkit ChannelAdapter interface for email via the
 * outlook-imap.py script (OAuth2 XOAUTH2 with automatic token refresh via MSAL).
 *
 * Also provides BMO EmailProvider methods for richer email operations
 * (search, mark-as-read, move) used by email triage tasks.
 *
 * Ported from CC4Me v1 daemon/src/comms/adapters/email/outlook-provider.ts
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type {
  ChannelAdapter,
  OutboundMessage,
  InboundMessage,
  Verbosity,
  ChannelCapabilities,
} from '../../../../comms/adapter.js';
import { createLogger } from '../../../../core/logger.js';
import { getProjectDir } from '../../../../core/config.js';

const execFileAsync = promisify(execFile);
const log = createLogger('bmo-email-outlook');

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

interface OutlookMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  isRead: boolean;
  body?: string;
}

// ── BmoOutlookAdapter ────────────────────────────────────────

/**
 * BMO Outlook email adapter — ChannelAdapter + EmailProvider.
 *
 * Usage:
 *   const adapter = new BmoOutlookAdapter();
 *   if (adapter.isConfigured()) {
 *     registerAdapter(adapter);
 *   }
 */
export class BmoOutlookAdapter implements ChannelAdapter {
  readonly name = 'email-outlook';

  private _inboundBuffer: InboundMessage[] = [];

  private get _scriptPath(): string {
    return path.join(getProjectDir(), 'scripts/email/outlook-imap.py');
  }

  /** Check if Outlook OAuth2 credentials are available in Keychain. */
  isConfigured(): boolean {
    try {
      const result = execFileSync('security', [
        'find-generic-password', '-s', 'himalaya-cli',
        '-a', 'outlook-imap-oauth2-access-token', '-w',
      ], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
      return !!result.trim();
    } catch { return false; }
  }

  // ── ChannelAdapter interface ─────────────────────────────

  /** Send an email via Outlook. Requires metadata.to and metadata.subject. */
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

  /** Format message for email (plain text). */
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

  /** Outlook email capabilities (plain text via IMAP/SMTP). */
  capabilities(): ChannelCapabilities {
    return { markdown: false, images: false, buttons: false, html: false, maxLength: null };
  }

  // ── EmailProvider methods ────────────────────────────────

  /** List inbox messages. */
  async listInbox(limit = 10, unreadOnly = false): Promise<EmailMessage[]> {
    const cmd = unreadOnly ? 'unread' : 'inbox';
    const raw = await this._run([cmd]);
    return this._parseMessages(raw).slice(0, limit).map(m => this._toEmailMessage(m));
  }

  /** Read a specific email by ID. */
  async readEmail(id: string): Promise<EmailMessage | null> {
    try {
      const raw = await this._run(['read', id]);
      const msg: OutlookMessage = JSON.parse(raw);
      return this._toEmailMessage(msg);
    } catch (err) {
      log.error(`Failed to read message ${id}`, { error: (err as Error).message });
      return null;
    }
  }

  /** Mark an email as read. */
  async markAsRead(id: string): Promise<void> {
    await this._run(['mark-read', id]);
  }

  /** Move an email to a folder. */
  async moveEmail(id: string, folder: string): Promise<void> {
    await this._run(['move', id, folder]);
  }

  /** Search emails by subject or sender. */
  async searchEmails(query: string, limit = 10): Promise<EmailMessage[]> {
    const raw = await this._run(['search', query]);
    return this._parseMessages(raw).slice(0, limit).map(m => this._toEmailMessage(m));
  }

  /** Send an email via Outlook SMTP (via Python script). */
  async sendEmail(to: string, subject: string, body: string, _options?: SendOptions): Promise<void> {
    await this._run(['send', to, subject, body]);
    log.info(`Email sent via Outlook to ${to}`);
  }

  // ── Internals ─────────────────────────────────────────────

  private async _run(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync('python3', [this._scriptPath, '--json', ...args], {
        encoding: 'utf8',
        timeout: 30000,
      });
      if (stderr && !stderr.includes('Token auto-refreshed')) {
        log.debug('outlook-imap.py stderr', { stderr: stderr.trim() });
      }
      return stdout.trim();
    } catch (err: unknown) {
      const stderr = (err as { stderr?: string }).stderr || '';
      throw new Error(`outlook ${args[0]} failed: ${stderr || (err as Error).message}`);
    }
  }

  private _parseMessages(raw: string): OutlookMessage[] {
    if (!raw) return [];
    return JSON.parse(raw);
  }

  private _toEmailMessage(msg: OutlookMessage): EmailMessage {
    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from,
      date: msg.date,
      isRead: msg.isRead,
      ...(msg.body ? { body: msg.body } : {}),
    };
  }
}
