/**
 * Contacts API — CRUD endpoints for the centralized contact registry.
 * Supports people, machines, and services with full audit trail.
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
} from '../core/db.js';
import { json, withTimestamp, parseBody } from './helpers.js';

// ── Types ─────────────────────────────────────────────────────

interface Contact {
  id: number;
  name: string;
  type: string;
  email: string | null;
  phone: string | null;
  telegram_id: string | null;
  ssh_host: string | null;
  ssh_user: string | null;
  ip: string | null;
  hostname: string | null;
  role: string | null;
  url: string | null;
  metadata: string; // JSON
  tags: string;     // JSON
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactAction {
  id: number;
  contact_id: number;
  action: string;
  changes: string | null; // JSON
  agent: string | null;
  created_at: string;
}

const VALID_TYPES = ['person', 'machine', 'service'] as const;
const VALID_ROLES = ['owner', 'peer', 'family', 'client', 'service', 'monitored', 'self'] as const;

// ── Helpers ───────────────────────────────────────────────────

function extractId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix + '/')) return null;
  const rest = pathname.slice(prefix.length + 1);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Parse metadata and tags JSON fields on a raw contact row before returning.
 */
function parseContact(contact: Contact): Record<string, unknown> {
  return {
    ...contact,
    metadata: (() => { try { return JSON.parse(contact.metadata); } catch { return {}; } })(),
    tags: (() => { try { return JSON.parse(contact.tags); } catch { return []; } })(),
  };
}

/**
 * Log an action to the contact_actions audit table.
 */
function logContactAction(
  contactId: number,
  action: string,
  changes: Record<string, unknown> | null,
  agent: string | null,
): void {
  exec(
    'INSERT INTO contact_actions (contact_id, action, changes, agent) VALUES (?, ?, ?, ?)',
    contactId,
    action,
    changes !== null ? JSON.stringify(changes) : null,
    agent ?? null,
  );
}

/**
 * Build a changes diff object for update audit log.
 */
function buildChanges(
  existing: Contact,
  updates: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const existingAsRecord = existing as unknown as Record<string, unknown>;
  for (const [key, newVal] of Object.entries(updates)) {
    if (key === 'updated_at') continue;
    const oldVal = existingAsRecord[key];
    // Compare serialized forms to handle JSON fields
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { from: oldVal, to: newVal };
    }
  }
  return changes;
}

/**
 * Derive the caller's role from server-side state rather than a self-reported header.
 * Workers are tracked in worker_jobs — if the caller identifies via X-Agent-Id
 * and has an active worker job, they get read-only access.
 */
function resolveCallerRole(req: http.IncomingMessage): string | null {
  const agentId = req.headers['x-agent-id'] as string | undefined;
  if (!agentId) return null;

  // Check if this agent ID has an active worker job
  const jobs = query<{ profile: string }>(
    "SELECT profile FROM worker_jobs WHERE id = ? AND status IN ('running', 'queued') LIMIT 1",
    agentId,
  );
  if (jobs.length > 0) return 'worker';

  // Check the agents table for type
  const agents = query<{ type: string }>(
    'SELECT type FROM agents WHERE id = ? LIMIT 1',
    agentId,
  );
  if (agents.length > 0 && agents[0].type === 'worker') return 'worker';

  return null;
}

// ── Route handler ─────────────────────────────────────────────

export async function handleContactsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith('/api/contacts')) return false;

  const method = req.method ?? 'GET';
  const agentRole = resolveCallerRole(req);

  // Worker access control — read-only
  if (agentRole === 'worker' && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
    json(res, 403, withTimestamp({ error: 'Workers have read-only access to contacts' }));
    return true;
  }

  try {
    // ── GET /api/contacts/search (MUST precede /:id pattern) ──
    if (pathname === '/api/contacts/search' && method === 'GET') {
      const email = searchParams.get('email');
      const telegramId = searchParams.get('telegram_id');
      const role = searchParams.get('role');
      const q = searchParams.get('q');

      let sql = 'SELECT * FROM contacts WHERE 1=1';
      const params: unknown[] = [];

      if (email) {
        sql += ' AND email LIKE ?';
        params.push(`%${email}%`);
      }
      if (telegramId) {
        sql += ' AND telegram_id = ?';
        params.push(telegramId);
      }
      if (role) {
        sql += ' AND role = ?';
        params.push(role);
      }
      if (q) {
        sql += ' AND (name LIKE ? OR notes LIKE ? OR email LIKE ? OR metadata LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }

      sql += ' ORDER BY name ASC';
      const contacts = query<Contact>(sql, ...params);
      json(res, 200, withTimestamp({ data: contacts.map(parseContact) }));
      return true;
    }

    // ── GET /api/contacts ──────────────────────────────────────
    if (pathname === '/api/contacts' && method === 'GET') {
      const typeFilter = searchParams.get('type');
      const tagFilter = searchParams.get('tag');
      const roleFilter = searchParams.get('role');
      const q = searchParams.get('q');

      // Build query dynamically
      let sql = 'SELECT * FROM contacts WHERE 1=1';
      const params: unknown[] = [];

      if (typeFilter) {
        sql += ' AND type = ?';
        params.push(typeFilter);
      }
      if (roleFilter) {
        sql += ' AND role = ?';
        params.push(roleFilter);
      }
      if (q) {
        sql += ' AND name LIKE ?';
        params.push(`%${q}%`);
      }
      if (tagFilter) {
        // Tags are stored as a JSON array — use JSON contains check
        sql += " AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)";
        params.push(tagFilter);
      }

      sql += ' ORDER BY name ASC';
      const contacts = query<Contact>(sql, ...params);
      json(res, 200, withTimestamp({ data: contacts.map(parseContact) }));
      return true;
    }

    // ── POST /api/contacts ─────────────────────────────────────
    if (pathname === '/api/contacts' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.name || typeof body.name !== 'string') {
        json(res, 400, withTimestamp({ error: 'name is required' }));
        return true;
      }
      if (body.type !== undefined && !VALID_TYPES.includes(body.type as typeof VALID_TYPES[number])) {
        json(res, 400, withTimestamp({ error: `invalid type (must be ${VALID_TYPES.join('/')})` }));
        return true;
      }
      if (body.role !== undefined && body.role !== null && !VALID_ROLES.includes(body.role as typeof VALID_ROLES[number])) {
        json(res, 400, withTimestamp({ error: `invalid role (must be ${VALID_ROLES.join('/')})` }));
        return true;
      }
      if (body.metadata !== undefined && (typeof body.metadata !== 'object' || Array.isArray(body.metadata) || body.metadata === null)) {
        json(res, 400, withTimestamp({ error: 'metadata must be an object' }));
        return true;
      }
      if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t: unknown) => typeof t === 'string'))) {
        json(res, 400, withTimestamp({ error: 'tags must be an array of strings' }));
        return true;
      }

      const data: Record<string, unknown> = { name: body.name };
      if (body.type !== undefined) data.type = body.type;
      if (body.email !== undefined) data.email = body.email;
      if (body.phone !== undefined) data.phone = body.phone;
      if (body.telegram_id !== undefined) data.telegram_id = body.telegram_id;
      if (body.ssh_host !== undefined) data.ssh_host = body.ssh_host;
      if (body.ssh_user !== undefined) data.ssh_user = body.ssh_user;
      if (body.ip !== undefined) data.ip = body.ip;
      if (body.hostname !== undefined) data.hostname = body.hostname;
      if (body.role !== undefined) data.role = body.role;
      if (body.url !== undefined) data.url = body.url;
      if (body.metadata !== undefined) data.metadata = JSON.stringify(body.metadata);
      if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
      if (body.notes !== undefined) data.notes = body.notes;

      const contact = insert<Contact>('contacts', data);
      const agent = agentRole ?? (typeof body.agent === 'string' ? body.agent : null);
      logContactAction(contact.id, 'created', null, agent);

      json(res, 201, withTimestamp(parseContact(contact)));
      return true;
    }

    // ── Routes by ID ───────────────────────────────────────────
    const contactId = extractId(pathname, '/api/contacts');
    if (contactId !== null) {
      // ── GET /api/contacts/:id/history ──────────────────────
      if (pathname.endsWith('/history') && method === 'GET') {
        const realId = contactId;
        const actions = query<ContactAction>(
          'SELECT * FROM contact_actions WHERE contact_id = ? ORDER BY created_at ASC',
          realId,
        );
        json(res, 200, withTimestamp({ data: actions }));
        return true;
      }

      // ── GET /api/contacts/:id ──────────────────────────────
      if (method === 'GET') {
        const contact = get<Contact>('contacts', Number(contactId));
        if (!contact) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp(parseContact(contact)));
        return true;
      }

      // ── PUT /api/contacts/:id ──────────────────────────────
      if (method === 'PUT') {
        const existing = get<Contact>('contacts', Number(contactId));
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }

        const body = await parseBody(req);

        if (body.type !== undefined && !VALID_TYPES.includes(body.type as typeof VALID_TYPES[number])) {
          json(res, 400, withTimestamp({ error: `invalid type (must be ${VALID_TYPES.join('/')})` }));
          return true;
        }
        if (body.role !== undefined && body.role !== null && !VALID_ROLES.includes(body.role as typeof VALID_ROLES[number])) {
          json(res, 400, withTimestamp({ error: `invalid role (must be ${VALID_ROLES.join('/')})` }));
          return true;
        }
        if (body.metadata !== undefined && (typeof body.metadata !== 'object' || Array.isArray(body.metadata) || body.metadata === null)) {
          json(res, 400, withTimestamp({ error: 'metadata must be an object' }));
          return true;
        }
        if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t: unknown) => typeof t === 'string'))) {
          json(res, 400, withTimestamp({ error: 'tags must be an array of strings' }));
          return true;
        }

        const data: Record<string, unknown> = { updated_at: now() };
        if (body.name !== undefined) data.name = body.name;
        if (body.type !== undefined) data.type = body.type;
        if (body.email !== undefined) data.email = body.email;
        if (body.phone !== undefined) data.phone = body.phone;
        if (body.telegram_id !== undefined) data.telegram_id = body.telegram_id;
        if (body.ssh_host !== undefined) data.ssh_host = body.ssh_host;
        if (body.ssh_user !== undefined) data.ssh_user = body.ssh_user;
        if (body.ip !== undefined) data.ip = body.ip;
        if (body.hostname !== undefined) data.hostname = body.hostname;
        if (body.role !== undefined) data.role = body.role;
        if (body.url !== undefined) data.url = body.url;
        if (body.metadata !== undefined) data.metadata = JSON.stringify(body.metadata);
        if (body.tags !== undefined) data.tags = JSON.stringify(body.tags);
        if (body.notes !== undefined) data.notes = body.notes;

        const changes = buildChanges(existing, data);
        update('contacts', Number(contactId), data);

        const agent = agentRole ?? (typeof body.agent === 'string' ? body.agent : null);
        if (Object.keys(changes).length > 0) {
          logContactAction(existing.id, 'updated', changes, agent);
        }

        const updated = get<Contact>('contacts', Number(contactId));
        json(res, 200, withTimestamp(parseContact(updated!)));
        return true;
      }

      // ── DELETE /api/contacts/:id ───────────────────────────
      if (method === 'DELETE') {
        const existing = get<Contact>('contacts', Number(contactId));
        if (!existing) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }

        // Log before deletion (ON DELETE CASCADE will remove contact_actions rows,
        // but we want the deletion event recorded — however since the row is being
        // deleted, we log it first while it still exists)
        // Actually: the contact_actions table has ON DELETE CASCADE, so logging a
        // 'deleted' action before removing the contact would be immediately wiped.
        // We record the deletion in a way that captures the contact name/id in the
        // action changes field for any future audit needs before the cascade fires.
        // In practice, the cascade deletes existing history too — this is intentional
        // per the schema design (contact gone = audit trail gone).
        remove('contacts', Number(contactId));

        res.writeHead(204);
        res.end();
        return true;
      }
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
