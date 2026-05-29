/**
 * Telegram renderer for approval cards.
 *
 * Renders an ApprovalCard as a Telegram sendMessage with inline keyboard
 * (Approve / Reject buttons). The callback_data for each button encodes
 * the approval_id and decision so the webhook handler can call
 * POST /api/approval/decision.
 *
 * Callback data format: "approval:<approval_id>:<decision>"
 *   e.g. "approval:550e8400-...:approved"
 *        "approval:550e8400-...:rejected"
 *
 * The Telegram webhook handler must parse callback_query updates and route
 * them to /api/approval/decision via an internal call (not via HTTP — it
 * directly calls resolveGate()).
 */

import https from 'node:https';
import { readKeychain } from '../core/keychain.js';
import { createLogger } from '../core/logger.js';
import type { ApprovalCard } from './approval-gate.js';

const log = createLogger('approval-card-telegram');

/** Build a human-readable preview card text. */
function buildCardText(card: ApprovalCard): string {
  const recipientList = escapeHtml(card.recipient.join(', '));
  const expiresAt = new Date(card.expires_at).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return [
    `<b>Outbound send approval required</b>`,
    ``,
    `Agent: <code>${escapeHtml(card.sender_agent)}</code>`,
    `Channel: <code>${escapeHtml(card.channel)}</code>`,
    `Recipient(s): <code>${recipientList}</code>`,
    `Policy: <code>${card.policy}</code>`,
    `Expires: ${expiresAt}`,
    ``,
    `<b>Preview:</b>`,
    `<blockquote>${escapeHtml(card.preview)}</blockquote>`,
    ``,
    `Tap <b>Approve</b> to send or <b>Reject</b> to abort.`,
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build the inline keyboard payload for the approval card. */
function buildInlineKeyboard(approvalId: string): object {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Approve',
          callback_data: `approval:${approvalId}:approved`,
        },
        {
          text: '❌ Reject',
          callback_data: `approval:${approvalId}:rejected`,
        },
      ],
    ],
  };
}

/** Low-level Telegram API call with inline keyboard. */
async function sendTelegramApprovalCard(
  card: ApprovalCard,
  botToken: string,
  chatId: string,
): Promise<boolean> {
  const text = buildCardText(card);
  const keyboard = buildInlineKeyboard(card.approval_id);

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  return new Promise<boolean>((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15_000,
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on('end', () => {
        try {
          const result = JSON.parse(responseBody) as { ok: boolean; description?: string };
          if (result.ok) {
            log.info('Approval card sent via Telegram', { approval_id: card.approval_id });
            resolve(true);
          } else {
            log.error('Telegram approval card send failed', {
              approval_id: card.approval_id,
              description: result.description,
            });
            resolve(false);
          }
        } catch {
          log.error('Telegram approval card: unparseable response', { approval_id: card.approval_id });
          resolve(false);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      log.error('Telegram approval card send error', {
        approval_id: card.approval_id,
        error: err.message,
      });
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Deliver an approval card via Telegram.
 * Reads bot token + chat ID from keychain.
 * Throws on failure so the gate can fail-closed.
 */
export async function deliverApprovalCardViaTelegram(card: ApprovalCard): Promise<void> {
  const botToken = await readKeychain('credential-telegram-bot');
  const chatId = await readKeychain('credential-telegram-chat-id');

  if (!botToken || !chatId) {
    throw new Error('Telegram credentials not available — cannot deliver approval card');
  }

  const sent = await sendTelegramApprovalCard(card, botToken, chatId);
  if (!sent) {
    throw new Error('Telegram approval card delivery failed');
  }
}

/**
 * Parse a callback_data string from an inline keyboard button tap.
 * Returns null if the data is not an approval callback.
 *
 * Format: "approval:<approval_id>:<decision>"
 */
export function parseApprovalCallback(
  callbackData: string,
): { approval_id: string; decision: 'approved' | 'rejected' } | null {
  if (!callbackData.startsWith('approval:')) return null;

  const parts = callbackData.split(':');
  // "approval" + UUID (potentially containing colons) + decision
  // UUID has format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (no colons)
  // So parts = ['approval', '<uuid>', '<decision>']
  if (parts.length !== 3) return null;

  const [, approvalId, decision] = parts;
  if (!approvalId || !decision) return null;
  if (decision !== 'approved' && decision !== 'rejected') return null;

  return { approval_id: approvalId, decision };
}

/**
 * Answer a Telegram callback query — required to dismiss the "loading" spinner
 * on inline keyboard buttons. Should be called after processing any callback_query.
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const botToken = await readKeychain('credential-telegram-bot');
  if (!botToken) return;

  const body = JSON.stringify({
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: false } : {}),
  });

  await new Promise<void>((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/answerCallbackQuery`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5_000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}
