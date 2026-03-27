/**
 * A2A Network REST API — exposes the SDK through daemon HTTP API.
 * Prefix: /api/network/*
 */

import type http from 'node:http';
import { json, withTimestamp, parseBody } from '../../../api/helpers.js';
import { createLogger } from '../../../core/logger.js';
import { getNetworkClient, getCommunityStatus } from './sdk-bridge.js';

const log = createLogger('api:network');

export async function handleNetworkRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const subpath = pathname.replace(/^\/api\/network\/?/, '');
  const network = getNetworkClient();

  try {
    // Status (always available)
    if (subpath === 'status') {
      if (!network) {
        json(res, 200, withTimestamp({ initialized: false }));
        return true;
      }
      const communities = network.communities.map((c: { name: string; primary: string; failover?: string }) => ({
        name: c.name, primary: c.primary, failover: c.failover,
        ...getCommunityStatus(c.name),
      }));
      json(res, 200, withTimestamp({ initialized: true, communities }));
      return true;
    }

    // SDK guard
    if (!network) {
      json(res, 503, withTimestamp({ error: 'Network SDK not initialized' }));
      return true;
    }

    // Contacts
    if (subpath === 'contacts' && method === 'GET') {
      const contacts = await network.getContacts();
      json(res, 200, withTimestamp({ contacts }));
      return true;
    }
    if (subpath === 'contacts/request' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.username || typeof body.username !== 'string') {
        json(res, 400, withTimestamp({ error: 'username is required' }));
        return true;
      }
      const result = await network.requestContact(body.username);
      json(res, 200, withTimestamp(result as unknown as Record<string, unknown>));
      return true;
    }
    if (subpath === 'contacts/pending' && method === 'GET') {
      const requests = await network.getPendingRequests();
      json(res, 200, withTimestamp({ requests }));
      return true;
    }
    if (subpath === 'contacts/accept' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.username || typeof body.username !== 'string') {
        json(res, 400, withTimestamp({ error: 'username is required' }));
        return true;
      }
      await network.acceptContact(body.username);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }
    if (subpath === 'contacts/deny' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.username || typeof body.username !== 'string') {
        json(res, 400, withTimestamp({ error: 'username is required' }));
        return true;
      }
      await network.denyContact(body.username);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }
    if (subpath.startsWith('contacts/') && method === 'DELETE') {
      const username = subpath.slice('contacts/'.length);
      if (!username) { json(res, 400, withTimestamp({ error: 'username is required' })); return true; }
      await network.removeContact(username);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }

    // Presence
    if (subpath.startsWith('presence/') && method === 'GET') {
      const username = subpath.slice('presence/'.length);
      if (!username) { json(res, 400, withTimestamp({ error: 'username is required' })); return true; }
      const presence = await network.checkPresence(username);
      json(res, 200, withTimestamp(presence as unknown as Record<string, unknown>));
      return true;
    }

    // Groups
    if (subpath === 'groups' && method === 'GET') {
      json(res, 200, withTimestamp({ groups: await network.getGroups() }));
      return true;
    }
    if (subpath === 'groups' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || typeof body.name !== 'string') {
        json(res, 400, withTimestamp({ error: 'name is required' }));
        return true;
      }
      const settings = typeof body.settings === 'object' ? body.settings as Record<string, unknown> : undefined;
      const group = await network.createGroup(body.name, settings);
      json(res, 201, withTimestamp(group as unknown as Record<string, unknown>));
      return true;
    }
    if (subpath === 'groups/invitations' && method === 'GET') {
      json(res, 200, withTimestamp({ invitations: await network.getGroupInvitations() }));
      return true;
    }

    // Group actions
    const groupActionMatch = subpath.match(/^groups\/([^/]+)\/(.+)$/);
    if (groupActionMatch) {
      const [, groupId, action] = groupActionMatch;
      if (action === 'members' && method === 'GET') {
        json(res, 200, withTimestamp({ members: await network.getGroupMembers(groupId) }));
        return true;
      }
      if (action === 'invite' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.agent || typeof body.agent !== 'string') {
          json(res, 400, withTimestamp({ error: 'agent is required' }));
          return true;
        }
        await network.inviteToGroup(groupId, body.agent, typeof body.greeting === 'string' ? body.greeting : undefined);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
      if (action === 'send' && method === 'POST') {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Link', '</api/a2a/send>; rel="successor-version"');
        const body = await parseBody(req);
        if (!body.payload || typeof body.payload !== 'object') {
          json(res, 400, withTimestamp({ error: 'payload is required' }));
          return true;
        }
        const result = await network.sendToGroup(groupId, body.payload as Record<string, unknown>);
        json(res, 200, withTimestamp(result));
        return true;
      }
      if (action === 'accept' && method === 'POST') {
        await network.acceptGroupInvitation(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
      if (action === 'decline' && method === 'POST') {
        await network.declineGroupInvitation(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
      if (action === 'leave' && method === 'POST') {
        await network.leaveGroup(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
      if (action === 'transfer' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.newOwner || typeof body.newOwner !== 'string') {
          json(res, 400, withTimestamp({ error: 'newOwner is required' }));
          return true;
        }
        await network.transferGroupOwnership(groupId, body.newOwner);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
      const memberRemoveMatch = action.match(/^members\/(.+)$/);
      if (memberRemoveMatch && method === 'DELETE') {
        await network.removeFromGroup(groupId, memberRemoveMatch[1]);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
    }

    // Group delete
    const groupDeleteMatch = subpath.match(/^groups\/([^/]+)$/);
    if (groupDeleteMatch && method === 'DELETE') {
      await network.dissolveGroup(groupDeleteMatch[1]);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }

    // Broadcasts
    if (subpath === 'broadcasts' && method === 'GET') {
      json(res, 200, withTimestamp({ broadcasts: await network.checkBroadcasts() }));
      return true;
    }

    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Request body too large') { json(res, 413, withTimestamp({ error: message })); return true; }
    if (message === 'Invalid JSON') { json(res, 400, withTimestamp({ error: message })); return true; }
    log.error('Network API error', { error: message, path: pathname, method });
    json(res, 502, withTimestamp({ error: `Network SDK error: ${message}` }));
    return true;
  }
}
