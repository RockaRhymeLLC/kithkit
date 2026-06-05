/**
 * sendToHuman — the ONE sanctioned path for scheduler tasks to deliver
 * messages to human channels.
 *
 * Background (auth-family fix 2026-06-05): the #290 token cutover put an
 * X-Agent-Token role gate on /api/send, but four scheduler tasks called it
 * with bare fetch() and silently 401'd from 2026-05-20 onward (meeting-prep,
 * saturday-report, daily-digest, stale-todo-surfacing). Other tasks
 * (morning-briefing) already called routeMessage() in-process and never hit
 * the gate.
 *
 * Design (R2 constraint, 2026-06-05): PREFER the in-process router — no HTTP
 * hop, no credential dependency, works on fleet boxes that have not minted a
 * daemon-role token yet. Fall back to HTTP /api/send with the boot-scoped
 * 'daemon' token only if the in-process path throws (it shares none of the
 * HTTP listener's failure domain, so this fallback is mostly belt-and-braces).
 *
 * Channel semantics mirror /api/send exactly: `channels` (array) or
 * `channel` (singular) select adapters; `metadata`/`chat_id` merge the same
 * way. (`parse_mode` is accepted for back-compat but — as with /api/send —
 * not consumed by the router.)
 *
 * Workers and orchestrators must NOT import this helper — they escalate via
 * /api/messages (worker → orchestrator → comms → human), enforced for them
 * by the /api/send role gate.
 */

import { routeMessage } from '../../../comms/channel-router.js';
import { getDaemonToken } from '../../../auth/agent-tokens.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger('send-to-human');

export interface SendToHumanPayload extends Record<string, unknown> {
  message: string;
  channel?: string;
  channels?: string[];
  chat_id?: string;
  metadata?: Record<string, unknown>;
}

export interface SendToHumanResult {
  ok: boolean;
  status: number;
  results?: Record<string, boolean>;
  error?: string;
  path: 'in-process' | 'http';
}

function normalizeChannels(payload: SendToHumanPayload): string[] | undefined {
  if (Array.isArray(payload.channels)) {
    return payload.channels.filter((c): c is string => typeof c === 'string');
  }
  if (typeof payload.channel === 'string') return [payload.channel];
  return undefined;
}

/**
 * Deliver a message payload to the human via the channel router.
 * In-process routeMessage first; HTTP /api/send + daemon token as fallback.
 */
export async function sendToHuman(
  payload: SendToHumanPayload,
  port = 3847,
): Promise<SendToHumanResult> {
  const channels = normalizeChannels(payload);
  const metadata: Record<string, unknown> = { ...(payload.metadata ?? {}) };
  if (typeof payload.chat_id === 'string' && !metadata.chatId) {
    metadata.chatId = payload.chat_id;
  }

  // ── Primary: in-process router ─────────────────────────────
  try {
    const results = await routeMessage({ text: payload.message, metadata }, channels);
    const anyOk = Object.values(results).some(Boolean);
    if (anyOk) return { ok: true, status: 200, results, path: 'in-process' };
    log.warn('sendToHuman: in-process delivery returned no successful channel — trying HTTP fallback', { results });
  } catch (err) {
    log.warn('sendToHuman: in-process route threw — trying HTTP fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Fallback: HTTP /api/send with daemon token ─────────────
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': getDaemonToken(),
      },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      log.warn('sendToHuman: HTTP fallback failed', { status: res.status, body: bodyText.slice(0, 300) });
      return { ok: false, status: res.status, error: bodyText.slice(0, 300), path: 'http' };
    }
    let results: Record<string, boolean> | undefined;
    try {
      results = (JSON.parse(bodyText) as { results?: Record<string, boolean> }).results;
    } catch {
      // non-JSON success body — fine
    }
    return { ok: true, status: res.status, results, path: 'http' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('sendToHuman: HTTP fallback request error', { error: msg });
    return { ok: false, status: 0, error: msg, path: 'http' };
  }
}
