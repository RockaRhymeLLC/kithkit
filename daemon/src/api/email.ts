/**
 * Email Inbox API — exposes JMAP inbox reads via HTTP.
 *
 * Routes:
 *   GET /api/email/inbox?limit=N           — list recent inbox messages
 *   GET /api/email/inbox/search?q=&limit=N — search inbox messages
 *   GET /api/email/inbox/:id               — get full message body
 *
 * The daemon runs as localhost-only, so no additional auth is needed beyond
 * the existing security boundary. Credentials are loaded from keychain by the
 * JMAP provider — this allows the comms agent (non-interactive shell without
 * keychain access) to read email by proxying through the daemon.
 *
 * Error semantics:
 *   503 — JMAP credentials not found in keychain
 *   502 — JMAP provider returned an error
 *   404 — message not found
 */

import type http from 'node:http';
import { JmapAdapter, type EmailMessage } from '../extensions/comms/adapters/email/jmap-provider.js';
import { json, withTimestamp } from './helpers.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('email-api');

// ── Provider interface ────────────────────────────────────────

/**
 * Minimal EmailProvider interface — matches JmapAdapter public methods used
 * by this handler. Exposed for testing (inject mock via setEmailProvider).
 */
export interface EmailProvider {
  isConfigured(): Promise<boolean>;
  listInbox(limit?: number): Promise<EmailMessage[]>;
  readEmail(id: string): Promise<EmailMessage | null>;
  searchEmails(query: string, limit?: number): Promise<EmailMessage[]>;
}

let _provider: EmailProvider | null = null;

/** Override the email provider. Used in tests to inject a mock. */
export function setEmailProvider(provider: EmailProvider | null): void {
  _provider = provider;
}

function getProvider(): EmailProvider {
  return _provider ?? new JmapAdapter();
}

// ── Response shaping ─────────────────────────────────────────

function toInboxItem(m: EmailMessage): Record<string, unknown> {
  return {
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.preview ?? null,
    received_at: m.date,
    is_read: m.isRead,
  };
}

function toFullMessage(m: EmailMessage): Record<string, unknown> {
  return {
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.preview ?? null,
    received_at: m.date,
    is_read: m.isRead,
    body: m.body ?? null,
  };
}

// ── Route handler ─────────────────────────────────────────────

export async function handleEmailRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith('/api/email/')) return false;

  const method = req.method ?? 'GET';
  const provider = getProvider();

  // ── GET /api/email/inbox ────────────────────────────────────
  if (pathname === '/api/email/inbox' && method === 'GET') {
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : 20;

    const configured = await provider.isConfigured();
    if (!configured) {
      json(res, 503, withTimestamp({
        error: 'Email not configured: JMAP credentials missing from keychain (credential-fastmail-api)',
      }));
      return true;
    }

    try {
      const messages = await provider.listInbox(limit);
      json(res, 200, withTimestamp({ data: messages.map(toInboxItem) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('JMAP listInbox failed', { error: msg });
      json(res, 502, withTimestamp({ error: `JMAP provider error: ${msg}` }));
    }
    return true;
  }

  // ── GET /api/email/inbox/search ─────────────────────────────
  if (pathname === '/api/email/inbox/search' && method === 'GET') {
    const q = searchParams.get('q');
    if (!q) {
      json(res, 400, withTimestamp({ error: 'q parameter is required' }));
      return true;
    }

    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 100) : 20;

    const configured = await provider.isConfigured();
    if (!configured) {
      json(res, 503, withTimestamp({
        error: 'Email not configured: JMAP credentials missing from keychain (credential-fastmail-api)',
      }));
      return true;
    }

    try {
      const messages = await provider.searchEmails(q, limit);
      json(res, 200, withTimestamp({ data: messages.map(toInboxItem) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('JMAP searchEmails failed', { error: msg });
      json(res, 502, withTimestamp({ error: `JMAP provider error: ${msg}` }));
    }
    return true;
  }

  // ── GET /api/email/inbox/:id ────────────────────────────────
  const idMatch = pathname.match(/^\/api\/email\/inbox\/([^/]+)$/);
  if (idMatch && method === 'GET') {
    const id = decodeURIComponent(idMatch[1]!);

    const configured = await provider.isConfigured();
    if (!configured) {
      json(res, 503, withTimestamp({
        error: 'Email not configured: JMAP credentials missing from keychain (credential-fastmail-api)',
      }));
      return true;
    }

    try {
      const message = await provider.readEmail(id);
      if (!message) {
        json(res, 404, withTimestamp({ error: 'Message not found' }));
        return true;
      }
      json(res, 200, withTimestamp(toFullMessage(message)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('JMAP readEmail failed', { error: msg, id });
      json(res, 502, withTimestamp({ error: `JMAP provider error: ${msg}` }));
    }
    return true;
  }

  return false;
}
