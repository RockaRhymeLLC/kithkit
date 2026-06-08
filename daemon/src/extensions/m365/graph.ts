/**
 * M365 Graph — Microsoft Graph API client for mail operations.
 *
 * Provides typed wrappers around the Graph REST API for reading and
 * sending email. All calls go through getAccessToken() so they
 * transparently handle token refresh.
 */

import { getAccessToken } from './auth.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('m365-graph');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ── Types ────────────────────────────────────────────────────

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface Recipient {
  emailAddress: EmailAddress;
}

export interface Message {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType: 'Text' | 'HTML';
    content: string;
  };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  importance?: 'low' | 'normal' | 'high';
  hasAttachments?: boolean;
  internetMessageId?: string;
  conversationId?: string;
}

export interface MessageList {
  value: Message[];
  '@odata.nextLink'?: string;
}

export interface MailAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment';
  name: string;
  contentType: string;
  contentBytes: string;
}

export interface SendMailRequest {
  message: {
    subject: string;
    body: {
      contentType: 'Text' | 'HTML';
      content: string;
    };
    toRecipients: Recipient[];
    ccRecipients?: Recipient[];
    bccRecipients?: Recipient[];
    replyTo?: Recipient[];
    attachments?: MailAttachment[];
  };
  saveToSentItems?: boolean;
}

export interface ListMessagesOptions {
  folder?: string;      // 'inbox' | 'sentItems' | 'drafts' | folder ID
  top?: number;         // max results (default 25)
  skip?: number;        // offset for pagination
  filter?: string;      // OData filter string
  select?: string[];    // fields to include
  orderby?: string;     // e.g. 'receivedDateTime desc'
  search?: string;      // KQL search query
}

// ── Internal helpers ─────────────────────────────────────────

async function graphRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('M365: no access token available — device code login required');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // 202 Accepted and 204 No Content responses have no body (e.g. sendMail returns 202)
  if (res.status === 204 || res.status === 202) {
    return undefined as unknown as T;
  }

  // Read the body as text first so we can handle both error and success paths
  // without risking a double-read, and to guard against empty bodies.
  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Graph API ${method} ${path} failed (${res.status}): ${text}`);
  }

  // Guard against empty body — return undefined rather than crashing on JSON.parse('')
  if (!text.trim()) {
    return undefined as unknown as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Graph API ${method} ${path} returned invalid JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ── Mail operations ──────────────────────────────────────────

/**
 * List messages in a mail folder.
 * Default folder is 'inbox'.
 */
export async function listMessages(
  userEmail: string,
  opts: ListMessagesOptions = {},
): Promise<MessageList> {
  const folder = opts.folder ?? 'inbox';
  const params = new URLSearchParams();

  if (opts.top !== undefined) params.set('$top', String(opts.top));
  if (opts.skip !== undefined) params.set('$skip', String(opts.skip));
  if (opts.filter) params.set('$filter', opts.filter);
  if (opts.orderby) params.set('$orderby', opts.orderby);
  if (opts.search) params.set('$search', `"${opts.search}"`);
  if (opts.select?.length) params.set('$select', opts.select.join(','));

  // Default select fields for listing
  if (!opts.select?.length) {
    params.set('$select', 'id,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,importance,hasAttachments');
  }
  // $orderby is not compatible with $search in Graph API
  if (!opts.orderby && !opts.search) {
    params.set('$orderby', 'receivedDateTime desc');
  }

  const qs = params.toString() ? `?${params.toString()}` : '';
  // Use /me/ for delegated (device code) auth instead of /users/{email}
  const path = `/me/mailFolders/${folder}/messages${qs}`;

  log.debug('Graph: list messages', { userEmail, folder, top: opts.top });
  return graphRequest<MessageList>('GET', path);
}

/**
 * Get a single message by ID.
 */
export async function getMessage(
  userEmail: string,
  messageId: string,
  select?: string[],
): Promise<Message> {
  const params = new URLSearchParams();
  if (select?.length) params.set('$select', select.join(','));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const path = `/me/messages/${messageId}${qs}`;

  log.debug('Graph: get message', { userEmail, messageId });
  return graphRequest<Message>('GET', path);
}

/**
 * Send an email on behalf of the specified user.
 */
export async function sendMail(
  userEmail: string,
  req: SendMailRequest,
): Promise<void> {
  const path = `/me/sendMail`;
  log.info('Graph: send mail', {
    userEmail,
    subject: req.message.subject,
    to: req.message.toRecipients.map(r => r.emailAddress.address),
  });
  return graphRequest<void>('POST', path, req);
}

/**
 * Mark a message as read or unread.
 */
export async function markMessageRead(
  userEmail: string,
  messageId: string,
  isRead: boolean,
): Promise<Message> {
  const path = `/me/messages/${messageId}`;
  return graphRequest<Message>('PATCH', path, { isRead });
}

/**
 * Move a message to a different folder.
 */
export async function moveMessage(
  userEmail: string,
  messageId: string,
  destinationFolderId: string,
): Promise<Message> {
  const path = `/me/messages/${messageId}/move`;
  return graphRequest<Message>('POST', path, { destinationId: destinationFolderId });
}

/**
 * Delete a message (moves to Deleted Items).
 */
export async function deleteMessage(
  userEmail: string,
  messageId: string,
): Promise<void> {
  const path = `/me/messages/${messageId}`;
  return graphRequest<void>('DELETE', path);
}

/**
 * Reply to a message.
 */
export async function replyToMessage(
  userEmail: string,
  messageId: string,
  replyBody: string,
  contentType: 'Text' | 'HTML' = 'Text',
): Promise<void> {
  const path = `/me/messages/${messageId}/reply`;
  return graphRequest<void>('POST', path, {
    message: {
      body: { contentType, content: replyBody },
    },
    comment: replyBody,
  });
}

/**
 * Get the list of mail folders for a user.
 */
export async function listFolders(userEmail: string): Promise<{ value: Array<{ id: string; displayName: string; totalItemCount: number; unreadItemCount: number }> }> {
  const path = `/me/mailFolders?$top=50`;
  return graphRequest('GET', path);
}

// ── Calendar types ────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  location?: { displayName?: string };
  organizer?: { emailAddress: EmailAddress };
  attendees?: Array<{ emailAddress: EmailAddress; type: string; status?: { response: string } }>;
  isAllDay?: boolean;
  isCancelled?: boolean;
  webLink?: string;
  onlineMeeting?: { joinUrl?: string };
  recurrence?: unknown;
}

export interface CalendarEventList {
  value: CalendarEvent[];
  '@odata.nextLink'?: string;
}

export interface ListEventsOptions {
  top?: number;
  skip?: number;
  filter?: string;
  select?: string[];
  orderby?: string;
  startDateTime?: string;  // ISO 8601 for calendarView
  endDateTime?: string;    // ISO 8601 for calendarView
}

// ── Calendar operations ───────────────────────────────────────

const DEFAULT_EVENT_SELECT = [
  'id', 'subject', 'bodyPreview', 'start', 'end', 'location',
  'organizer', 'attendees', 'isAllDay', 'isCancelled', 'onlineMeeting',
].join(',');

/**
 * List calendar events.
 * If startDateTime and endDateTime are provided, uses /me/calendarView
 * (which expands recurring events). Otherwise uses /me/events.
 */
export async function listEvents(
  userEmail: string,
  opts: ListEventsOptions = {},
): Promise<CalendarEventList> {
  const params = new URLSearchParams();

  if (opts.top !== undefined) params.set('$top', String(opts.top));
  if (opts.skip !== undefined) params.set('$skip', String(opts.skip));
  if (opts.filter) params.set('$filter', opts.filter);
  if (opts.orderby) params.set('$orderby', opts.orderby);
  params.set('$select', opts.select?.length ? opts.select.join(',') : DEFAULT_EVENT_SELECT);

  let basePath: string;

  if (opts.startDateTime && opts.endDateTime) {
    // calendarView expands recurring events into individual occurrences
    params.set('startDateTime', opts.startDateTime);
    params.set('endDateTime', opts.endDateTime);
    basePath = '/me/calendarView';
  } else {
    basePath = '/me/events';
    if (!opts.orderby) {
      params.set('$orderby', 'start/dateTime asc');
    }
  }

  const path = `${basePath}?${params.toString()}`;
  log.debug('Graph: list events', { userEmail, basePath, top: opts.top });
  return graphRequest<CalendarEventList>('GET', path);
}

/**
 * Get a single calendar event by ID.
 */
export async function getEvent(
  userEmail: string,
  eventId: string,
  select?: string[],
): Promise<CalendarEvent> {
  const params = new URLSearchParams();
  if (select?.length) {
    params.set('$select', select.join(','));
  }
  const qs = params.toString() ? `?${params.toString()}` : '';
  const path = `/me/events/${eventId}${qs}`;

  log.debug('Graph: get event', { userEmail, eventId });
  return graphRequest<CalendarEvent>('GET', path);
}

/**
 * Convenience function — list upcoming events within the next N hours.
 * Uses calendarView so recurring events are expanded.
 */
export async function listUpcomingEvents(
  userEmail: string,
  hoursAhead: number = 24,
): Promise<CalendarEventList> {
  const now = new Date();
  const end = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  return listEvents(userEmail, {
    startDateTime: now.toISOString(),
    endDateTime: end.toISOString(),
    orderby: 'start/dateTime asc',
  });
}

// ── Teams Chat types ─────────────────────────────────────────

export interface ChatMessage {
  id: string;
  body?: { contentType: string; content: string };
  from?: { user?: { displayName?: string; id?: string } };
  createdDateTime?: string;
  messageType?: string;
}

export interface Chat {
  id: string;
  topic?: string;
  chatType?: 'oneOnOne' | 'group' | 'meeting';
  members?: Array<{ displayName?: string; email?: string; userId?: string }>;
  lastUpdatedDateTime?: string;
}

// ── Teams Chat operations ────────────────────────────────────

/**
 * List the user's recent chats.
 */
export async function listChats(
  userEmail: string,
  top: number = 50,
): Promise<{ value: Chat[] }> {
  const path = `/me/chats?$top=${top}`;
  log.debug('Graph: list chats', { userEmail, top });
  return graphRequest('GET', path);
}

/**
 * Get messages from a specific chat.
 */
export async function listChatMessages(
  userEmail: string,
  chatId: string,
  top: number = 20,
): Promise<{ value: ChatMessage[] }> {
  const path = `/me/chats/${chatId}/messages?$top=${top}`;
  log.debug('Graph: list chat messages', { userEmail, chatId, top });
  return graphRequest('GET', path);
}

// ── OneNote types ─────────────────────────────────────────────

export interface OneNoteNotebook {
  id: string;
  displayName: string;
  createdDateTime?: string;
  links?: { oneNoteClientUrl?: { href: string }; oneNoteWebUrl?: { href: string } };
}

export interface OneNoteSection {
  id: string;
  displayName: string;
  createdDateTime?: string;
}

export interface OneNotePage {
  id: string;
  title?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  parentSection?: { id: string; displayName: string };
}

// ── OneNote operations ────────────────────────────────────────

/**
 * List all OneNote notebooks for the user.
 */
export async function listNotebooks(
  userEmail: string,
): Promise<{ value: OneNoteNotebook[] }> {
  const path = '/me/onenote/notebooks';
  log.debug('Graph: list onenote notebooks', { userEmail });
  return graphRequest('GET', path);
}

/**
 * List sections in a OneNote notebook.
 */
export async function listSections(
  userEmail: string,
  notebookId: string,
): Promise<{ value: OneNoteSection[] }> {
  const path = `/me/onenote/notebooks/${encodeURIComponent(notebookId)}/sections`;
  log.debug('Graph: list onenote sections', { userEmail, notebookId });
  return graphRequest('GET', path);
}

/**
 * List pages in a OneNote section, ordered by last modified descending.
 */
export async function listPages(
  userEmail: string,
  sectionId: string,
): Promise<{ value: OneNotePage[] }> {
  const path = `/me/onenote/sections/${encodeURIComponent(sectionId)}/pages?$top=50&$orderby=lastModifiedDateTime desc`;
  log.debug('Graph: list onenote pages', { userEmail, sectionId });
  return graphRequest('GET', path);
}

/**
 * Get the HTML content of a OneNote page.
 */
export async function getPageContent(
  userEmail: string,
  pageId: string,
): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('M365: no access token available — device code login required');
  }

  const path = `/me/onenote/pages/${encodeURIComponent(pageId)}/content`;
  log.debug('Graph: get onenote page content', { userEmail, pageId });

  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/html',
    },
  });

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Graph API GET ${path} failed (${res.status}): ${text}`);
  }

  return text;
}

/**
 * Generic Graph API GET proxy — allows callers to hit any Graph endpoint.
 */
export async function graphGet<T = unknown>(path: string): Promise<T> {
  log.debug('Graph: generic GET', { path });
  return graphRequest<T>('GET', path);
}

/**
 * Get the HTML content of a OneNote page by its full self URL or by page ID
 * using an arbitrary base path (for site-scoped notebooks).
 */
export async function getPageContentByUrl(
  contentUrl: string,
): Promise<string> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('M365: no access token available — device code login required');
  }

  log.debug('Graph: get onenote page content by URL', { contentUrl });

  const url = contentUrl.startsWith('http') ? contentUrl : `${GRAPH_BASE}${contentUrl}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/html',
    },
  });

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Graph API GET ${contentUrl} failed (${res.status}): ${text}`);
  }

  return text;
}

/**
 * Search OneNote pages by keyword query.
 */
export async function searchOneNote(
  userEmail: string,
  query: string,
): Promise<{ value: OneNotePage[] }> {
  const params = new URLSearchParams({
    '$search': `"${query}"`,
    '$top': '20',
    '$select': 'id,title,createdDateTime,lastModifiedDateTime,parentSection',
  });
  const path = `/me/onenote/pages?${params.toString()}`;
  log.debug('Graph: search onenote pages', { userEmail, query });
  return graphRequest('GET', path);
}

// ── Files / OneDrive / SharePoint operations ──────────────────

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType: string };
  folder?: { childCount: number };
  parentReference?: { driveId?: string; path?: string };
  createdBy?: { user?: { displayName?: string } };
}

/**
 * Search the user's OneDrive and accessible SharePoint files.
 * Covers personal OneDrive and SharePoint files the user has access to.
 */
export async function searchDriveItems(
  userEmail: string,
  query: string,
  top: number = 25,
): Promise<DriveItem[]> {
  const select = 'id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference,createdBy';
  // Escape OData single-quote delimiters, then percent-encode the value
  const safeQuery = encodeURIComponent(query.replace(/'/g, "''"));
  const path = `/me/drive/root/search(q='${safeQuery}')?$top=${top}&$select=${select}`;
  log.debug('Graph: search drive items', { userEmail, query, top });
  const result = await graphRequest<{ value: DriveItem[] }>('GET', path);
  return result.value ?? [];
}

/**
 * Get metadata for a specific drive item by ID.
 */
export async function getDriveItem(
  userEmail: string,
  itemId: string,
): Promise<DriveItem> {
  const path = `/me/drive/items/${encodeURIComponent(itemId)}`;
  log.debug('Graph: get drive item', { userEmail, itemId });
  return graphRequest<DriveItem>('GET', path);
}

/**
 * Download the binary content of a drive item.
 * Follows the Graph API redirect to the pre-authenticated file URL.
 */
export async function downloadDriveItemContent(
  userEmail: string,
  itemId: string,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('M365: no access token available — device code login required');
  }

  const path = `/me/drive/items/${encodeURIComponent(itemId)}/content`;
  log.debug('Graph: download drive item content', { userEmail, itemId });

  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph API GET ${path} failed (${res.status}): ${text}`);
  }

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const disposition = res.headers.get('content-disposition') ?? '';
  const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
  const filename = filenameMatch?.[1]?.trim() ?? itemId;

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return { buffer, contentType, filename };
}

// ── Teams Chat operations ────────────────────────────────────

/**
 * Search Teams chats for recent messages involving a specific person.
 * Finds chats with the person, then retrieves recent messages.
 */
export async function searchChatsByPerson(
  userEmail: string,
  personEmail: string,
  daysBack: number = 10,
): Promise<ChatMessage[]> {
  const chats = await listChats(userEmail, 50);
  if (!chats.value?.length) return [];

  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const results: ChatMessage[] = [];

  // For each chat, check members and get recent messages
  for (const chat of chats.value) {
    // Skip chats not updated recently
    if (chat.lastUpdatedDateTime && new Date(chat.lastUpdatedDateTime) < cutoff) continue;

    try {
      // Get chat members to check if person is in this chat
      const membersResp = await graphRequest<{ value: Array<{ email?: string; displayName?: string }> }>(
        'GET', `/me/chats/${chat.id}/members`,
      );

      const hasPerson = membersResp.value?.some(
        m => m.email?.toLowerCase() === personEmail.toLowerCase(),
      );

      if (!hasPerson) continue;

      // Get recent messages from this chat
      const msgs = await listChatMessages(userEmail, chat.id, 15);
      for (const msg of msgs.value ?? []) {
        if (msg.createdDateTime && new Date(msg.createdDateTime) >= cutoff) {
          results.push(msg);
        }
      }
    } catch (err) {
      log.debug('Failed to read chat members/messages', { chatId: chat.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    // Limit total results
    if (results.length >= 30) break;
  }

  return results;
}
