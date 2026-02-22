/**
 * State API — CRUD endpoints for todos, calendar, config, feature_state, agents.
 * All responses include a timestamp field.
 */

import type http from 'node:http';
import {
  insert,
  get,
  list,
  update,
  remove,
  query,
  exec,
  getDatabase,
} from '../core/db.js';
import { loadContext } from '../core/context-loader.js';

// ── Types ────────────────────────────────────────────────────

interface Todo {
  id: number;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  due_date: string | null;
  tags: string; // JSON
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

const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

// ── Helpers ──────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

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
    'INSERT INTO todo_actions (todo_id, action, old_value, new_value, note) VALUES (?, ?, ?, ?, ?)',
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
    if (pathname === '/api/todos' && method === 'GET') {
      const todos = list<Todo>('todos', undefined, 'created_at DESC');
      json(res, 200, withTimestamp({ data: todos }));
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
      if (body.status && !VALID_TODO_STATUSES.includes(body.status as string)) {
        json(res, 400, withTimestamp({ error: `invalid status (must be ${VALID_TODO_STATUSES.join('/')})` }));
        return true;
      }

      const data: Record<string, unknown> = { title: body.title };
      if (body.description !== undefined) data.description = body.description;
      if (body.priority) data.priority = body.priority;
      if (body.status) data.status = body.status;
      if (body.due_date) data.due_date = body.due_date;
      if (body.tags) data.tags = JSON.stringify(body.tags);

      const todo = insert<Todo>('todos', data);
      logTodoAction(todo.id, 'created', null, null, `Created with title: ${todo.title}`);
      json(res, 201, withTimestamp(todo));
      return true;
    }

    // Todo by ID
    const todoId = extractId(pathname, '/api/todos');
    if (todoId !== null) {
      // Check for /api/todos/:id/actions
      if (pathname.endsWith('/actions') && method === 'GET') {
        const realId = pathname.split('/')[3];
        const actions = query('SELECT * FROM todo_actions WHERE todo_id = ? ORDER BY created_at ASC', realId);
        json(res, 200, withTimestamp({ data: actions }));
        return true;
      }

      if (method === 'GET') {
        const todo = get<Todo>('todos', Number(todoId));
        if (!todo) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp(todo));
        return true;
      }

      if (method === 'PUT') {
        const body = await parseBody(req);
        if (body.priority && !VALID_PRIORITIES.includes(body.priority as string)) {
          json(res, 400, withTimestamp({ error: `invalid priority (must be ${VALID_PRIORITIES.join('/')})` }));
          return true;
        }
        if (body.status && !VALID_TODO_STATUSES.includes(body.status as string)) {
          json(res, 400, withTimestamp({ error: `invalid status (must be ${VALID_TODO_STATUSES.join('/')})` }));
          return true;
        }

        const existing = get<Todo>('todos', Number(todoId));
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }

        const data: Record<string, unknown> = { updated_at: now() };
        if (body.title !== undefined) data.title = body.title;
        if (body.description !== undefined) data.description = body.description;
        if (body.priority !== undefined) data.priority = body.priority;
        if (body.due_date !== undefined) data.due_date = body.due_date;
        if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
        if (body.status !== undefined) {
          data.status = body.status;
          logTodoAction(existing.id, 'status_change', existing.status, body.status as string);
        }
        if (body.priority !== undefined && body.priority !== existing.priority) {
          logTodoAction(existing.id, 'priority_change', existing.priority, body.priority as string);
        }

        update('todos', Number(todoId), data);
        const updated = get<Todo>('todos', Number(todoId));
        json(res, 200, withTimestamp(updated!));
        return true;
      }

      if (method === 'DELETE') {
        const existing = get<Todo>('todos', Number(todoId));
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        remove('todos', Number(todoId));
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

    // ── Context ─────────────────────────────────────────────
    if (pathname === '/api/context' && method === 'GET') {
      const budgetParam = searchParams.get('budget');
      const summary = loadContext(budgetParam ? parseInt(budgetParam, 10) : undefined);
      json(res, 200, withTimestamp(summary));
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof Error && err.message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }
    throw err;
  }
}
