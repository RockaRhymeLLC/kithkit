/**
 * A2A Network REST API — exposes the A2A Network SDK through the daemon HTTP API.
 *
 * Prefix: /api/network/*
 * All endpoints require the network SDK to be initialized (returns 503 otherwise).
 */

import type http from 'node:http';
import { json, withTimestamp, parseBody } from '../../../api/helpers.js';
import { createLogger } from '../../../core/logger.js';
import { sendMessage } from '../../../agents/message-router.js';
import { getNetworkClient, getCommunityStatus } from './sdk-bridge.js';
import { checkRegistrationStatus } from './registration.js';
import type { BmoConfig } from '../../config.js';

const log = createLogger('api:network');

let _config: BmoConfig | null = null;

export function setNetworkApiConfig(config: BmoConfig): void {
  _config = config;
}

export async function handleNetworkRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  // Strip prefix: /api/network/contacts -> contacts
  const subpath = pathname.replace(/^\/api\/network\/?/, '');

  const network = getNetworkClient();

  try {
    // ── Status (always available) ──────────────────────────────
    if (subpath === 'status') {
      if (!network) {
        json(res, 200, withTimestamp({ initialized: false }));
        return true;
      }
      const communities = network.communities.map(c => ({
        name: c.name,
        primary: c.primary,
        failover: c.failover,
        ...getCommunityStatus(c.name),
      }));
      json(res, 200, withTimestamp({ initialized: true, communities }));
      return true;
    }

    // ── Registration (always available) ───────────────────────
    if (subpath === 'registration') {
      if (!_config) {
        json(res, 503, withTimestamp({ error: 'Extension not initialized' }));
        return true;
      }
      const result = await checkRegistrationStatus(_config);
      json(res, 200, withTimestamp(result));
      return true;
    }

    // ── SDK guard: all remaining routes need network initialized ──
    if (!network) {
      json(res, 503, withTimestamp({ error: 'Network SDK not initialized' }));
      return true;
    }

    // ── Direct Messaging ──────────────────────────────────────

    if (subpath === 'send' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.to || typeof body.to !== 'string') {
        json(res, 400, withTimestamp({ error: 'to (recipient username) is required' }));
        return true;
      }
      if (!body.payload || typeof body.payload !== 'object') {
        json(res, 400, withTimestamp({ error: 'payload is required' }));
        return true;
      }
      const result = await network.send(body.to, body.payload as Record<string, unknown>);

      // Log outbound A2A message to the messages table for audit trail
      try {
        sendMessage({
          from: 'comms',
          to: `a2a:${body.to}`,
          type: 'text',
          body: JSON.stringify(body.payload),
          metadata: { channel: 'a2a', recipient: body.to, network_result: result },
        });
      } catch (err) {
        log.warn('Failed to log outbound A2A message', { error: String(err) });
      }

      json(res, 200, withTimestamp(result));
      return true;
    }

    // ── Key Rotation ─────────────────────────────────────────

    if (subpath === 'keys/rotate' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.newPublicKey || typeof body.newPublicKey !== 'string') {
        json(res, 400, withTimestamp({ error: 'newPublicKey (base64) is required' }));
        return true;
      }
      const communities = Array.isArray(body.communities) ? body.communities as string[] : undefined;
      const result = await network.rotateKey(body.newPublicKey, communities ? { communities } : undefined);
      json(res, 200, withTimestamp(result));
      return true;
    }

    // ── Contacts ───────────────────────────────────────────────

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
      json(res, 200, withTimestamp(result));
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
      if (!username) {
        json(res, 400, withTimestamp({ error: 'username is required' }));
        return true;
      }
      await network.removeContact(username);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }

    // ── Presence ───────────────────────────────────────────────

    if (subpath.startsWith('presence/') && method === 'GET') {
      const username = subpath.slice('presence/'.length);
      if (!username) {
        json(res, 400, withTimestamp({ error: 'username is required' }));
        return true;
      }
      const presence = await network.checkPresence(username);
      json(res, 200, withTimestamp(presence));
      return true;
    }

    // ── Groups ─────────────────────────────────────────────────

    if (subpath === 'groups' && method === 'GET') {
      const groups = await network.getGroups();
      json(res, 200, withTimestamp({ groups }));
      return true;
    }

    if (subpath === 'groups' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.name || typeof body.name !== 'string') {
        json(res, 400, withTimestamp({ error: 'name is required' }));
        return true;
      }
      const settings = typeof body.settings === 'object' && body.settings !== null
        ? (body.settings as Record<string, unknown>)
        : undefined;
      const group = await network.createGroup(body.name, settings);
      json(res, 201, withTimestamp(group));
      return true;
    }

    // IMPORTANT: must match 'groups/invitations' BEFORE 'groups/:groupId' patterns
    if (subpath === 'groups/invitations' && method === 'GET') {
      const invitations = await network.getGroupInvitations();
      json(res, 200, withTimestamp({ invitations }));
      return true;
    }

    // ── Groups with :groupId parameter ────────────────────────

    const groupActionMatch = subpath.match(/^groups\/([^/]+)\/(.+)$/);
    if (groupActionMatch) {
      const [, groupId, action] = groupActionMatch;

      // GET /api/network/groups/:groupId/members
      if (action === 'members' && method === 'GET') {
        const members = await network.getGroupMembers(groupId);
        json(res, 200, withTimestamp({ members }));
        return true;
      }

      // POST /api/network/groups/:groupId/invite
      if (action === 'invite' && method === 'POST') {
        const body = await parseBody(req);
        if (!body.agent || typeof body.agent !== 'string') {
          json(res, 400, withTimestamp({ error: 'agent is required' }));
          return true;
        }
        const greeting = typeof body.greeting === 'string' ? body.greeting : undefined;
        await network.inviteToGroup(groupId, body.agent, greeting);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }

      // POST /api/network/groups/:groupId/send (or /message — alias)
      if ((action === 'send' || action === 'message') && method === 'POST') {
        const body = await parseBody(req);
        if (!body.payload || typeof body.payload !== 'object') {
          json(res, 400, withTimestamp({ error: 'payload is required' }));
          return true;
        }
        const result = await network.sendToGroup(groupId, body.payload as Record<string, unknown>);

        // Log outbound A2A group message to the messages table for audit trail
        try {
          sendMessage({
            from: 'comms',
            to: `a2a:group:${groupId}`,
            type: 'text',
            body: JSON.stringify(body.payload),
            metadata: { channel: 'a2a', group_id: groupId, network_result: result },
          });
        } catch (err) {
          log.warn('Failed to log outbound A2A group message', { error: String(err) });
        }

        json(res, 200, withTimestamp(result));
        return true;
      }

      // POST /api/network/groups/:groupId/accept
      if (action === 'accept' && method === 'POST') {
        await network.acceptGroupInvitation(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }

      // POST /api/network/groups/:groupId/decline
      if (action === 'decline' && method === 'POST') {
        await network.declineGroupInvitation(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }

      // POST /api/network/groups/:groupId/leave
      if (action === 'leave' && method === 'POST') {
        await network.leaveGroup(groupId);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }

      // POST /api/network/groups/:groupId/transfer
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

      // DELETE /api/network/groups/:groupId/members/:agent
      const memberRemoveMatch = action.match(/^members\/(.+)$/);
      if (memberRemoveMatch && method === 'DELETE') {
        const [, agent] = memberRemoveMatch;
        await network.removeFromGroup(groupId, agent);
        json(res, 200, withTimestamp({ ok: true }));
        return true;
      }
    }

    // GET /api/network/groups/:groupId — single group details
    const groupSingleMatch = subpath.match(/^groups\/([^/]+)$/);
    if (groupSingleMatch && method === 'GET') {
      const [, groupId] = groupSingleMatch;
      const groups = await network.getGroups();
      const group = groups.find(g => g.groupId === groupId);
      if (!group) {
        json(res, 404, withTimestamp({ error: 'Group not found' }));
        return true;
      }
      json(res, 200, withTimestamp({ group }));
      return true;
    }

    // DELETE /api/network/groups/:groupId
    const groupDeleteMatch = subpath.match(/^groups\/([^/]+)$/);
    if (groupDeleteMatch && method === 'DELETE') {
      const [, groupId] = groupDeleteMatch;
      await network.dissolveGroup(groupId);
      json(res, 200, withTimestamp({ ok: true }));
      return true;
    }

    // ── Delivery tracking ──────────────────────────────────────

    if (subpath.startsWith('delivery/') && method === 'GET') {
      const messageId = subpath.slice('delivery/'.length);
      if (!messageId) {
        json(res, 400, withTimestamp({ error: 'messageId is required' }));
        return true;
      }
      const report = network.getDeliveryReport(messageId);
      if (!report) {
        json(res, 404, withTimestamp({ error: 'Delivery report not found' }));
        return true;
      }
      json(res, 200, withTimestamp(report));
      return true;
    }

    // ── Broadcasts ─────────────────────────────────────────────

    if (subpath === 'broadcasts' && method === 'GET') {
      const broadcasts = await network.checkBroadcasts();
      json(res, 200, withTimestamp({ broadcasts }));
      return true;
    }

    // No route matched
    return false;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // parseBody errors
    if (message === 'Request body too large') {
      json(res, 413, withTimestamp({ error: 'Request body too large' }));
      return true;
    }
    if (message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }

    // SDK errors -> 502
    log.error('Network API SDK error', { error: message, path: pathname, method });
    json(res, 502, withTimestamp({ error: `Network SDK error: ${message}` }));
    return true;
  }
}
