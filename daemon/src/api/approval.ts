/**
 * Approval API — HTTP endpoints for the approval workflow gate.
 *
 * Routes:
 *   POST /api/approval/decision  — Record human approve/reject (resolves pending gate)
 *   GET  /api/approval/pending   — List in-flight approvals awaiting a decision
 */

import type http from 'node:http';
import { json, parseBody } from './helpers.js';
import { resolveGate, getPendingGates } from '../comms/approval-gate.js';
import { createLogger } from '../core/logger.js';
import { verifyToken } from '../auth/agent-tokens.js';

const log = createLogger('approval-api');

// ── Route handler ─────────────────────────────────────────────────────

export async function handleApprovalRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {

  // POST /api/approval/decision
  if (req.method === 'POST' && pathname === '/api/approval/decision') {
    return handleDecision(req, res);
  }

  // GET /api/approval/pending
  if (req.method === 'GET' && pathname === '/api/approval/pending') {
    return handlePending(req, res);
  }

  return false;
}

// ── POST /api/approval/decision ───────────────────────────────────────

async function handleDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  // ── Auth gate ──────────────────────────────────────────────────────────
  // Only the comms agent may submit approval decisions.
  // Telegram inline-button decisions are routed directly through resolveGate()
  // in extensions/index.ts (callback_query path) and do NOT go through this
  // HTTP endpoint, so adding auth here does not break the button flow.
  const rawHeader = req.headers['x-agent-token'];
  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!token) {
    json(res, 401, { error: 'X-Agent-Token header required' });
    return true;
  }
  const identity = verifyToken(token);
  if (!identity) {
    json(res, 401, { error: 'Invalid or revoked agent token' });
    return true;
  }
  if (identity.role !== 'comms') {
    json(res, 403, { error: 'Only the comms agent may submit approval decisions' });
    return true;
  }
  // ── End auth gate ──────────────────────────────────────────────────────

  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return true;
  }

  const { approval_id, decision, decider } = body;

  if (typeof approval_id !== 'string' || !approval_id) {
    json(res, 400, { error: 'approval_id is required and must be a string' });
    return true;
  }

  if (decision !== 'approved' && decision !== 'rejected') {
    json(res, 400, { error: 'decision must be "approved" or "rejected"' });
    return true;
  }

  // decider field is informational — must be 'human' for interactive decisions
  if (decider !== undefined && decider !== 'human') {
    json(res, 400, { error: 'decider must be "human"' });
    return true;
  }

  const result = resolveGate(
    approval_id,
    decision as 'approved' | 'rejected',
    typeof decider === 'string' ? decider : 'human',
  );

  if (result === 'not_found') {
    json(res, 404, { error: 'approval_id not found' });
    return true;
  }

  if (result === 'already_resolved') {
    json(res, 409, {
      error: 'Conflict',
      message: 'This approval has already been resolved or has expired. Decisions on resolved approvals are rejected.',
    });
    return true;
  }

  log.info('Approval decision recorded via API', {
    approval_id,
    decision,
  });

  json(res, 200, { status: 'ok' });
  return true;
}

// ── GET /api/approval/pending ─────────────────────────────────────────

async function handlePending(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const gates = getPendingGates();

  const pending = Array.from(gates.values()).map(gate => ({
    approval_id: gate.card.approval_id,
    channel: gate.card.channel,
    recipient: gate.card.recipient,
    sender_agent: gate.card.sender_agent,
    preview: gate.card.preview,
    policy: gate.card.policy,
    expires_at: gate.card.expires_at,
    created_at: gate.created_at,
  }));

  json(res, 200, { pending });
  return true;
}
