/**
 * State API — CRUD endpoints for todos, calendar, config, feature_state, agents.
 * All responses include a timestamp field.
 */

import type http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  insert,
  get,
  list,
  update,
  remove,
  query,
  exec,
  getDatabase,
  getShimPragmaOk,
} from '../core/db.js';
import { loadConfig } from '../core/config.js';
import { loadContext } from '../core/context-loader.js';
import { storeMemoryInternal } from './memory.js';
import { createLogger } from '../core/logger.js';
import { normalizeStatusAlias } from '../core/task-state-machine.js';

const log = createLogger('state-api');

// ── Types ────────────────────────────────────────────────────

interface Todo {
  id: number;
  external_id: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  due_date: string | null;
  tags: string; // JSON
  snooze_until: string | null;
  created_at: string;
  updated_at: string;
}

interface CalendarEvent {
  id: number;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  all_day: number;
  source: string | null;
  todo_ref: number | null;
  created_at: string;
}

interface ConfigEntry {
  key: string;
  value: string; // JSON
  updated_at: string;
}

interface FeatureState {
  feature: string;
  state: string; // JSON
  updated_at: string;
}

interface Agent {
  id: string;
  type: string;
  profile: string | null;
  status: string;
  tmux_session: string | null;
  pid: number | null;
  started_at: string | null;
  last_activity: string | null;
  state: string | null; // JSON
  created_at: string;
  updated_at: string;
}

interface WorkerJob {
  id: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_TODO_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'];

// Fields accepted by PUT /api/todos/:id.  Any field in the request body that
// is NOT in this set is silently dropped and a log.warn is emitted so callers
// can diagnose partial-update surprises.  See kithkit-internal #1812.
const KNOWN_TODO_PUT_FIELDS = new Set([
  'title', 'description', 'priority', 'status', 'due_date', 'tags',
  'snooze_until', 'assigned_to', 'work_notes',
]);

// ── Shim helpers ─────────────────────────────────────────────

/**
 * Resolve a legacy todo :id (the integer from the old todos table, now stored
 * as tasks.external_id) to the internal tasks.id (auto-increment integer that
 * is NOT equal to the legacy id once the shared sequence diverges).
 *
 * Returns null when no kind='todo' row with external_id = legacyId exists.
 * Callers MUST return 404 on null — do NOT fall back to tasks.id lookup,
 * as that path resurrects the collision bug where tasks.id=N might belong
 * to an orchestrator-kind row.
 */
function resolveLegacyTodoId(legacyId: string): number | null {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT id FROM tasks WHERE external_id = ? AND kind = 'todo'",
  ).get(legacyId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Map a unified tasks row to the legacy todo response shape:
 * - id: legacy integer (parseInt(external_id) when set, else tasks.id)
 * - external_id: masked as null to preserve legacy API contract
 */
function mapTodoResponse(row: Todo): Record<string, unknown> {
  const legacyId = row.external_id != null ? parseInt(row.external_id, 10) : row.id;
  return { ...(row as unknown as Record<string, unknown>), id: legacyId, external_id: null };
}

const execFileAsync = promisify(execFile);

let _usageHistoryCache: { data: unknown; expiresAt: number } | null = null;
const USAGE_HISTORY_CACHE_MS = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────

import { json, withTimestamp, parseBody } from './helpers.js';

function extractId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length + 1);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

function now(): string {
  return new Date().toISOString();
}

// ── Todo audit trail ─────────────────────────────────────────

function logTodoAction(todoId: number, action: string, oldValue?: string | null, newValue?: string | null, note?: string | null): void {
  exec(
    'INSERT INTO task_actions (task_id, action, old_value, new_value, note) VALUES (?, ?, ?, ?, ?)',
    todoId, action, oldValue ?? null, newValue ?? null, note ?? null,
  );
}

// ── Route handler ────────────────────────────────────────────

export async function handleStateRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // ── Todos ──────────────────────────────────────────────
    // TODO(PR-C): /api/todos shim reading from tasks table — deprecate in next release
    if (pathname === '/api/todos' && method === 'GET') {
      const filter: Record<string, unknown> = { kind: 'todo' };
      const status = searchParams.get('status');
      if (status && VALID_TODO_STATUSES.includes(status)) filter.status = status;
      const priority = searchParams.get('priority');
      if (priority && VALID_PRIORITIES.includes(priority)) filter.priority = priority;
      const todos = list<Todo>('tasks', filter, 'created_at DESC');
      json(res, 200, withTimestamp({ data: todos.map(mapTodoResponse) }));
      return true;
    }

    if (pathname === '/api/todos' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.title || typeof body.title !== 'string') {
        json(res, 400, withTimestamp({ error: 'title is required' }));
        return true;
      }
      if (body.priority && !VALID_PRIORITIES.includes(body.priority as string)) {
        json(res, 400, withTimestamp({ error: `invalid priority (must be ${VALID_PRIORITIES.join('/')})` }));
        return true;
      }
      // Normalize legacy 'done' status to 'completed'
      let incomingStatus = body.status as string | undefined;
      if (incomingStatus === 'done') incomingStatus = 'completed';
      if (incomingStatus && !VALID_TODO_STATUSES.includes(incomingStatus)) {
        json(res, 400, withTimestamp({ error: `invalid status (must be ${VALID_TODO_STATUSES.join('/')})` }));
        return true;
      }

      const data: Record<string, unknown> = { title: body.title, kind: 'todo' };
      if (body.description !== undefined) data.description = body.description;
      if (body.priority) data.priority = body.priority;
      if (incomingStatus) data.status = incomingStatus;
      if (body.due_date) data.due_date = body.due_date;
      if (body.tags) data.tags = JSON.stringify(body.tags);

      const todo = insert<Todo>('tasks', data);
      // Immediately stamp external_id = String(tasks.id) so legacy callers can
      // resolve the returned integer id back to this row via external_id lookup.
      // (Migrated todos get their external_id from migration 025; new ones get it here.)
      exec('UPDATE tasks SET external_id = ? WHERE id = ?', String(todo.id), todo.id);
      logTodoAction(todo.id, 'created', null, null, `Created with title: ${todo.title}`);
      // todo was read before the UPDATE so external_id is still null — mapTodoResponse
      // falls back to tasks.id which equals parseInt(CAST(id AS TEXT)), same value.
      json(res, 201, withTimestamp(mapTodoResponse(todo)));
      return true;
    }

    // Todo by ID
    const todoId = extractId(pathname, '/api/todos');
    if (todoId !== null) {
      // Check for /api/todos/:id/actions
      if (pathname.endsWith('/actions') && method === 'GET') {
        const rawId = pathname.split('/')[3];
        const internalIdForActions = resolveLegacyTodoId(rawId!);
        if (internalIdForActions === null) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        const actions = query('SELECT * FROM task_actions WHERE task_id = ? ORDER BY created_at ASC', internalIdForActions);
        json(res, 200, withTimestamp({ data: actions }));
        return true;
      }

      if (method === 'GET') {
        const internalId = resolveLegacyTodoId(todoId);
        if (internalId === null) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        const todo = get<Todo>('tasks', internalId);
        if (!todo) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp(mapTodoResponse(todo)));
        return true;
      }

      if (method === 'PUT') {
        // Guard: if boot-time PRAGMA check found missing schema columns, refuse the
        // update rather than crashing on a column-not-found SQL error.
        // Callers should run pending migrations (019: snooze_until, 024: unified tasks).
        if (!getShimPragmaOk()) {
          json(res, 503, withTimestamp({
            error: 'Database schema incomplete — required columns missing from tasks table ' +
              '(check migrations 019 for snooze_until, 024 for assigned_to/work_notes). ' +
              'Shim PUT /api/todos/:id is unavailable until migrations are applied.',
          }));
          return true;
        }

        const body = await parseBody(req);
        if (body.priority && !VALID_PRIORITIES.includes(body.priority as string)) {
          json(res, 400, withTimestamp({ error: `invalid priority (must be ${VALID_PRIORITIES.join('/')})` }));
          return true;
        }
        let putStatus = normalizeStatusAlias(body.status as string | undefined) as string | undefined;
        if (putStatus && !VALID_TODO_STATUSES.includes(putStatus)) {
          json(res, 400, withTimestamp({ error: `invalid status (must be ${VALID_TODO_STATUSES.join('/')})` }));
          return true;
        }

        // Warn on any fields not in the shim whitelist — they will be dropped.
        // Callers can't know their update was partially applied otherwise.
        for (const key of Object.keys(body)) {
          if (!KNOWN_TODO_PUT_FIELDS.has(key)) {
            log.warn(
              `PUT /api/todos/:id: unknown field "${key}" dropped — not in shim whitelist. ` +
              'To persist it, add it to KNOWN_TODO_PUT_FIELDS in state.ts. ' +
              'See kithkit-internal #1812.',
            );
          }
        }

        const putInternalId = resolveLegacyTodoId(todoId);
        if (putInternalId === null) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        const existing = get<Todo>('tasks', putInternalId);
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }

        if (body.snooze_until !== undefined && body.snooze_until !== null) {
          if (isNaN(Date.parse(body.snooze_until as string))) {
            json(res, 400, withTimestamp({ error: 'snooze_until must be a valid ISO8601 date string' }));
            return true;
          }
        }

        const data: Record<string, unknown> = { updated_at: now() };
        if (body.title !== undefined) data.title = body.title;
        if (body.description !== undefined) data.description = body.description;
        if (body.priority !== undefined) data.priority = body.priority;
        if (body.due_date !== undefined) data.due_date = body.due_date;
        if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
        if (body.snooze_until !== undefined) data.snooze_until = body.snooze_until;
        if (body.assigned_to !== undefined) data.assigned_to = body.assigned_to;
        if (body.work_notes !== undefined) data.work_notes = body.work_notes;
        if (putStatus !== undefined) {
          data.status = putStatus;
          logTodoAction(existing.id, 'status_change', existing.status, putStatus);
        }
        if (body.priority !== undefined && body.priority !== existing.priority) {
          logTodoAction(existing.id, 'priority_change', existing.priority, body.priority as string);
        }

        update('tasks', putInternalId, data);
        const updated = get<Todo>('tasks', putInternalId);

        // Auto-store completion memory when a todo is marked done or completed
        const newStatus = putStatus;
        if (newStatus === 'done' || newStatus === 'completed') {
          try {
            const todoTitle = (updated!.title || '').substring(0, 100);
            const todoDesc = (updated!.description || '').substring(0, 150);
            const legacyTodoId = updated!.external_id != null ? parseInt(updated!.external_id, 10) : updated!.id;
            const content = `Completed todo #${legacyTodoId}: ${todoTitle}${todoDesc ? ' — ' + todoDesc : ''}`;
            await storeMemoryInternal({
              content,
              category: 'event',
              tags: ['auto', 'todo-completion'],
              source: 'todo-completion',
              importance: 3,
              dedup: true,
            });
          } catch (err) {
            log.warn('Failed to auto-store todo completion memory', { error: String(err) });
          }
        }

        json(res, 200, withTimestamp(mapTodoResponse(updated!)));
        return true;
      }

      if (method === 'DELETE') {
        const deleteInternalId = resolveLegacyTodoId(todoId);
        if (deleteInternalId === null) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        const existing = get<Todo>('tasks', deleteInternalId);
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        remove('tasks', deleteInternalId);
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    // ── Calendar ───────────────────────────────────────────
    if (pathname === '/api/calendar' && method === 'GET') {
      const date = searchParams.get('date');
      let events: CalendarEvent[];
      if (date) {
        events = query<CalendarEvent>(
          "SELECT * FROM calendar WHERE date(start_time) = date(?) ORDER BY start_time ASC",
          date,
        );
      } else {
        events = list<CalendarEvent>('calendar', undefined, 'start_time ASC');
      }
      json(res, 200, withTimestamp({ data: events }));
      return true;
    }

    if (pathname === '/api/calendar' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.title || typeof body.title !== 'string') {
        json(res, 400, withTimestamp({ error: 'title is required' }));
        return true;
      }
      if (!body.start_time) {
        json(res, 400, withTimestamp({ error: 'start_time is required' }));
        return true;
      }

      const data: Record<string, unknown> = {
        title: body.title,
        start_time: body.start_time,
      };
      if (body.description !== undefined) data.description = body.description;
      if (body.end_time !== undefined) data.end_time = body.end_time;
      if (body.all_day !== undefined) data.all_day = body.all_day ? 1 : 0;
      if (body.source !== undefined) data.source = body.source;
      if (body.todo_ref !== undefined) data.todo_ref = body.todo_ref;

      const event = insert<CalendarEvent>('calendar', data);
      json(res, 201, withTimestamp(event));
      return true;
    }

    const calId = extractId(pathname, '/api/calendar');
    if (calId !== null) {
      if (method === 'GET') {
        const event = get<CalendarEvent>('calendar', Number(calId));
        if (!event) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp(event));
        return true;
      }

      if (method === 'PUT') {
        const existing = get<CalendarEvent>('calendar', Number(calId));
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        const body = await parseBody(req);
        const data: Record<string, unknown> = {};
        if (body.title !== undefined) data.title = body.title;
        if (body.description !== undefined) data.description = body.description;
        if (body.start_time !== undefined) data.start_time = body.start_time;
        if (body.end_time !== undefined) data.end_time = body.end_time;
        if (body.all_day !== undefined) data.all_day = body.all_day ? 1 : 0;
        if (body.source !== undefined) data.source = body.source;

        update('calendar', Number(calId), data);
        const updated = get<CalendarEvent>('calendar', Number(calId));
        json(res, 200, withTimestamp(updated!));
        return true;
      }

      if (method === 'DELETE') {
        const deleted = remove('calendar', Number(calId));
        if (!deleted) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    // ── Config ─────────────────────────────────────────────
    const configKey = extractId(pathname, '/api/config');
    if (configKey !== null) {
      if (method === 'GET') {
        const entry = get<ConfigEntry>('config', configKey, 'key');
        if (!entry) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp({ key: entry.key, value: JSON.parse(entry.value), updated_at: entry.updated_at }));
        return true;
      }

      if (method === 'PUT') {
        const body = await parseBody(req);
        if (body.value === undefined) {
          json(res, 400, withTimestamp({ error: 'value is required' }));
          return true;
        }
        const db = getDatabase();
        db.prepare(
          'INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        ).run(configKey, JSON.stringify(body.value), now());
        const entry = get<ConfigEntry>('config', configKey, 'key');
        json(res, 200, withTimestamp({ key: entry!.key, value: JSON.parse(entry!.value), updated_at: entry!.updated_at }));
        return true;
      }
    }

    // ── Feature State ──────────────────────────────────────
    const featureName = extractId(pathname, '/api/feature-state');
    if (featureName !== null) {
      if (method === 'GET') {
        const entry = get<FeatureState>('feature_state', featureName, 'feature');
        if (!entry) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp({ feature: entry.feature, state: JSON.parse(entry.state), updated_at: entry.updated_at }));
        return true;
      }

      if (method === 'PUT') {
        const body = await parseBody(req);
        if (body.state === undefined) {
          json(res, 400, withTimestamp({ error: 'state is required' }));
          return true;
        }
        const db = getDatabase();
        db.prepare(
          'INSERT INTO feature_state (feature, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(feature) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
        ).run(featureName, JSON.stringify(body.state), now());
        const entry = get<FeatureState>('feature_state', featureName, 'feature');
        json(res, 200, withTimestamp({ feature: entry!.feature, state: JSON.parse(entry!.state), updated_at: entry!.updated_at }));
        return true;
      }
    }

    // ── Usage ──────────────────────────────────────────────
    if (pathname === '/api/usage' && method === 'GET') {
      const rows = query<WorkerJob>('SELECT tokens_in, tokens_out, cost_usd FROM worker_jobs');
      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let totalCostUsd = 0;
      for (const row of rows) {
        totalTokensIn += row.tokens_in;
        totalTokensOut += row.tokens_out;
        totalCostUsd += row.cost_usd;
      }
      json(res, 200, withTimestamp({
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        cost_usd: Math.round(totalCostUsd * 10000) / 10000,
        jobs: rows.length,
      }));
      return true;
    }

    // ── Usage History ───────────────────────────────────────
    if (pathname === '/api/usage/history' && method === 'GET') {
      const now = Date.now();
      if (_usageHistoryCache && now < _usageHistoryCache.expiresAt) {
        json(res, 200, _usageHistoryCache.data);
        return true;
      }
      try {
        const projectRoot = new URL('../../..', import.meta.url).pathname;
        const { stdout } = await execFileAsync('npx', ['ccusage', 'daily', '--json'], { cwd: projectRoot, timeout: 30_000 });
        const parsed = JSON.parse(stdout) as unknown;
        _usageHistoryCache = { data: parsed, expiresAt: now + USAGE_HISTORY_CACHE_MS };
        json(res, 200, parsed);
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // ── Cross-Agent Proxy ────────────────────────────────────
    if (pathname.startsWith('/api/proxy/agent/') && method === 'GET') {
      const rest = pathname.slice('/api/proxy/agent/'.length);
      const slash = rest.indexOf('/');
      const agentName = slash === -1 ? rest : rest.slice(0, slash);
      const agentPath = slash === -1 ? '' : rest.slice(slash + 1);
      const agentComms = (loadConfig() as unknown as Record<string, unknown>)['agent-comms'] as
        { peers?: Array<{ name: string; host: string; port: number; ip?: string }> } | undefined;
      const peer = (agentComms?.peers ?? []).find(p => p.name.toLowerCase() === agentName.toLowerCase());
      const base = peer ? `http://${peer.ip ?? peer.host}:${peer.port}` : undefined;
      if (!base) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        json(res, 404, { error: 'Unknown agent', agent: agentName });
        return true;
      }
      const targetUrl = base + '/api/' + agentPath;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      try {
        const upstream = await fetch(targetUrl, { signal: ctrl.signal });
        clearTimeout(timeout);
        const data = await upstream.json() as unknown;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(upstream.status);
        res.end(JSON.stringify(data));
      } catch {
        clearTimeout(timeout);
        res.setHeader('Access-Control-Allow-Origin', '*');
        json(res, 502, { error: 'Agent unreachable', agent: agentName });
      }
      return true;
    }

    // ── Context ─────────────────────────────────────────────
    if (pathname === '/api/context' && method === 'GET') {
      const budgetParam = searchParams.get('budget');
      const summary = loadContext(budgetParam ? parseInt(budgetParam, 10) : undefined);
      json(res, 200, withTimestamp(summary));
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
