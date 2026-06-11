/**
 * Send API — HTTP endpoint for outbound message delivery via channel router.
 *
 * POST /api/send      — Deliver a text message through configured channels.
 * POST /api/send-file — Deliver a file (document/image) via Telegram.
 */

import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { routeMessage, listAdapters } from '../comms/channel-router.js';
import { sendMessage } from '../agents/message-router.js';
import { createLogger } from '../core/logger.js';
import { query } from '../core/db.js';
import { json, withTimestamp, parseBody } from './helpers.js';
import { verifyToken } from '../auth/agent-tokens.js';

const log = createLogger('api-send');

// ── Injectable seam for telegramSendFile (testability) ───────
// In production this is null and the lazy import is used.
// Tests inject a mock via _setTelegramSendFileForTesting to avoid
// real Telegram API calls and to intercept the call for assertions.
type TelegramSendFileFn = (
  filePath: string,
  fileName?: string,
  caption?: string,
  chatId?: string,
) => Promise<boolean>;

let _telegramSendFileOverride: TelegramSendFileFn | null = null;

/** For testing only — inject a mock for telegramSendFile. Pass null to restore. */
export function _setTelegramSendFileForTesting(fn: TelegramSendFileFn | null): void {
  _telegramSendFileOverride = fn;
}

// ── Recipient resolution ─────────────────────────────────────

interface ContactRow {
  id: number;
  name: string;
  telegram_id: string | null;
}

/**
 * Resolve a recipient name to a Telegram chat ID via the contacts table.
 * Returns { chatId } on success, { error } on failure.
 * Matching is case-insensitive: exact match first, then partial (LIKE %name%).
 */
function resolveRecipient(name: string): { chatId: string } | { error: string } {
  // Try exact match first (case-insensitive)
  let contacts = query<ContactRow>(
    'SELECT id, name, telegram_id FROM contacts WHERE LOWER(name) = LOWER(?) LIMIT 2',
    name,
  );

  // Fall back to partial match
  if (contacts.length === 0) {
    contacts = query<ContactRow>(
      'SELECT id, name, telegram_id FROM contacts WHERE name LIKE ? LIMIT 5',
      `%${name}%`,
    );
  }

  if (contacts.length === 0) {
    return { error: `No contact found matching "${name}"` };
  }

  // If multiple matches, check for ambiguity
  if (contacts.length > 1) {
    // If exactly one has a telegram_id, use it
    const withTelegram = contacts.filter(c => c.telegram_id);
    if (withTelegram.length === 1) {
      return { chatId: withTelegram[0].telegram_id! };
    }
    const names = contacts.map(c => c.name).join(', ');
    return { error: `Ambiguous recipient "${name}" — matches: ${names}. Be more specific.` };
  }

  const contact = contacts[0];
  if (!contact.telegram_id) {
    return { error: `Contact "${contact.name}" has no telegram_id` };
  }

  return { chatId: contact.telegram_id };
}

// ── Route handler ────────────────────────────────────────────

export async function handleSendRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    if (pathname === '/api/send' && method === 'POST') {
      // ── Role gate ─────────────────────────────────────────────
      // Only the comms agent may deliver messages to human channels.
      // Workers and orchestrators must escalate via /api/messages.
      const rawHeader = req.headers['x-agent-token'];
      const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (!token) {
        json(res, 401, withTimestamp({ error: 'X-Agent-Token header required' }));
        return true;
      }
      const identity = verifyToken(token);
      if (!identity) {
        json(res, 401, withTimestamp({ error: 'Invalid or revoked agent token' }));
        return true;
      }
      // 'comms' = the comms agent; 'daemon' = in-process scheduler tasks.
      // Workers and orchestrators remain blocked: the escalation chain
      // (worker → orchestrator → comms → human) is unchanged.
      if (identity.role !== 'comms' && identity.role !== 'daemon') {
        json(res, 403, withTimestamp({
          error: 'Workers and orchestrators cannot send to human channels. Escalate via /api/messages (worker → orchestrator → comms → human).',
          role: identity.role,
        }));
        return true;
      }

      const body = await parseBody(req);

      if (!body.message || typeof body.message !== 'string') {
        json(res, 400, withTimestamp({ error: 'message is required' }));
        return true;
      }

      // Accept either channels (array) or channel (singular string) — both documented.
      // Previously, a singular 'channel' field was silently ignored causing broadcast to all adapters.
      const channels: string[] | undefined = Array.isArray(body.channels)
        ? body.channels.filter((c: unknown) => typeof c === 'string') as string[]
        : typeof body.channel === 'string'
          ? [body.channel]
          : undefined;

      // Validate requested channels exist — return 400 for unknown channels rather
      // than silently falling through with empty results (addresses kithkit #60).
      if (channels && channels.length > 0) {
        const registered = new Set(listAdapters());
        const unknown = channels.filter(c => !registered.has(c));
        if (unknown.length > 0) {
          json(res, 400, withTimestamp({
            error: `Unknown channel(s): ${unknown.join(', ')}. Registered: ${[...registered].join(', ') || 'none'}`,
          }));
          return true;
        }
      }

      // Merge top-level chat_id into metadata so the Telegram adapter receives it.
      // Explicit metadata.chatId from the caller takes precedence over top-level chat_id.
      const metadata: Record<string, unknown> = {
        ...(body.metadata as Record<string, unknown> | undefined),
      };
      if (typeof body.chat_id === 'string' && !metadata.chatId) {
        metadata.chatId = body.chat_id;
      }

      // Resolve recipient name → telegram_id via contacts table.
      // "to" field triggers contact lookup. Explicit chat_id/metadata.chatId takes precedence.
      if (typeof body.to === 'string' && !metadata.chatId) {
        const resolved = resolveRecipient(body.to as string);
        if ('error' in resolved) {
          json(res, 404, withTimestamp({ error: resolved.error }));
          return true;
        }
        metadata.chatId = resolved.chatId;
        log.info('Resolved recipient', { to: body.to, chatId: resolved.chatId });
      }

      const results = await routeMessage(
        { text: body.message as string, metadata },
        channels,
      );

      // Success = silent (comms already knows it sent). Failure = notify comms.
      const failed = Object.entries(results).filter(([, ok]) => !ok).map(([ch]) => ch);
      const delivered = Object.entries(results).filter(([, ok]) => ok).map(([ch]) => ch);

      if (delivered.length > 0) {
        log.debug('Delivered to channels', { channels: delivered });
      }

      // ── Attachments ────────────────────────────────────────
      // Optional: array of file paths to send alongside the message. For each
      // delivered channel, route to the channel-specific file send and tally
      // per-channel attachments_sent / attachments_failed in the response.
      // Telegram: telegramSendFile per attachment (multipart). Other channels
      // not yet supported via /api/send (use /api/email/send for email).
      const rawAttachments: unknown = body.attachments ?? body.files;
      const attachmentPaths: string[] = Array.isArray(rawAttachments)
        ? rawAttachments.filter((p: unknown): p is string => typeof p === 'string')
        : [];
      const attachResults: Record<string, { sent: string[]; failed: string[] }> = {};
      if (attachmentPaths.length > 0 && delivered.length > 0) {
        // Validate every path exists up front so we can report cleanly
        const missing = attachmentPaths.filter(p => !fs.existsSync(p));
        if (missing.length > 0) {
          log.warn('Some attachment paths missing', { missing });
        }
        const validPaths = attachmentPaths.filter(p => fs.existsSync(p));

        for (const ch of delivered) {
          attachResults[ch] = { sent: [], failed: [] };
          if (ch === 'telegram') {
            const telegramSendFile = _telegramSendFileOverride ?? (await import('../extensions/comms/adapters/telegram.js')).telegramSendFile;
            for (const fp of validPaths) {
              const ok = await telegramSendFile(fp, undefined, undefined, metadata.chatId as string | undefined);
              if (ok) attachResults[ch].sent.push(path.basename(fp));
              else attachResults[ch].failed.push(path.basename(fp));
            }
          } else {
            // teams / email / other not yet wired through /api/send. Email
            // path: use /api/email/send (it now passes attachments through).
            attachResults[ch].failed.push(...validPaths.map(p => path.basename(p)));
            log.warn(`Attachments not supported on channel '${ch}' via /api/send (use /api/email/send for email)`);
          }
          // Surface missing files as failures on every channel
          for (const m of missing) attachResults[ch].failed.push(`MISSING:${path.basename(m)}`);
        }
      }

      if (failed.length > 0) {
        const channelList = failed.join(', ');
        const preview = (body.message as string).length > 120
          ? (body.message as string).slice(0, 120) + '…'
          : body.message as string;
        try {
          sendMessage({
            from: 'daemon',
            to: 'comms',
            type: 'error',
            body: `[delivery failed: ${channelList}] ${preview}`,
          });
        } catch (notifyErr) {
          log.warn('Failed to notify comms of delivery failure', {
            error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          });
        }
      }

      // Return 502 only when every channel attempted delivery and all failed.
      // Partial success (some channels delivered) still returns 200.
      const resultValues = Object.values(results);
      const allFailed = resultValues.length > 0 && resultValues.every(v => v === false);
      if (allFailed) {
        json(res, 502, withTimestamp({ error: 'All delivery channels failed', results }));
        return true;
      }

      const responseBody: Record<string, unknown> = { results };
      if (Object.keys(attachResults).length > 0) {
        // Per-channel attachments_sent / attachments_failed counts as documented
        const attachments_sent: Record<string, number> = {};
        const attachments_failed: Record<string, number> = {};
        for (const [ch, r] of Object.entries(attachResults)) {
          attachments_sent[ch] = r.sent.length;
          attachments_failed[ch] = r.failed.length;
        }
        responseBody.attachments_sent = attachments_sent;
        responseBody.attachments_failed = attachments_failed;
        responseBody.attachments_detail = attachResults;
      }
      json(res, 200, withTimestamp(responseBody));
      return true;
    }

    // ── POST /api/send-file — file/document send ─────────────
    if (pathname === '/api/send-file' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.file_path || typeof body.file_path !== 'string') {
        json(res, 400, withTimestamp({ error: 'file_path is required' }));
        return true;
      }

      const filePath = body.file_path as string;
      const caption = typeof body.caption === 'string' ? body.caption : undefined;
      const fileName = typeof body.file_name === 'string' ? body.file_name : path.basename(filePath);
      let chatId = typeof body.chat_id === 'string' ? body.chat_id : undefined;

      // Resolve recipient name for file sends too
      if (!chatId && typeof body.to === 'string') {
        const resolved = resolveRecipient(body.to as string);
        if ('error' in resolved) {
          json(res, 404, withTimestamp({ error: resolved.error }));
          return true;
        }
        chatId = resolved.chatId;
        log.info('Resolved file recipient', { to: body.to, chatId });
      }

      // Validate channels — only 'telegram' supports file sends currently
      const rawChannels: string[] = Array.isArray(body.channels)
        ? body.channels.filter((c: unknown) => typeof c === 'string') as string[]
        : typeof body.channel === 'string'
          ? [body.channel]
          : ['telegram'];

      const unsupported = rawChannels.filter(c => c !== 'telegram');
      if (unsupported.length > 0) {
        json(res, 400, withTimestamp({
          error: `File sending is only supported on 'telegram'. Unsupported: ${unsupported.join(', ')}`,
        }));
        return true;
      }

      // Validate file exists
      if (!fs.existsSync(filePath)) {
        json(res, 400, withTimestamp({ error: `File not found: ${filePath}` }));
        return true;
      }

      // Validate file size (Telegram bot API limit: 50MB)
      const stat = fs.statSync(filePath);
      const MAX_SIZE = 50 * 1024 * 1024;
      if (stat.size > MAX_SIZE) {
        json(res, 400, withTimestamp({
          error: `File too large: ${Math.round(stat.size / 1024 / 1024)}MB exceeds Telegram 50MB limit`,
        }));
        return true;
      }

      // Lazy import to avoid circular deps — telegram adapter may not be loaded yet.
      // Use the injectable override if set (tests only), otherwise dynamic import.
      const telegramSendFile = _telegramSendFileOverride
        ?? (await import('../extensions/comms/adapters/telegram.js')).telegramSendFile;
      const ok = await telegramSendFile(filePath, fileName, caption, chatId);

      const results: Record<string, boolean> = { telegram: ok };

      if (!ok) {
        try {
          sendMessage({
            from: 'daemon',
            to: 'comms',
            type: 'error',
            body: `[delivery failed: telegram] File send failed for: ${fileName}`,
          });
        } catch { /* ignore notify errors */ }
      }

      log.info(`File send: ${fileName} → telegram (${ok ? 'ok' : 'failed'})`);
      json(res, 200, withTimestamp({ results }));
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === 'Request body too large') {
        json(res, 413, withTimestamp({ error: 'Request body too large' }));
        return true;
      }
      if (err.message === 'Invalid JSON') {
        json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
        return true;
      }
    }
    throw err;
  }
}

