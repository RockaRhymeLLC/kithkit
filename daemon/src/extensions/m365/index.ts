/**
 * M365 Extension — Microsoft 365 email integration via Microsoft Graph.
 *
 * Provides:
 * - OAuth 2.0 device code flow for initial authentication
 * - Automatic token refresh using persisted refresh token
 * - HTTP endpoints for mail operations (list, get, send, reply)
 * - Health check registration
 *
 * Configuration (kithkit.config.yaml):
 *
 *   m365:
 *     enabled: true
 *     agentEmail: marvbot@willservos.com
 *     scopes:
 *       - Mail.Read
 *       - Mail.Send
 *
 * Credentials (macOS Keychain):
 *   credential-m365-client-id   — Azure AD app (client) ID
 *   credential-m365-tenant-id   — Azure AD tenant ID
 *   credential-m365-refresh-token — persisted refresh token (written after login)
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createLogger } from '../../core/logger.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import { parseBody } from '../../api/helpers.js';
import {
  setScopes,
  getAccessToken,
  isAuthenticated,
  startDeviceCodeFlow,
  pollDeviceCode,
  clearTokenCache,
} from './auth.js';
import {
  listMessages,
  getMessage,
  sendMail,
  markMessageRead,
  moveMessage,
  deleteMessage,
  replyToMessage,
  listFolders,
  listEvents,
  getEvent,
  listUpcomingEvents,
  type ListMessagesOptions,
  type SendMailRequest,
  type MailAttachment,
  type ListEventsOptions,
  searchChatsByPerson,
  listNotebooks,
  listSections,
  listPages,
  getPageContent,
  getPageContentByUrl,
  graphGet,
  searchOneNote,
  searchDriveItems,
  getDriveItem,
  downloadDriveItemContent,
} from './graph.js';

const log = createLogger('m365');

// ── Config ───────────────────────────────────────────────────

export interface M365Config {
  enabled: boolean;
  agentEmail: string;
  scopes?: string[];
}

// ── State ────────────────────────────────────────────────────

let _config: M365Config | null = null;
let _initialized = false;
let _deviceCodePoll: NodeJS.Timeout | null = null;

// ── Route Handlers ───────────────────────────────────────────

async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const authed = await isAuthenticated().catch(() => false);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    enabled: _config?.enabled ?? false,
    authenticated: authed,
    agentEmail: _config?.agentEmail ?? null,
  }));
  return true;
}

async function handleDeviceCodeLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const flow = await startDeviceCodeFlow();
    log.info('M365 device code flow started', {
      userCode: flow.user_code,
      verificationUri: flow.verification_uri,
    });

    // Start polling in background
    if (_deviceCodePoll) {
      clearTimeout(_deviceCodePoll);
      _deviceCodePoll = null;
    }

    pollDeviceCode(flow.device_code, flow.interval)
      .then(() => log.info('M365 device code login completed successfully'))
      .catch(err => log.error('M365 device code polling failed', { error: String(err) }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      user_code: flow.user_code,
      verification_uri: flow.verification_uri,
      message: flow.message,
      expires_in: flow.expires_in,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 device code start failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const opts: ListMessagesOptions = {
      folder: searchParams.get('folder') ?? 'inbox',
      top: searchParams.get('top') ? Number(searchParams.get('top')) : 25,
      skip: searchParams.get('skip') ? Number(searchParams.get('skip')) : undefined,
      filter: searchParams.get('filter') ?? undefined,
      orderby: searchParams.get('orderby') ?? (searchParams.get('search') ? undefined : 'receivedDateTime desc'),
      search: searchParams.get('search') ?? undefined,
      select: searchParams.get('select')?.split(',') ?? [
        'id', 'subject', 'bodyPreview', 'from', 'toRecipients',
        'receivedDateTime', 'isRead', 'importance', 'hasAttachments',
      ],
    };

    const messages = await listMessages(_config.agentEmail, opts);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 list messages failed', { error: msg });
    res.writeHead(err instanceof Error && msg.includes('no access token') ? 401 : 500, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleGetMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  // Extract message ID from path: /api/m365/messages/:id
  const match = pathname.match(/\/api\/m365\/messages\/([^/]+)$/);
  if (!match) return false;

  const messageId = decodeURIComponent(match[1]);
  const select = searchParams.get('select')?.split(',');

  try {
    const message = await getMessage(_config.agentEmail, messageId, select);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(message));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 get message failed', { error: msg, messageId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleSendMail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const body = await parseBody(req);
    const { subject, body: msgBody, to, cc, bcc, contentType, saveToSentItems } = body as {
      subject: string;
      body: string;
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      contentType?: 'Text' | 'HTML';
      saveToSentItems?: boolean;
    };

    if (!subject || !msgBody || !to) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'subject, body, and to are required' }));
      return true;
    }

    const toArr = Array.isArray(to) ? to : [to];
    const ccArr = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccArr = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;

    const mailReq: SendMailRequest = {
      message: {
        subject,
        body: { contentType: contentType ?? 'Text', content: msgBody },
        toRecipients: toArr.map(addr => ({ emailAddress: { address: addr } })),
        ...(ccArr && { ccRecipients: ccArr.map(addr => ({ emailAddress: { address: addr } })) }),
        ...(bccArr && { bccRecipients: bccArr.map(addr => ({ emailAddress: { address: addr } })) }),
      },
      saveToSentItems: saveToSentItems ?? true,
    };

    await sendMail(_config.agentEmail, mailReq);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 send mail failed', { error: msg });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleSendMailWithAttachments(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const body = await parseBody(req);
    const {
      subject,
      body: msgBody,
      to,
      cc,
      bcc,
      contentType,
      saveToSentItems,
      attachments,
    } = body as {
      subject: string;
      body: string;
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      contentType?: 'Text' | 'HTML';
      saveToSentItems?: boolean;
      attachments?: Array<{ path: string; name?: string }>;
    };

    if (!subject || !msgBody || !to) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'subject, body, and to are required' }));
      return true;
    }

    const toArr = Array.isArray(to) ? to : [to];
    const ccArr = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccArr = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;

    // Read and base64-encode each attachment from disk
    const attachmentPayloads: MailAttachment[] = [];

    if (attachments?.length) {
      for (const att of attachments) {
        if (!att.path) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Each attachment must have a path' }));
          return true;
        }
        const fileBuffer = await readFile(att.path);
        const fileName = att.name ?? att.path.split('/').pop() ?? 'attachment';
        attachmentPayloads.push({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: fileName,
          contentType: 'application/octet-stream',
          contentBytes: fileBuffer.toString('base64'),
        });
      }
    }

    const mailReq: SendMailRequest = {
      message: {
        subject,
        body: { contentType: contentType ?? 'Text', content: msgBody },
        toRecipients: toArr.map(addr => ({ emailAddress: { address: addr } })),
        ...(ccArr && { ccRecipients: ccArr.map(addr => ({ emailAddress: { address: addr } })) }),
        ...(bccArr && { bccRecipients: bccArr.map(addr => ({ emailAddress: { address: addr } })) }),
        ...(attachmentPayloads.length > 0 && { attachments: attachmentPayloads }),
      },
      saveToSentItems: saveToSentItems ?? true,
    };

    await sendMail(_config.agentEmail, mailReq);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attachmentCount: attachmentPayloads.length }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 send mail with attachments failed', { error: msg });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleMarkRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'PATCH') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/messages\/([^/]+)\/read$/);
  if (!match) return false;

  try {
    const body = await parseBody(req);
    const { isRead } = body as { isRead?: boolean };
    const msg = await markMessageRead(_config.agentEmail, decodeURIComponent(match[1]), isRead ?? true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleMoveMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/messages\/([^/]+)\/move$/);
  if (!match) return false;

  try {
    const body = await parseBody(req);
    const { destinationFolderId } = body as { destinationFolderId?: string };
    if (!destinationFolderId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'destinationFolderId is required' }));
      return true;
    }
    const msg = await moveMessage(_config.agentEmail, decodeURIComponent(match[1]), destinationFolderId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleReply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/messages\/([^/]+)\/reply$/);
  if (!match) return false;

  try {
    const body = await parseBody(req);
    const { replyBody, contentType } = body as { replyBody?: string; contentType?: 'Text' | 'HTML' };
    if (!replyBody) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'replyBody is required' }));
      return true;
    }
    await replyToMessage(_config.agentEmail, decodeURIComponent(match[1]), replyBody, contentType ?? 'Text');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListFolders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const folders = await listFolders(_config.agentEmail);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(folders));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListCalendar(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const opts: ListEventsOptions = {
      top: searchParams.get('top') ? Number(searchParams.get('top')) : 25,
      startDateTime: searchParams.get('startDateTime') ?? undefined,
      endDateTime: searchParams.get('endDateTime') ?? undefined,
      filter: searchParams.get('filter') ?? undefined,
    };

    const events = await listEvents(_config.agentEmail, opts);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 list calendar events failed', { error: msg });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleUpcomingEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const hours = searchParams.get('hours') ? Number(searchParams.get('hours')) : 24;
    const events = await listUpcomingEvents(_config.agentEmail, hours);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 upcoming events failed', { error: msg });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleGetCalendarEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  // Extract event ID from path: /api/m365/calendar/event/:id
  const match = pathname.match(/\/api\/m365\/calendar\/event\/([^/]+)$/);
  if (!match) return false;

  const eventId = decodeURIComponent(match[1]);
  const select = searchParams.get('select')?.split(',');

  try {
    const event = await getEvent(_config.agentEmail, eventId, select);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(event));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 get calendar event failed', { error: msg, eventId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleTeamsChatSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const personEmail = searchParams.get('person');
  if (!personEmail) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'person (email) query param is required' }));
    return true;
  }

  try {
    const daysBack = searchParams.get('days') ? Number(searchParams.get('days')) : 10;
    const messages = await searchChatsByPerson(_config.agentEmail, personEmail, daysBack);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages, count: messages.length }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Teams chat search failed', { error: msg, personEmail });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * POST /api/m365/calendar/schedule — Check free/busy for one or more users.
 * Body: { schedules: string[], startTime: string, endTime: string, timeZone?: string }
 */
async function handleGetSchedule(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const token = await getAccessToken();
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 not authenticated' }));
    return true;
  }

  try {
    const body = await parseBody(req) as {
      schedules: string[];
      startTime: string;
      endTime: string;
      timeZone?: string;
      availabilityViewInterval?: number;
    };

    if (!body.schedules?.length || !body.startTime || !body.endTime) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'schedules, startTime, and endTime are required' }));
      return true;
    }

    const tz = body.timeZone ?? 'America/Chicago';
    const graphResp = await fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': `outlook.timezone="${tz}"`,
      },
      body: JSON.stringify({
        schedules: body.schedules,
        startTime: { dateTime: body.startTime, timeZone: tz },
        endTime: { dateTime: body.endTime, timeZone: tz },
        availabilityViewInterval: body.availabilityViewInterval ?? 30,
      }),
    });

    const data = await graphResp.json();
    if (!graphResp.ok) {
      res.writeHead(graphResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: data }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('getSchedule failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * POST /api/m365/calendar/create — Create a calendar event with attendees.
 */
async function handleCreateCalendarEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const token = await getAccessToken();
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 not authenticated' }));
    return true;
  }

  try {
    const body = await parseBody(req) as {
      subject: string;
      startDateTime: string;
      endDateTime: string;
      timeZone?: string;
      attendees?: string[];
      body?: string;
      location?: string;
      isOnlineMeeting?: boolean;
    };

    if (!body.subject || !body.startDateTime || !body.endDateTime) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'subject, startDateTime, and endDateTime are required' }));
      return true;
    }

    const tz = body.timeZone ?? 'America/New_York';
    const eventPayload: Record<string, unknown> = {
      subject: body.subject,
      start: { dateTime: body.startDateTime, timeZone: tz },
      end: { dateTime: body.endDateTime, timeZone: tz },
      isOnlineMeeting: body.isOnlineMeeting ?? true,
      onlineMeetingProvider: 'teamsForBusiness',
    };

    if (body.body) {
      eventPayload.body = { contentType: 'Text', content: body.body };
    }
    if (body.location) {
      eventPayload.location = { displayName: body.location };
    }
    if (body.attendees?.length) {
      eventPayload.attendees = body.attendees.map(addr => ({
        emailAddress: { address: addr },
        type: 'required',
      }));
    }

    const graphResp = await fetch('https://graph.microsoft.com/v1.0/me/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventPayload),
    });

    const data = await graphResp.json();
    if (!graphResp.ok) {
      res.writeHead(graphResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: data }));
      return true;
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('createCalendarEvent failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * POST /api/m365/calendar/update — Update an existing calendar event.
 * Body: { eventId, subject?, startDateTime?, endDateTime?, timeZone?, attendees?, body?, location?, isOnlineMeeting? }
 */
async function handleUpdateCalendarEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const token = await getAccessToken();
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 not authenticated' }));
    return true;
  }

  try {
    const body = await parseBody(req) as {
      eventId: string;
      subject?: string;
      startDateTime?: string;
      endDateTime?: string;
      timeZone?: string;
      attendees?: (string | { email: string; name?: string })[];
      body?: string;
      location?: string;
      isOnlineMeeting?: boolean;
    };

    if (!body.eventId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'eventId is required' }));
      return true;
    }

    const tz = body.timeZone ?? 'America/New_York';
    const eventPayload: Record<string, unknown> = {};

    if (body.subject !== undefined) {
      eventPayload.subject = body.subject;
    }
    if (body.startDateTime !== undefined) {
      eventPayload.start = { dateTime: body.startDateTime, timeZone: tz };
    }
    if (body.endDateTime !== undefined) {
      eventPayload.end = { dateTime: body.endDateTime, timeZone: tz };
    }
    if (body.isOnlineMeeting !== undefined) {
      eventPayload.isOnlineMeeting = body.isOnlineMeeting;
    }
    if (body.body !== undefined) {
      eventPayload.body = { contentType: 'Text', content: body.body };
    }
    if (body.location !== undefined) {
      eventPayload.location = { displayName: body.location };
    }
    if (body.attendees?.length) {
      eventPayload.attendees = body.attendees.map(a => {
        if (typeof a === 'string') {
          return { emailAddress: { address: a }, type: 'required' };
        }
        return {
          emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
          type: 'required',
        };
      });
    }

    const graphResp = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(body.eventId)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventPayload),
    });

    const data = await graphResp.json();
    if (!graphResp.ok) {
      res.writeHead(graphResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: data }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('updateCalendarEvent failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * POST /api/m365/calendar/delete — Delete a calendar event.
 * Body: { eventId }
 */
async function handleDeleteCalendarEvent(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  const token = await getAccessToken();
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 not authenticated' }));
    return true;
  }

  try {
    const body = await parseBody(req) as { eventId: string };

    if (!body.eventId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'eventId is required' }));
      return true;
    }

    const graphResp = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(body.eventId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!graphResp.ok) {
      const data = await graphResp.json().catch(() => ({}));
      res.writeHead(graphResp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: data }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('deleteCalendarEvent failed', { error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * GET /api/m365/graph?path=/sites — Read-only Graph API proxy for ad-hoc queries.
 */
async function handleGraphProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  const token = await getAccessToken();
  if (!token) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 not authenticated' }));
    return true;
  }

  const graphPath = searchParams.get('path');
  if (!graphPath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ?path= parameter' }));
    return true;
  }

  try {
    const graphResp = await fetch(`https://graph.microsoft.com/v1.0${graphPath}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await graphResp.json();
    res.writeHead(graphResp.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Graph proxy error', { path: graphPath, error: msg });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

// ── OneNote Route Handlers ────────────────────────────────────

async function handleListNotebooks(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  try {
    const notebooks = await listNotebooks(_config.agentEmail);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(notebooks));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 list notebooks failed', { error: msg });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListSections(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/onenote\/notebooks\/([^/]+)\/sections$/);
  if (!match) return false;

  const notebookId = decodeURIComponent(match[1]);

  try {
    const sections = await listSections(_config.agentEmail, notebookId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sections));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 list sections failed', { error: msg, notebookId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleListPages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/onenote\/sections\/([^/]+)\/pages$/);
  if (!match) return false;

  const sectionId = decodeURIComponent(match[1]);

  try {
    const pages = await listPages(_config.agentEmail, sectionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pages));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 list pages failed', { error: msg, sectionId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleGetPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/onenote\/pages\/([^/]+)$/);
  if (!match) return false;

  const pageId = decodeURIComponent(match[1]);

  try {
    const content = await getPageContent(_config.agentEmail, pageId);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 get page content failed', { error: msg, pageId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleSearchOneNote(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const query = searchParams.get('q');
  if (!query) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'q (search query) param is required' }));
    return true;
  }

  try {
    const results = await searchOneNote(_config.agentEmail, query);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(results));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 search onenote failed', { error: msg, query });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleSearchFiles(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const query = searchParams.get('q');
  if (!query) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'q (search query) param is required' }));
    return true;
  }

  const top = Math.min(Number(searchParams.get('top') ?? '25'), 100);

  try {
    const results = await searchDriveItems(_config.agentEmail, query, top);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: results }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 search files failed', { error: msg, query });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleGetFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/files\/([^/]+)$/);
  const itemId = match?.[1];
  if (!itemId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'item ID missing from path' }));
    return true;
  }

  try {
    const item = await getDriveItem(_config.agentEmail, decodeURIComponent(itemId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(item));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 get file failed', { error: msg, itemId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

async function handleDownloadFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'M365 extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/m365\/files\/([^/]+)\/content$/);
  const itemId = match?.[1];
  if (!itemId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'item ID missing from path' }));
    return true;
  }

  try {
    const { buffer, contentType, filename } = await downloadDriveItemContent(
      _config.agentEmail,
      decodeURIComponent(itemId),
    );
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '\\"')}"`,
    });
    res.end(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('M365 download file failed', { error: msg, itemId });
    res.writeHead(msg.includes('no access token') ? 401 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/**
 * Unified dispatcher for /api/m365/* routes.
 * Matches specific sub-paths and delegates to handler functions.
 */
async function handleM365Route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  // Status / auth
  if (pathname === '/api/m365/status') return handleStatus(req, res);
  if (pathname === '/api/m365/login') return handleDeviceCodeLogin(req, res);

  // Graph proxy (read-only)
  if (pathname === '/api/m365/graph') return handleGraphProxy(req, res, pathname, searchParams);

  // Folders
  if (pathname === '/api/m365/folders') return handleListFolders(req, res);

  // Teams chat
  if (pathname === '/api/m365/chats/search') return handleTeamsChatSearch(req, res, pathname, searchParams);

  // OneNote (order matters — more specific patterns first)
  if (pathname === '/api/m365/onenote/search') return handleSearchOneNote(req, res, pathname, searchParams);
  if (pathname === '/api/m365/onenote/notebooks') return handleListNotebooks(req, res);
  if (/\/api\/m365\/onenote\/notebooks\/[^/]+\/sections$/.test(pathname)) return handleListSections(req, res, pathname);
  if (/\/api\/m365\/onenote\/sections\/[^/]+\/pages$/.test(pathname)) return handleListPages(req, res, pathname);
  if (/\/api\/m365\/onenote\/pages\/[^/]+$/.test(pathname)) return handleGetPage(req, res, pathname);

  // Files / OneDrive / SharePoint (order matters — more specific patterns first)
  if (pathname === '/api/m365/files/search') return handleSearchFiles(req, res, pathname, searchParams);
  if (/\/api\/m365\/files\/[^/]+\/content$/.test(pathname)) return handleDownloadFile(req, res, pathname);
  if (/\/api\/m365\/files\/[^/]+$/.test(pathname)) return handleGetFile(req, res, pathname);

  // Calendar (order matters — more specific patterns first)
  if (pathname === '/api/m365/calendar/schedule') return handleGetSchedule(req, res);
  if (pathname === '/api/m365/calendar/create') return handleCreateCalendarEvent(req, res);
  if (pathname === '/api/m365/calendar/update') return handleUpdateCalendarEvent(req, res);
  if (pathname === '/api/m365/calendar/delete') return handleDeleteCalendarEvent(req, res);
  if (pathname === '/api/m365/calendar/upcoming') return handleUpcomingEvents(req, res, pathname, searchParams);
  if (/\/api\/m365\/calendar\/event\/[^/]+$/.test(pathname)) return handleGetCalendarEvent(req, res, pathname, searchParams);
  if (pathname === '/api/m365/calendar') return handleListCalendar(req, res, pathname, searchParams);

  // Messages list
  if (pathname === '/api/m365/messages') return handleListMessages(req, res, pathname, searchParams);

  // Send mail
  if (pathname === '/api/m365/send') return handleSendMail(req, res);
  if (pathname === '/api/m365/send-with-attachments') return handleSendMailWithAttachments(req, res);

  // Per-message actions (order matters — more specific patterns first)
  if (/\/api\/m365\/messages\/[^/]+\/read$/.test(pathname)) return handleMarkRead(req, res, pathname);
  if (/\/api\/m365\/messages\/[^/]+\/move$/.test(pathname)) return handleMoveMessage(req, res, pathname);
  if (/\/api\/m365\/messages\/[^/]+\/reply$/.test(pathname)) return handleReply(req, res, pathname);
  if (/\/api\/m365\/messages\/[^/]+$/.test(pathname)) return handleGetMessage(req, res, pathname, searchParams);

  return false;
}

// ── Health Check ─────────────────────────────────────────────

function registerM365HealthCheck(): void {
  registerCheck('m365', () => {
    if (!_config?.enabled) {
      return { ok: true, message: 'M365 disabled' };
    }
    getAccessToken()
      .then(t => t !== null)
      .catch(() => false);
    // Synchronous check — just report config state; token state is async
    return {
      ok: _initialized,
      message: _initialized
        ? `M365 enabled (${_config.agentEmail})`
        : 'M365 not initialized',
    };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────

/**
 * Initialize the M365 extension.
 * Registers routes and attempts token refresh from keychain.
 */
export async function initM365(config: M365Config): Promise<void> {
  _config = config;

  if (!config.enabled) {
    log.info('M365 extension disabled in config');
    registerM365HealthCheck();
    return;
  }

  // Configure scopes from config (with fallback defaults)
  const scopes = config.scopes ?? ['Mail.Read', 'Mail.Send'];
  setScopes(scopes);

  // Register all /api/m365/* routes under a wildcard
  registerRoute('/api/m365/*', handleM365Route);
  // Also register exact matches for paths without trailing segments
  registerRoute('/api/m365/status', handleM365Route);
  registerRoute('/api/m365/login', handleM365Route);
  registerRoute('/api/m365/messages', handleM365Route);
  registerRoute('/api/m365/send', handleM365Route);
  registerRoute('/api/m365/send-with-attachments', handleM365Route);
  registerRoute('/api/m365/folders', handleM365Route);
  registerRoute('/api/m365/calendar', handleM365Route);
  registerRoute('/api/m365/calendar/upcoming', handleM365Route);
  registerRoute('/api/m365/onenote/notebooks', handleM365Route);
  registerRoute('/api/m365/onenote/search', handleM365Route);
  registerRoute('/api/m365/files/search', handleM365Route);

  registerM365HealthCheck();

  // Attempt background token refresh (non-blocking — login may be needed)
  getAccessToken()
    .then(token => {
      if (token) {
        log.info('M365 authenticated via keychain refresh token');
      } else {
        log.warn('M365 not authenticated — POST /api/m365/login to initiate device code flow');
      }
    })
    .catch(err => {
      log.warn('M365 token check failed', { error: err instanceof Error ? err.message : String(err) });
    });

  _initialized = true;
  log.info('M365 extension initialized', {
    agentEmail: config.agentEmail,
    scopes,
  });
}

/**
 * Shut down the M365 extension and clear cached token state.
 */
export function stopM365(): void {
  if (_deviceCodePoll) {
    clearTimeout(_deviceCodePoll);
    _deviceCodePoll = null;
  }
  clearTokenCache();
  _initialized = false;
  log.info('M365 extension shut down');
}
