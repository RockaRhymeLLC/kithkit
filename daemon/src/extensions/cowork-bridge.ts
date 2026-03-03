/**
 * Cowork Bridge — WebSocket server for the cowork Chrome extension.
 *
 * Attaches to the daemon's existing HTTP server via the `upgrade` event.
 * Uses the `ws` library for standards-compliant WebSocket handshake and framing,
 * which is required for Cloudflare tunnel compatibility.
 * Also exposes REST API routes for HTTP-based CDP access.
 */

import http from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogger } from '../core/logger.js';
import {
  generateToken,
  generateEphemeralKeyPair,
  computeSharedSecret,
  deriveSessionKey,
  encryptEnvelope,
  decryptEnvelope,
  computeFingerprint,
  type EphemeralKeyPair,
  type EncryptedEnvelope,
} from './cowork-crypto.js';

const log = createLogger('cowork-bridge');

// Auth timeout: 5 seconds to send valid auth message
const AUTH_TIMEOUT_MS = 5_000;

// ── Types ────────────────────────────────────────────────────

interface CoworkSession {
  ws: WebSocket;
  connectedAt: Date;
  lastActivity: Date;
  userAgent?: string;
  authenticated: boolean;
  authTimer?: NodeJS.Timeout;
  // Key exchange state
  keyExchangeState: 'pending' | 'awaiting-hello' | 'complete' | null;
  sessionKey: Buffer | null;
  sendSeq: number;
  recvSeq: number;
  daemonKeyPair: EphemeralKeyPair | null;
  extensionPubKeyB64: string | null;
}

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// ── Module State ─────────────────────────────────────────────

let activeSession: CoworkSession | null = null;
const pendingCommands = new Map<number, PendingCommand>();
let nextCommandId = 1;

// Auth state
let authToken: string | null = null;
let pskHex: string | null = null;

// WebSocketServer instance (noServer mode)
let wss: WebSocketServer | null = null;

// ── Auth State Accessors ──────────────────────────────────────

/** Set the auth token (called by extension init after loading from DB). */
export function setAuthToken(token: string): void {
  authToken = token;
}

/** Set the PSK (called by extension init after loading from DB/Keychain). */
export function setPsk(psk: string): void {
  pskHex = psk;
}

/** Get the current PSK (for key exchange). */
export function getPsk(): string | null {
  return pskHex;
}

/** Get the current auth token. */
export function getAuthToken(): string | null {
  return authToken;
}

// ── WebSocket Send Helpers ────────────────────────────────────

/**
 * Send a message to the active session, encrypting it if key exchange is complete.
 * Manages the send sequence counter automatically.
 */
function sendMessage(session: CoworkSession, message: unknown): void {
  if (session.ws.readyState !== WebSocket.OPEN) return;
  if (session.keyExchangeState === 'complete' && session.sessionKey) {
    session.sendSeq += 1;
    const envelope = encryptEnvelope(session.sessionKey, message, session.sendSeq);
    session.ws.send(JSON.stringify(envelope));
  } else {
    session.ws.send(JSON.stringify(message));
  }
}

// ── Session Close Helpers ─────────────────────────────────────

/**
 * Close the WebSocket with a numeric status code and reason.
 * Clears the active session if it matches.
 */
function closeWithCode(session: CoworkSession, code: number, reason: string): void {
  try {
    session.ws.close(code, reason);
  } catch {
    // Socket may already be gone
  }

  if (session === activeSession) {
    activeSession = null;
  }
  rejectAllPending(reason);
}

// ── Key Exchange ──────────────────────────────────────────────

function handleKeyExchange(session: CoworkSession, msg: unknown): void {
  if (!msg || typeof msg !== 'object') {
    closeWithCode(session, 4001, 'Key exchange failed: invalid message');
    return;
  }

  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'key-exchange' || typeof m['publicKey'] !== 'string') {
    closeWithCode(session, 4001, 'Key exchange failed: expected key-exchange message');
    return;
  }

  const currentPsk = getPsk();
  if (!currentPsk) {
    log.warn('Cowork key exchange attempted but no PSK configured');
    closeWithCode(session, 4001, 'Key exchange failed: no PSK configured');
    return;
  }

  const extensionPubKeyB64 = m['publicKey'] as string;

  // Generate daemon ephemeral keypair
  const daemonKeyPair = generateEphemeralKeyPair();

  // Compute shared secret and derive session key
  let sharedSecret: Buffer;
  try {
    sharedSecret = computeSharedSecret(daemonKeyPair.privateKey, extensionPubKeyB64);
  } catch (err) {
    log.error('Key exchange: failed to compute shared secret', { error: String(err) });
    closeWithCode(session, 4001, 'Key exchange failed: invalid public key');
    return;
  }

  const sessionKey = deriveSessionKey(
    sharedSecret,
    currentPsk,
    extensionPubKeyB64,
    daemonKeyPair.publicKeyB64,
  );

  // Store state
  session.daemonKeyPair = daemonKeyPair;
  session.extensionPubKeyB64 = extensionPubKeyB64;
  session.sessionKey = sessionKey;
  session.keyExchangeState = 'awaiting-hello';

  // Send back daemon public key (unencrypted — key exchange messages are always plaintext)
  session.ws.send(JSON.stringify({
    type: 'key-exchange',
    publicKey: daemonKeyPair.publicKeyB64,
  }));

  log.info('Cowork key exchange: sent daemon public key, awaiting hello');
}

function handleEncryptedHello(session: CoworkSession, envelope: EncryptedEnvelope): void {
  if (!session.sessionKey) {
    closeWithCode(session, 4001, 'Key exchange failed: no session key');
    return;
  }

  // Update recv seq
  const expectedSeq = session.recvSeq + 1;
  if (envelope.seq !== expectedSeq) {
    log.warn('Cowork hello: sequence violation', { got: envelope.seq, expected: expectedSeq });
    closeWithCode(session, 4003, 'Sequence violation');
    return;
  }
  session.recvSeq = envelope.seq;

  // Decrypt
  let inner: unknown;
  try {
    inner = decryptEnvelope(session.sessionKey, envelope);
  } catch (err) {
    log.error('Cowork hello: decryption failed', { error: String(err) });
    closeWithCode(session, 4002, 'Decryption failed');
    return;
  }

  const m = inner as Record<string, unknown>;
  if (!m || m['type'] !== 'hello') {
    closeWithCode(session, 4001, 'Key exchange failed: expected hello');
    return;
  }

  // Store userAgent if present
  if (typeof m['userAgent'] === 'string') {
    session.userAgent = m['userAgent'];
  }

  // Mark encryption complete
  session.keyExchangeState = 'complete';

  // Send encrypted hello-ack
  sendMessage(session, { type: 'hello-ack' });

  log.info('Cowork key exchange complete — session encrypted', { userAgent: session.userAgent });
}

// ── Message Handling ─────────────────────────────────────────

function handleAuthMessage(msg: unknown): void {
  if (!activeSession) return;

  if (!msg || typeof msg !== 'object') {
    closeWithCode(activeSession, 4000, 'Authentication failed');
    return;
  }

  const m = msg as Record<string, unknown>;
  if (m['type'] !== 'auth' || typeof m['token'] !== 'string') {
    closeWithCode(activeSession, 4000, 'Authentication failed');
    return;
  }

  if (!authToken || m['token'] !== authToken) {
    log.warn('Cowork auth failed: invalid token');
    closeWithCode(activeSession, 4000, 'Authentication failed');
    return;
  }

  // Auth succeeded
  activeSession.authenticated = true;
  if (activeSession.authTimer) {
    clearTimeout(activeSession.authTimer);
    activeSession.authTimer = undefined;
  }

  log.info('Cowork session authenticated');

  // Send auth-ok so extension knows to proceed to key exchange
  activeSession.ws.send(JSON.stringify({ type: 'auth-ok' }));

  // Begin key exchange phase — next message must be key-exchange
  activeSession.keyExchangeState = 'pending';
}

function handleIncomingMessage(data: string): void {
  if (!activeSession) return;
  activeSession.lastActivity = new Date();

  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch (err) {
    log.error('Invalid cowork message (not JSON)', { error: String(err) });
    return;
  }

  // Auth gate: if not yet authenticated, first message must be auth
  if (!activeSession.authenticated) {
    if (!authToken) {
      // No token configured — auto-authenticate and proceed to key exchange
      activeSession.authenticated = true;
      if (activeSession.authTimer) {
        clearTimeout(activeSession.authTimer);
        activeSession.authTimer = undefined;
      }
      // Since no auth token, skip key exchange and handle message directly
      handleMessage(msg);
    } else {
      handleAuthMessage(msg);
    }
    return;
  }

  // Key exchange gate
  const session = activeSession;
  const state = session.keyExchangeState;
  const msgType = msg && typeof msg === 'object'
    ? (msg as Record<string, unknown>)['type']
    : undefined;

  // If we receive a key-exchange message in any non-complete state,
  // route it to handleKeyExchange (which will fail gracefully if no PSK).
  if (msgType === 'key-exchange' && state !== 'complete') {
    handleKeyExchange(session, msg);
    return;
  }

  if (state === 'pending') {
    // Expecting key-exchange message (already handled above)
    closeWithCode(session, 4001, 'Key exchange failed: expected key-exchange message');
    return;
  }

  if (state === 'awaiting-hello') {
    // Expecting encrypted hello envelope
    const m = msg as Record<string, unknown>;
    if (!m || m['type'] !== 'encrypted') {
      closeWithCode(session, 4001, 'Key exchange failed: expected encrypted envelope');
      return;
    }
    handleEncryptedHello(session, msg as unknown as EncryptedEnvelope);
    return;
  }

  if (state === 'complete') {
    // All messages must be encrypted envelopes
    const m = msg as Record<string, unknown>;
    if (!m || m['type'] !== 'encrypted') {
      closeWithCode(session, 4002, 'Expected encrypted envelope');
      return;
    }
    const envelope = msg as unknown as EncryptedEnvelope;

    // Validate sequence
    const expectedSeq = session.recvSeq + 1;
    if (envelope.seq !== expectedSeq) {
      log.warn('Cowork sequence violation', { got: envelope.seq, expected: expectedSeq });
      closeWithCode(session, 4003, 'Sequence violation');
      return;
    }
    session.recvSeq = envelope.seq;

    // Decrypt
    let inner: unknown;
    try {
      inner = decryptEnvelope(session.sessionKey!, envelope);
    } catch (err) {
      log.error('Cowork decryption failed', { error: String(err) });
      closeWithCode(session, 4002, 'Decryption failed');
      return;
    }

    handleMessage(inner);
    return;
  }

  // No key exchange state (keyExchangeState === null) — plaintext messages allowed
  handleMessage(msg);
}

function handleMessage(msg: unknown): void {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;

  switch (m['type']) {
    case 'hello':
      if (activeSession) {
        activeSession.userAgent = typeof m['userAgent'] === 'string' ? m['userAgent'] : undefined;
      }
      log.info('Cowork hello', { userAgent: activeSession?.userAgent });
      break;

    case 'cdp-result':
    case 'cdp-error': {
      const id = typeof m['id'] === 'number' ? m['id'] : -1;
      const pending = pendingCommands.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCommands.delete(id);
        if (m['type'] === 'cdp-result') {
          pending.resolve(m['result']);
        } else {
          const errMsg = m['error'] && typeof m['error'] === 'object'
            ? String((m['error'] as Record<string, unknown>)['message'] ?? 'CDP error')
            : 'CDP error';
          pending.reject(new Error(errMsg));
        }
      }
      break;
    }

    case 'tab-list': {
      const id = typeof m['id'] === 'number' ? m['id'] : -1;
      const pending = pendingCommands.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCommands.delete(id);
        pending.resolve(m['tabs']);
      }
      break;
    }

    case 'tab-switched': {
      const id = typeof m['id'] === 'number' ? m['id'] : -1;
      const pending = pendingCommands.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCommands.delete(id);
        pending.resolve({ tabId: m['tabId'] });
      }
      break;
    }

    case 'tab-changed':
      log.debug('Tab changed', {
        tabId: String(m['tabId'] ?? ''),
        title: String(m['title'] ?? ''),
        url: String(m['url'] ?? ''),
      });
      break;

    case 'debugger-detached':
      log.info('Debugger detached', {
        tabId: String(m['tabId'] ?? ''),
        reason: String(m['reason'] ?? 'unknown'),
      });
      break;

    case 'pong':
      break;

    default:
      log.warn('Unknown cowork message type', { type: String(m['type'] ?? 'undefined') });
  }
}

// ── Session Lifecycle ─────────────────────────────────────────

function closeSession(session: CoworkSession): void {
  if (session.authTimer) {
    clearTimeout(session.authTimer);
    session.authTimer = undefined;
  }
  try {
    session.ws.close(1000);
  } catch {
    // Socket may already be gone
  }
}

function rejectAllPending(reason: string): void {
  for (const [_id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  pendingCommands.clear();
}

// ── HTTP Upgrade Handler ──────────────────────────────────────

export function initCoworkBridge(server: http.Server): void {
  // Create a ws WebSocketServer in noServer mode — we handle upgrade routing ourselves
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    // Only claim /cowork — let other upgrade handlers through
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/cowork') return;

    log.info('Cowork upgrade request', {
      url: req.url,
      key: req.headers['sec-websocket-key'] || 'MISSING',
      version: req.headers['sec-websocket-version'],
      extensions: req.headers['sec-websocket-extensions'] || 'none',
      origin: req.headers['origin'] || 'none',
      host: req.headers['host'] || 'none',
    });

    // Delegate the handshake to the ws library for standards-compliant 101 response
    wss!.handleUpgrade(req, socket, head, (ws) => {
      log.info('Cowork WebSocket upgrade complete (ws library handshake)');

      // Close existing session if present
      if (activeSession) {
        log.info('New cowork connection replacing existing session');
        closeSession(activeSession);
        rejectAllPending('Connection replaced');
        activeSession = null;
      }

      // If no auth token is configured, start session as already-authenticated
      activeSession = {
        ws,
        connectedAt: new Date(),
        lastActivity: new Date(),
        authenticated: !authToken,
        // Key exchange state — null means no key exchange (no PSK configured or auth-less)
        keyExchangeState: null,
        sessionKey: null,
        sendSeq: 0,
        recvSeq: 0,
        daemonKeyPair: null,
        extensionPubKeyB64: null,
      };

      // Only start auth timer when a token is configured
      if (authToken) {
        activeSession.authTimer = setTimeout(() => {
          if (activeSession && !activeSession.authenticated) {
            log.warn('Cowork auth timeout');
            closeWithCode(activeSession, 4000, 'Authentication timeout');
          }
        }, AUTH_TIMEOUT_MS);
      }

      log.info('Cowork session connected');

      // If no auth token, session is auto-authenticated — but still start key exchange
      // if a PSK is configured.
      if (!authToken && pskHex) {
        activeSession.keyExchangeState = 'pending';
      }

      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // ws delivers data as Buffer by default
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString('utf-8')
          : Buffer.from(data as Buffer).toString('utf-8');
        handleIncomingMessage(text);
      });

      ws.on('close', () => {
        log.info('Cowork session disconnected');
        if (activeSession?.ws === ws) {
          if (activeSession.authTimer) {
            clearTimeout(activeSession.authTimer);
            activeSession.authTimer = undefined;
          }
          activeSession = null;
        }
        rejectAllPending('Connection closed');
      });

      ws.on('error', (err: Error) => {
        log.error('Cowork socket error', { error: err.message });
      });
    });
  });
}

// ── REST API Route Handler ────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  // Check for pre-buffered body from main.ts metrics middleware
  const rawBody = (req as unknown as Record<string, unknown>)._rawBody;
  if (rawBody instanceof Buffer) {
    return Promise.resolve(rawBody.toString());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function handleCoworkRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  // GET /api/cowork/status
  if (req.method === 'GET' && pathname === '/api/cowork/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCoworkStatus()));
    return true;
  }

  // GET /api/cowork/fingerprint
  if (req.method === 'GET' && pathname === '/api/cowork/fingerprint') {
    if (!activeSession || !activeSession.daemonKeyPair) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session or keypair' }));
      return true;
    }
    const fingerprint = computeFingerprint(activeSession.daemonKeyPair.publicKeyB64);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fingerprint }));
    return true;
  }

  // GET /api/cowork/tabs
  if (req.method === 'GET' && pathname === '/api/cowork/tabs') {
    try {
      const tabs = await listTabs();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tabs }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // POST /api/cowork/cdp — send a CDP command via the extension
  if (req.method === 'POST' && pathname === '/api/cowork/cdp') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const method = parsed['method'];
      if (!method || typeof method !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method is required' }));
        return true;
      }
      const params = (parsed['params'] && typeof parsed['params'] === 'object')
        ? parsed['params'] as Record<string, unknown>
        : {};
      const result = await sendCdpCommand(method, params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return true;
  }

  // POST /api/cowork/psk — accept a user-supplied PSK and store it
  if (req.method === 'POST' && pathname === '/api/cowork/psk') {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const suppliedPsk = parsed['psk'];
      if (!suppliedPsk || typeof suppliedPsk !== 'string' || !/^[0-9a-fA-F]{64}$/.test(suppliedPsk)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'psk must be a 64-character hex string (256 bits)' }));
        return true;
      }
      pskHex = suppliedPsk;

      // Store in Keychain
      try {
        const { execFileSync } = await import('node:child_process');
        try {
          execFileSync('security', ['delete-generic-password', '-s', 'credential-cowork-psk'], { encoding: 'utf-8' });
        } catch { /* may not exist */ }
        execFileSync('security', ['add-generic-password', '-s', 'credential-cowork-psk', '-a', 'kithkit', '-w', suppliedPsk], { encoding: 'utf-8' });
      } catch (err) {
        log.warn('Failed to store PSK in Keychain', { error: String(err) });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
    return true;
  }

  // POST /api/cowork/generate-psk — generate a new PSK and store in Keychain
  if (req.method === 'POST' && pathname === '/api/cowork/generate-psk') {
    const newPsk = generateToken(); // 256-bit hex
    pskHex = newPsk;

    // Store in Keychain
    try {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('security', ['delete-generic-password', '-s', 'credential-cowork-psk'], { encoding: 'utf-8' });
      } catch { /* may not exist */ }
      execFileSync('security', ['add-generic-password', '-s', 'credential-cowork-psk', '-a', 'kithkit', '-w', newPsk], { encoding: 'utf-8' });
    } catch (err) {
      log.warn('Failed to store PSK in Keychain', { error: String(err) });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ psk: newPsk }));
    return true;
  }

  // POST /api/cowork/token/rotate — alias (documented in README)
  // POST /api/cowork/rotate-token — original path
  if (req.method === 'POST' && (pathname === '/api/cowork/token/rotate' || pathname === '/api/cowork/rotate-token')) {
    authToken = generateToken();

    // Persist to Keychain so it survives daemon restart
    try {
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync('security', ['delete-generic-password', '-s', 'credential-cowork-token'], { encoding: 'utf-8' });
      } catch { /* may not exist */ }
      execFileSync('security', ['add-generic-password', '-s', 'credential-cowork-token', '-a', 'kithkit', '-w', authToken], { encoding: 'utf-8' });
    } catch (err) {
      log.warn('Failed to store auth token in Keychain', { error: String(err) });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: authToken }));
    return true;
  }

  return false;
}

// ── Public API ────────────────────────────────────────────────

/** Returns true if a cowork session is currently active. */
export function isCoworkConnected(): boolean {
  return activeSession !== null && activeSession.ws.readyState === WebSocket.OPEN;
}

/** Returns session metadata for status endpoints. */
export function getCoworkStatus(): {
  connected: boolean;
  connectedAt?: string;
  lastActivity?: string;
  userAgent?: string;
} {
  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) {
    return { connected: false };
  }
  return {
    connected: true,
    connectedAt: activeSession.connectedAt.toISOString(),
    lastActivity: activeSession.lastActivity.toISOString(),
    userAgent: activeSession.userAgent,
  };
}

/** Send a CDP command through the connected extension and await its result. */
export function sendCdpCommand(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('No cowork session connected'));
  }

  const id = nextCommandId++;
  const session = activeSession;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`CDP command timeout: ${method}`));
    }, 30_000);

    pendingCommands.set(id, { resolve, reject, timer });
    sendMessage(session, { type: 'cdp', id, method, params });
  });
}

/** List open tabs in the connected browser. */
export function listTabs(): Promise<unknown[]> {
  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('No cowork session connected'));
  }

  const id = nextCommandId++;
  const session = activeSession;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error('List tabs timeout'));
    }, 10_000);

    pendingCommands.set(id, {
      resolve: (v) => resolve(v as unknown[]),
      reject,
      timer,
    });
    sendMessage(session, { type: 'list-tabs', id });
  });
}

/** Switch the browser to a specific tab by ID. */
export function switchTab(tabId: number): Promise<unknown> {
  if (!activeSession || activeSession.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('No cowork session connected'));
  }

  const id = nextCommandId++;
  const session = activeSession;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error('Switch tab timeout'));
    }, 10_000);

    pendingCommands.set(id, { resolve, reject, timer });
    sendMessage(session, { type: 'switch-tab', id, tabId });
  });
}

/** Shut down the bridge — close active session and reject all pending commands. */
export function shutdownCoworkBridge(): void {
  if (activeSession) {
    closeSession(activeSession);
    activeSession = null;
  }
  rejectAllPending('Shutdown');
  if (wss) {
    wss.close();
    wss = null;
  }
}

// ── Testing Helpers ───────────────────────────────────────────

/** Reset all module state (for testing only). */
export function _resetCoworkBridgeForTesting(): void {
  if (activeSession) {
    if (activeSession.authTimer) clearTimeout(activeSession.authTimer);
    try { activeSession.ws.terminate(); } catch { /* ignore */ }
    activeSession = null;
  }
  for (const [_id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
  }
  pendingCommands.clear();
  nextCommandId = 1;
  // Reset auth state so tests run without auth by default
  authToken = null;
  pskHex = null;
  // NOTE: wss is intentionally NOT closed here — it's tied to the HTTP server
  // lifecycle. Closing it would prevent further upgrades until initCoworkBridge
  // is called again. shutdownCoworkBridge() handles wss cleanup.
}
