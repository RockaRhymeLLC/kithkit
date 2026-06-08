/**
 * IMAP Extension — multi-account mail integration via imapflow.
 *
 * Provides:
 * - IMAP connections to multiple named accounts
 * - HTTP endpoints for mail operations (list, get, search, folders)
 * - Health check registration
 * - Persistent connections with auto-reconnect per account
 *
 * Configuration (kithkit.config.yaml):
 *
 *   imap:
 *     enabled: true
 *     accounts:
 *       - name: icloud
 *         keychainPrefix: icloud
 *         enabled: true
 *       - name: altron
 *         keychainPrefix: altron
 *         enabled: true
 *
 * Credentials (macOS Keychain) — per account, using the keychainPrefix:
 *   credential-imap-{prefix}-email    — email address
 *   credential-imap-{prefix}-server   — IMAP server hostname
 *   credential-imap-{prefix}-port     — IMAP port (default: 993)
 *   credential-imap-{prefix}-password — App-specific password
 *
 * Backward compatibility: if no `accounts` array is configured, the extension
 * falls back to the single icloud account (keychainPrefix: 'icloud').
 */

import http from 'node:http';
import { ImapFlow } from 'imapflow';
import type { ListTreeResponse } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createLogger } from '../../core/logger.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import { readKeychain } from '../../core/keychain.js';
import type { ImapExtensionConfig, ImapAccountConfig } from '../config.js';

const log = createLogger('imap');

// ── Re-export config type for callers that import from this module ────────────

export type { ImapExtensionConfig as ImapConfig };

// ── Per-account state ─────────────────────────────────────────

interface AccountCredentials {
  email: string;
  server: string;
  port: number;
  password: string;
}

interface AccountState {
  name: string;
  keychainPrefix: string;
  client: ImapFlow | null;
  connected: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  credentials: AccountCredentials | null;
}

// ── Module-level state ────────────────────────────────────────

let _config: ImapExtensionConfig | null = null;
let _initialized = false;

/** Map of account name → AccountState */
const _accounts = new Map<string, AccountState>();

// ── Credential loading ────────────────────────────────────────

async function loadCredentials(prefix: string): Promise<AccountCredentials> {
  const [email, server, portStr, password] = await Promise.all([
    readKeychain(`credential-imap-${prefix}-email`),
    readKeychain(`credential-imap-${prefix}-server`),
    readKeychain(`credential-imap-${prefix}-port`),
    readKeychain(`credential-imap-${prefix}-password`),
  ]);

  if (!email) throw new Error(`IMAP email not found in keychain (credential-imap-${prefix}-email)`);
  if (!server) throw new Error(`IMAP server not found in keychain (credential-imap-${prefix}-server)`);
  if (!password) throw new Error(`IMAP password not found in keychain (credential-imap-${prefix}-password)`);

  const port = portStr ? parseInt(portStr, 10) : 993;
  return { email, server, port, password };
}

// ── Connection Management ─────────────────────────────────────

async function connectAccount(state: AccountState): Promise<void> {
  if (state.client) {
    try {
      state.client.close();
    } catch {
      // ignore close errors
    }
    state.client = null;
  }

  if (!state.credentials) {
    state.credentials = await loadCredentials(state.keychainPrefix);
  }

  const creds = state.credentials;

  state.client = new ImapFlow({
    host: creds.server,
    port: creds.port,
    secure: true,
    auth: {
      user: creds.email,
      pass: creds.password,
    },
    logger: false, // suppress imapflow's own logging
  });

  state.client.on('error', (err: Error) => {
    log.error('IMAP connection error', { account: state.name, error: err.message });
    state.connected = false;
    scheduleReconnect(state);
  });

  state.client.on('close', () => {
    log.warn('IMAP connection closed', { account: state.name });
    state.connected = false;
    scheduleReconnect(state);
  });

  await state.client.connect();
  state.connected = true;
  log.info('IMAP connected', { account: state.name, server: creds.server, user: creds.email });
}

function scheduleReconnect(state: AccountState, delayMs = 30_000): void {
  if (state.reconnectTimer) return; // already scheduled
  if (!_initialized) return; // shutting down

  log.info('Scheduling IMAP reconnect', { account: state.name, delayMs });
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (!_initialized) return;
    try {
      await connectAccount(state);
    } catch (err) {
      log.error('IMAP reconnect failed', {
        account: state.name,
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleReconnect(state, 60_000); // back off to 60s on repeated failure
    }
  }, delayMs);
}

async function ensureConnected(accountName: string): Promise<ImapFlow> {
  const state = _accounts.get(accountName);
  if (!state) throw new Error(`Unknown IMAP account: ${accountName}`);

  if (!state.client || !state.connected) {
    await connectAccount(state);
  }
  if (!state.client) throw new Error(`IMAP client not available for account: ${accountName}`);
  return state.client;
}

// ── Helpers ──────────────────────────────────────────────────

/** Strip HTML tags from a string, leaving plain text. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Format a MessageAddressObject array to a readable string. */
function formatAddresses(addrs: Array<{ name?: string; address?: string }> | undefined): string {
  if (!addrs || addrs.length === 0) return '';
  return addrs
    .map(a => a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? ''))
    .join(', ');
}

/** Parse a raw email buffer into structured fields. */
async function parseEmail(rawBuffer: Buffer): Promise<{
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  bodyPreview: string;
  body: string;
}> {
  const parsed = await simpleParser(rawBuffer);

  const from = parsed.from?.text ?? '';
  const to = parsed.to
    ? (Array.isArray(parsed.to) ? parsed.to.map(a => a.text).join(', ') : parsed.to.text)
    : '';
  const subject = parsed.subject ?? '(no subject)';
  const date = parsed.date ? parsed.date.toISOString() : null;

  let body = '';
  if (parsed.text) {
    body = parsed.text.trim();
  } else if (parsed.html) {
    body = stripHtml(parsed.html);
  }

  const bodyPreview = body.slice(0, 200);

  return { uid: 0, from, to, subject, date, bodyPreview, body };
}

/** Walk a ListTreeResponse tree and collect folder paths. */
function walkFolderTree(node: ListTreeResponse): Array<{ path: string; name: string; delimiter: string; flags: string[] }> {
  const results: Array<{ path: string; name: string; delimiter: string; flags: string[] }> = [];

  if (node.path) {
    results.push({
      path: node.path,
      name: node.name ?? node.path,
      delimiter: node.delimiter ?? '/',
      flags: node.flags ? [...node.flags] : [],
    });
  }

  if (node.folders) {
    for (const child of node.folders) {
      results.push(...walkFolderTree(child));
    }
  }

  return results;
}

/** Return array of enabled account names. */
function enabledAccountNames(): string[] {
  return [..._accounts.keys()];
}

/** Resolve account name from query param — returns the name if valid, or throws. */
function resolveAccount(accountParam: string | null): string {
  const names = enabledAccountNames();
  if (names.length === 0) throw new Error('No IMAP accounts configured');

  if (!accountParam) {
    // Default to first account when not specified (for single-account operations)
    return names[0];
  }

  if (!_accounts.has(accountParam)) {
    throw new Error(`Unknown IMAP account: ${accountParam}. Available: ${names.join(', ')}`);
  }
  return accountParam;
}

// ── Route Handlers ───────────────────────────────────────────

async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  const accountFilter = searchParams.get('account');

  const accountStatuses = [..._accounts.entries()]
    .filter(([name]) => !accountFilter || name === accountFilter)
    .map(([name, state]) => ({
      account: name,
      connected: state.connected,
      server: state.credentials?.server ?? null,
      email: state.credentials?.email ?? null,
    }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    enabled: _config?.enabled ?? false,
    accounts: accountStatuses,
  }));
  return true;
}

async function handleListFolders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'IMAP extension is disabled' }));
    return true;
  }

  let accountName: string;
  try {
    accountName = resolveAccount(searchParams.get('account'));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  try {
    const client = await ensureConnected(accountName);
    const tree = await client.listTree();
    const folders = walkFolderTree(tree);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ account: accountName, folders }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('IMAP list folders failed', { account: accountName, error: msg });
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
    res.end(JSON.stringify({ error: 'IMAP extension is disabled' }));
    return true;
  }

  let accountName: string;
  try {
    accountName = resolveAccount(searchParams.get('account'));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  const folder = searchParams.get('folder') ?? 'INBOX';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

  try {
    const client = await ensureConnected(accountName);

    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ account: accountName, folder, messages: [] }));
        return true;
      }

      const msgCount = mailbox.exists;
      if (msgCount === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ account: accountName, folder, messages: [] }));
        return true;
      }

      // Fetch the most recent N messages by sequence range
      const start = Math.max(1, msgCount - limit + 1);
      const range = `${start}:*`;

      const messages: Array<{
        uid: number;
        seq: number;
        from: string;
        to: string;
        subject: string;
        date: string | null;
        bodyPreview: string;
        flags: string[];
        account: string;
      }> = [];

      for await (const msg of client.fetch(range, {
        uid: true,
        flags: true,
        envelope: true,
        bodyParts: ['TEXT'],
      })) {
        const from = formatAddresses(msg.envelope?.from);
        const to = formatAddresses(msg.envelope?.to);
        const subject = msg.envelope?.subject ?? '(no subject)';
        const date = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null;

        // Get a short body preview from the TEXT body part if available
        let bodyPreview = '';
        const textPart = msg.bodyParts?.get('TEXT');
        if (textPart) {
          const text = textPart.toString().slice(0, 500);
          bodyPreview = stripHtml(text).slice(0, 200);
        }

        messages.push({
          uid: msg.uid,
          seq: msg.seq,
          from,
          to,
          subject,
          date,
          bodyPreview,
          flags: msg.flags ? [...msg.flags] : [],
          account: accountName,
        });
      }

      // Return in reverse order (newest first)
      messages.reverse();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ account: accountName, folder, messages }));
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('IMAP list messages failed', { account: accountName, error: msg, folder });
    res.writeHead(500, { 'Content-Type': 'application/json' });
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
    res.end(JSON.stringify({ error: 'IMAP extension is disabled' }));
    return true;
  }

  const match = pathname.match(/\/api\/imap\/message\/(\d+)$/);
  if (!match) return false;

  const uid = parseInt(match[1], 10);
  const folder = searchParams.get('folder') ?? 'INBOX';

  // account is required for get-message since UIDs are per-mailbox
  const accountParam = searchParams.get('account');
  if (!accountParam) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'account query parameter is required for /api/imap/message/:uid' }));
    return true;
  }

  let accountName: string;
  try {
    accountName = resolveAccount(accountParam);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  try {
    const client = await ensureConnected(accountName);
    const lock = await client.getMailboxLock(folder);

    try {
      // Download full message by UID
      const download = await client.download(`${uid}`, undefined, { uid: true });
      if (!download) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Message UID ${uid} not found in ${folder}` }));
        return true;
      }

      // Collect the stream into a buffer
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        chunks.push(chunk);
      }
      const rawBuffer = Buffer.concat(chunks);

      const parsed = await parseEmail(rawBuffer);
      parsed.uid = uid;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...parsed, account: accountName }));
    } finally {
      lock.release();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('IMAP get message failed', { account: accountName, error: msg, uid, folder });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

/** Search a single account and return tagged results. */
async function searchOneAccount(
  accountName: string,
  query: string,
  folder: string,
  limit: number,
  fromParam: string,
  subjectParam: string,
): Promise<Array<{
  uid: number;
  seq: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  bodyPreview: string;
  flags: string[];
  account: string;
}>> {
  const client = await ensureConnected(accountName);
  const lock = await client.getMailboxLock(folder);

  try {
    type SearchCriteria = Record<string, unknown>;
    const parts: SearchCriteria[] = [];

    if (query) parts.push({ text: query });
    if (fromParam) parts.push({ from: fromParam });
    if (subjectParam) parts.push({ subject: subjectParam });

    let searchCriteria: SearchCriteria;
    if (parts.length === 1) {
      searchCriteria = parts[0];
    } else {
      searchCriteria = { and: parts };
    }

    const result = await client.search(searchCriteria, { uid: true });

    if (result === false || result.length === 0) {
      return [];
    }

    const recentUids = result.slice(-limit);
    const uidRange = recentUids.join(',');

    const messages: Array<{
      uid: number;
      seq: number;
      from: string;
      to: string;
      subject: string;
      date: string | null;
      bodyPreview: string;
      flags: string[];
      account: string;
    }> = [];

    for await (const msg of client.fetch(uidRange, {
      uid: true,
      flags: true,
      envelope: true,
      bodyParts: ['TEXT'],
    }, { uid: true })) {
      const msgFrom = formatAddresses(msg.envelope?.from);
      const msgTo = formatAddresses(msg.envelope?.to);
      const msgSubject = msg.envelope?.subject ?? '(no subject)';
      const msgDate = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null;

      let bodyPreview = '';
      const textPart = msg.bodyParts?.get('TEXT');
      if (textPart) {
        const text = textPart.toString().slice(0, 500);
        bodyPreview = stripHtml(text).slice(0, 200);
      }

      messages.push({
        uid: msg.uid,
        seq: msg.seq,
        from: msgFrom,
        to: msgTo,
        subject: msgSubject,
        date: msgDate,
        bodyPreview,
        flags: msg.flags ? [...msg.flags] : [],
        account: accountName,
      });
    }

    messages.reverse();
    return messages;
  } finally {
    lock.release();
  }
}

async function handleSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (!_config?.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'IMAP extension is disabled' }));
    return true;
  }

  const query = searchParams.get('query') ?? '';
  const folder = searchParams.get('folder') ?? 'INBOX';
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
  const fromParam = searchParams.get('from') ?? '';
  const subjectParam = searchParams.get('subject') ?? '';
  const accountParam = searchParams.get('account');

  if (!query && !fromParam && !subjectParam) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'At least one of query, from, or subject is required' }));
    return true;
  }

  try {
    if (accountParam) {
      // Search a specific account
      let accountName: string;
      try {
        accountName = resolveAccount(accountParam);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return true;
      }

      const messages = await searchOneAccount(accountName, query, folder, limit, fromParam, subjectParam);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ account: accountName, folder, query, total: messages.length, messages }));
    } else {
      // Search ALL accounts and merge results
      const names = enabledAccountNames();
      const results = await Promise.allSettled(
        names.map(name => searchOneAccount(name, query, folder, limit, fromParam, subjectParam)),
      );

      const allMessages: Array<{
        uid: number;
        seq: number;
        from: string;
        to: string;
        subject: string;
        date: string | null;
        bodyPreview: string;
        flags: string[];
        account: string;
      }> = [];

      const errors: Array<{ account: string; error: string }> = [];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          allMessages.push(...r.value);
        } else {
          const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          log.error('IMAP search failed for account', { account: names[i], error: errMsg });
          errors.push({ account: names[i], error: errMsg });
        }
      }

      // Sort merged results by date descending
      allMessages.sort((a, b) => {
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date.localeCompare(a.date);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        folder,
        query,
        total: allMessages.length,
        messages: allMessages,
        ...(errors.length > 0 ? { errors } : {}),
      }));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('IMAP search failed', { error: msg, query, folder });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }
  return true;
}

// ── Route Dispatcher ─────────────────────────────────────────

async function handleImapRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (pathname === '/api/imap/status') return handleStatus(req, res, pathname, searchParams);
  if (pathname === '/api/imap/folders') return handleListFolders(req, res, pathname, searchParams);
  if (pathname === '/api/imap/messages') return handleListMessages(req, res, pathname, searchParams);
  if (pathname === '/api/imap/search') return handleSearch(req, res, pathname, searchParams);
  if (/\/api\/imap\/message\/\d+$/.test(pathname)) return handleGetMessage(req, res, pathname, searchParams);

  return false;
}

// ── Health Check ─────────────────────────────────────────────

function registerImapHealthCheck(): void {
  registerCheck('imap', () => {
    if (!_config?.enabled) {
      return { ok: true, message: 'IMAP disabled' };
    }

    const names = enabledAccountNames();
    if (names.length === 0) {
      return { ok: false, message: 'IMAP: no accounts configured' };
    }

    const statuses = names.map(name => {
      const state = _accounts.get(name)!;
      return `${name}:${state.connected ? 'ok' : 'disconnected'}`;
    });

    const allConnected = names.every(name => _accounts.get(name)!.connected);
    return {
      ok: allConnected,
      message: `IMAP accounts: ${statuses.join(', ')}`,
    };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────

/**
 * Resolve the list of account configs to initialize.
 * If no `accounts` array is present, fall back to the legacy single-account
 * icloud configuration for backward compatibility.
 */
function resolveAccountConfigs(config: ImapExtensionConfig): ImapAccountConfig[] {
  if (config.accounts && config.accounts.length > 0) {
    return config.accounts.filter(a => a.enabled);
  }

  // Backward-compat: treat as single icloud account
  log.info('IMAP: no accounts array in config — using legacy single-account icloud mode');
  return [{ name: 'icloud', keychainPrefix: 'icloud', enabled: true }];
}

/**
 * Initialize the IMAP extension.
 * Reads credentials from keychain and establishes IMAP connections for all
 * enabled accounts.
 */
export async function initImap(config: ImapExtensionConfig): Promise<void> {
  _config = config;

  if (!config.enabled) {
    log.info('IMAP extension disabled in config');
    registerImapHealthCheck();
    return;
  }

  const accountConfigs = resolveAccountConfigs(config);

  if (accountConfigs.length === 0) {
    log.warn('IMAP: no enabled accounts found — extension will be idle');
    registerImapHealthCheck();
    return;
  }

  // Initialize per-account state
  for (const ac of accountConfigs) {
    _accounts.set(ac.name, {
      name: ac.name,
      keychainPrefix: ac.keychainPrefix,
      client: null,
      connected: false,
      reconnectTimer: null,
      credentials: null,
    });
  }

  // Register routes
  registerRoute('/api/imap/*', handleImapRoute);
  registerRoute('/api/imap/status', handleImapRoute);
  registerRoute('/api/imap/folders', handleImapRoute);
  registerRoute('/api/imap/messages', handleImapRoute);
  registerRoute('/api/imap/search', handleImapRoute);

  registerImapHealthCheck();

  _initialized = true;

  // Connect all accounts in background — don't block startup
  for (const [name, state] of _accounts.entries()) {
    connectAccount(state)
      .then(() => {
        log.info('IMAP account connected', { account: name });
      })
      .catch(err => {
        log.warn('IMAP initial connection failed — will retry', {
          account: name,
          error: err instanceof Error ? err.message : String(err),
        });
        scheduleReconnect(state);
      });
  }

  log.info('IMAP extension initialized', { accounts: [..._accounts.keys()] });
}

/**
 * Shut down the IMAP extension and close all connections.
 */
export async function stopImap(): Promise<void> {
  _initialized = false;

  for (const state of _accounts.values()) {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    if (state.client) {
      try {
        await state.client.logout();
      } catch {
        // Ignore logout errors on shutdown
      }
      state.client = null;
    }

    state.connected = false;
  }

  _accounts.clear();
  log.info('IMAP extension shut down');
}
