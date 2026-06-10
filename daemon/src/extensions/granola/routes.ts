/**
 * Granola HTTP routes — /api/granola/*
 */

import http from 'node:http';
import type { RouteHandler } from '../../core/route-registry.js';
import { json, withTimestamp, parseBody } from '../../api/helpers.js';
import { getDatabase, insert } from '../../core/db.js';
import { createLogger } from '../../core/logger.js';
import {
  getNote,
  queryNotesByDate,
  queryNotesByRange,
  queryNotesByCalendarEventId,
  countNotes,
  listCandidates,
  getCandidate,
  updateCandidateState,
  countCandidatesByState,
  getSyncState,
} from './store.js';
import { syncNotes } from './scheduler.js';
import { getKey, getNote as getNoteUpstream } from './client.js';
import type { GranolaConfig } from './config.js';

const log = createLogger('granola-routes');

// Shared config ref — set at init time
let _config: GranolaConfig | null = null;

export function setConfig(config: GranolaConfig): void {
  _config = config;
}

// ── Route handlers ─────────────────────────────────────────────

export const handleGranolaStatus: RouteHandler = async (_req, res) => {
  const syncState = getSyncState();
  const keyPresent = !!(await getKey());
  json(res, 200, withTimestamp({
    enabled: _config?.enabled ?? false,
    last_sync_at: syncState.last_sync_at,
    last_sync_status: syncState.last_sync_status,
    key_present: keyPresent,
    notes_count: countNotes(),
    candidates_pending: countCandidatesByState('suggested'),
  }));
  return true;
};

export const handleGranolaNotes: RouteHandler = async (req, res, _pathname, searchParams) => {
  const date = searchParams.get('date');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const calEventId = searchParams.get('calendar_event_id');

  let notes;
  if (date) {
    notes = queryNotesByDate(date);
  } else if (from && to) {
    notes = queryNotesByRange(from, to);
  } else if (calEventId) {
    notes = queryNotesByCalendarEventId(calEventId);
  } else {
    // Return recent 20
    const db = getDatabase();
    notes = db.prepare(
      'SELECT * FROM granola_notes ORDER BY scheduled_start_time DESC LIMIT 20',
    ).all();
  }

  json(res, 200, withTimestamp({ data: notes }));
  return true;
};

export const handleGranolaNoteById: RouteHandler = async (_req, res, pathname, searchParams) => {
  const noteId = pathname.slice('/api/granola/notes/'.length);
  if (!noteId) {
    json(res, 400, withTimestamp({ error: 'note_id required' }));
    return true;
  }

  const includeTranscript = searchParams?.get('include_transcript') === '1' || searchParams?.get('include_transcript') === 'true';

  // Always start with the local DB cache for the metadata
  const cached = getNote(noteId);
  if (!cached && !includeTranscript) {
    json(res, 404, withTimestamp({ error: 'Note not found' }));
    return true;
  }

  if (!includeTranscript) {
    // cached is non-null here: null + !includeTranscript already returned 404 above
    json(res, 200, withTimestamp(cached!));
    return true;
  }

  // Fetch upstream for transcript (and any fresh detail)
  if (!_config?.api_base_url) {
    json(res, 503, withTimestamp({ error: 'Granola not configured' }));
    return true;
  }
  const upstream = await getNoteUpstream(_config.api_base_url, noteId, true);
  if (!upstream) {
    json(res, 404, withTimestamp({ error: 'Note not found upstream' }));
    return true;
  }
  // Merge: DB metadata + upstream transcript
  const merged = { ...(cached ?? {}), transcript: upstream.transcript ?? null };
  json(res, 200, withTimestamp(merged));
  return true;
};

export const handleGranolaSync: RouteHandler = async (req, res) => {
  if (req.method !== 'POST') {
    json(res, 405, withTimestamp({ error: 'Method not allowed' }));
    return true;
  }

  if (!_config?.enabled) {
    json(res, 503, withTimestamp({ error: 'Granola extension disabled' }));
    return true;
  }

  try {
    const result = await syncNotes(_config);
    json(res, 200, withTimestamp({ ok: true, ...result }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Manual sync error', { error: msg });
    json(res, 500, withTimestamp({ error: msg }));
  }
  return true;
};

export const handleGranolaCandidates: RouteHandler = async (_req, res, _pathname, searchParams) => {
  const state = searchParams.get('state') ?? undefined;
  const candidates = listCandidates(state);
  json(res, 200, withTimestamp({ data: candidates }));
  return true;
};

export const handleGranolaCandidateAction: RouteHandler = async (req, res, pathname) => {
  // Expects: /api/granola/candidates/:id/approve|reject|defer
  const match = pathname.match(/^\/api\/granola\/candidates\/(\d+)\/(approve|reject|defer)$/);
  if (!match) {
    json(res, 404, withTimestamp({ error: 'Not found' }));
    return true;
  }

  const id = parseInt(match[1]!, 10);
  const action = match[2] as 'approve' | 'reject' | 'defer';

  const candidate = getCandidate(id);
  if (!candidate) {
    json(res, 404, withTimestamp({ error: `Candidate ${id} not found` }));
    return true;
  }

  if (candidate.state !== 'suggested') {
    json(res, 409, withTimestamp({ error: `Candidate is already in state: ${candidate.state}` }));
    return true;
  }

  if (action === 'approve') {
    const body = req.method === 'POST' ? await parseBody(req) : {};
    const title = (body.todo_text as string | undefined) ?? candidate.text;

    // Create a real todo in the unified tasks table (mirrors state.ts POST /api/todos)
    const now = new Date().toISOString();
    const todoData: Record<string, unknown> = {
      kind: 'todo',
      title,
      description: `Action item from Granola note ${candidate.note_id}`,
      priority: 'medium',
      status: 'pending',
      source: 'auto:granola',
      created_at: now,
      updated_at: now,
    };
    if (candidate.due_date_guess) todoData['due_date'] = candidate.due_date_guess;

    const todo = insert<{ id: number; title: string }>('tasks', todoData);
    updateCandidateState(id, 'approved', todo.id);

    json(res, 200, withTimestamp({ ok: true, state: 'approved', todo_id: todo.id }));
    return true;
  }

  if (action === 'reject') {
    updateCandidateState(id, 'rejected');
    json(res, 200, withTimestamp({ ok: true, state: 'rejected' }));
    return true;
  }

  if (action === 'defer') {
    updateCandidateState(id, 'deferred');
    json(res, 200, withTimestamp({ ok: true, state: 'deferred' }));
    return true;
  }

  json(res, 400, withTimestamp({ error: 'Unknown action' }));
  return true;
};
