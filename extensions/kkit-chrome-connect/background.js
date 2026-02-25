/**
 * KithKit Chrome Connect — Background Service Worker
 *
 * This service worker is the core bridge between:
 *   - The KithKit daemon (via encrypted WebSocket at ws://<host>:<port>/cowork)
 *   - The active Chrome tab (via chrome.debugger / CDP)
 *
 * Encrypted message protocol:
 *   Phase 1 — Auth:
 *     Client → Daemon  { type: "auth", token }
 *     Daemon → Client  { type: "auth-ok" }
 *
 *   Phase 2 — Key Exchange:
 *     Client → Daemon  { type: "key-exchange", publicKey: <base64> }
 *     Daemon → Client  { type: "key-exchange", publicKey: <base64> }
 *
 *   Phase 3 — Encrypted Hello:
 *     Client → Daemon  encrypted{ type: "hello", userAgent }  (seq=1)
 *     Daemon → Client  encrypted{ type: "hello-ack" }         (seq=1)
 *
 *   Phase 4 — Encrypted session (all messages wrapped in encrypted envelopes):
 *     Daemon → Client  encrypted{ type: "cdp", id, method, params }
 *     Client → Daemon  encrypted{ type: "cdp-result", id, result }
 *     Client → Daemon  encrypted{ type: "cdp-error", id, error }
 *     Client → Daemon  encrypted{ type: "cdp-event", method, params }
 *     Daemon → Client  encrypted{ type: "list-tabs", id }
 *     Client → Daemon  encrypted{ type: "tab-list", id, tabs }
 *     Daemon → Client  encrypted{ type: "switch-tab", id, tabId }
 *     Client → Daemon  encrypted{ type: "tab-switched", id, tabId }
 *     Client → Daemon  encrypted{ type: "tab-changed", tabId, title, url }
 *     Either direction encrypted{ type: "ping" } / encrypted{ type: "pong" }
 */

// Import crypto module — sets globalThis.KKitCrypto
importScripts('crypto.js');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'disconnected'|'connecting'|'connected'} */
let connState = 'disconnected';

/** @type {WebSocket|null} */
let ws = null;

/** Currently attached tab target */
let attachedTarget = null; // { tabId: number, title: string, url: string }

/** Set of tabIds we have already issued debugger.attach to */
const attachedTabs = new Set();

/** Defaults — overridden by chrome.storage.local */
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '3847';

// ---------------------------------------------------------------------------
// Crypto State
// ---------------------------------------------------------------------------

/** @type {{ publicKey: CryptoKey, privateKey: CryptoKey }|null} */
let keyPair = null;

/** @type {CryptoKey|null} — AES-256-GCM session key */
let sessionKey = null;

/** Send sequence counter */
let sendSeq = 0;

/** Receive sequence counter */
let recvSeq = 0;

/** Daemon's base64 public key (received during key exchange) */
let daemonPubKeyB64 = null;

/** PSK as hex string (loaded from chrome.storage.local) */
let pskHex = null;

/** Auth token (loaded from chrome.storage.session) */
let authToken = null;

// ---------------------------------------------------------------------------
// Alarm name for keepalive
// ---------------------------------------------------------------------------
const KEEPALIVE_ALARM = 'kkit-keepalive';
const HEARTBEAT_INTERVAL_SECONDS = 30;

// ---------------------------------------------------------------------------
// Clear crypto state on disconnect
// ---------------------------------------------------------------------------
function clearCryptoState() {
  keyPair = null;
  sessionKey = null;
  sendSeq = 0;
  recvSeq = 0;
  daemonPubKeyB64 = null;
}

// ---------------------------------------------------------------------------
// Utility: send an encrypted envelope over WebSocket
// ---------------------------------------------------------------------------
async function encryptedSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!sessionKey) {
    // Fallback to plaintext if no session key yet (should not normally happen)
    ws.send(JSON.stringify(obj));
    return;
  }
  sendSeq += 1;
  const envelope = await KKitCrypto.encrypt(sessionKey, JSON.stringify(obj), sendSeq);
  ws.send(JSON.stringify(envelope));
}

// ---------------------------------------------------------------------------
// Utility: send plaintext (used only during handshake phases)
// ---------------------------------------------------------------------------
function wsSendPlaintext(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------
function setBadge(state) {
  if (state === 'connected') {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#00d4aa' });
  } else if (state === 'connecting') {
    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#f0a500' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ---------------------------------------------------------------------------
// Notify all popup/options pages of state change
// ---------------------------------------------------------------------------
function broadcastState() {
  const payload = {
    type: 'state-update',
    connState,
    attachedTarget,
  };
  chrome.runtime.sendMessage(payload).catch(() => {
    // No listeners open — that's fine
  });
}

// ---------------------------------------------------------------------------
// Debugger: attach to a tab
// ---------------------------------------------------------------------------
async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return; // already attached

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    attachedTabs.add(tabId);

    // Get tab info for state
    const tab = await chrome.tabs.get(tabId);
    attachedTarget = { tabId, title: tab.title || '', url: tab.url || '' };

    console.log('[kkit] Attached debugger to tab', tabId, attachedTarget.url);
    broadcastState();

    // Notify daemon of the new tab context
    encryptedSend({ type: 'tab-changed', tabId, title: attachedTarget.title, url: attachedTarget.url });
  } catch (err) {
    console.error('[kkit] Failed to attach debugger to tab', tabId, err);
    // If attach fails, try to notify popup
    broadcastState();
  }
}

// ---------------------------------------------------------------------------
// Debugger: detach from a tab
// ---------------------------------------------------------------------------
async function detachTab(tabId) {
  if (!attachedTabs.has(tabId)) return;

  const target = { tabId };
  try {
    await chrome.debugger.detach(target);
  } catch (_) {
    // Ignore — tab may already be gone
  }
  attachedTabs.delete(tabId);

  if (attachedTarget && attachedTarget.tabId === tabId) {
    attachedTarget = null;
  }
  broadcastState();
}

// ---------------------------------------------------------------------------
// Debugger: detach from all currently tracked tabs
// ---------------------------------------------------------------------------
async function detachAll() {
  const ids = [...attachedTabs];
  for (const tabId of ids) {
    await detachTab(tabId);
  }
}

// ---------------------------------------------------------------------------
// WebSocket: connect to daemon with encrypted handshake
// ---------------------------------------------------------------------------
async function connectToDaemon(host, port) {
  if (ws) {
    ws.close();
    ws = null;
  }

  connState = 'connecting';
  setBadge('connecting');
  broadcastState();

  // Load credentials
  try {
    const sessionData = await chrome.storage.session.get(['token']);
    authToken = sessionData.token || null;
    const localData = await chrome.storage.local.get(['psk', 'host', 'port']);
    pskHex = localData.psk || null;
  } catch (err) {
    console.warn('[kkit] Failed to load credentials from storage', err);
  }

  const url = `ws://${host}:${port}/cowork`;
  console.log('[kkit] Connecting to', url);

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    console.error('[kkit] WebSocket construction failed', err);
    connState = 'disconnected';
    setBadge('disconnected');
    broadcastState();
    return;
  }

  ws = socket;
  clearCryptoState();

  socket.addEventListener('open', async () => {
    if (socket !== ws) return; // stale socket
    console.log('[kkit] WebSocket connected — starting handshake');

    try {
      await performHandshake(socket);
    } catch (err) {
      console.error('[kkit] Handshake failed', err);
      if (socket === ws) {
        socket.close();
        ws = null;
        connState = 'disconnected';
        setBadge('disconnected');
        broadcastState();
      }
    }
  });

  socket.addEventListener('message', (event) => {
    if (socket !== ws) return;
    handleDaemonMessage(event.data);
  });

  socket.addEventListener('close', (event) => {
    if (socket !== ws) return;
    console.log('[kkit] WebSocket closed', event.code, event.reason);
    // No auto-reconnect — user must click Connect again.
    handleDisconnect();
  });

  socket.addEventListener('error', (event) => {
    if (socket !== ws) return;
    console.error('[kkit] WebSocket error', event);
    // close event will follow; handled there
  });
}

// ---------------------------------------------------------------------------
// Handshake: auth + key exchange + encrypted hello
// ---------------------------------------------------------------------------
async function performHandshake(socket) {
  // Phase 1: Auth (only if token is configured)
  if (authToken) {
    wsSendPlaintext({ type: 'auth', token: authToken });

    const authResponse = await waitForMessage(socket, 5000);
    if (!authResponse || authResponse.type !== 'auth-ok') {
      throw new Error('Auth failed: expected auth-ok');
    }
    console.log('[kkit] Auth OK');
  }

  // Phase 2: Key Exchange (only if PSK is configured)
  if (pskHex) {
    keyPair = await KKitCrypto.generateKeyPair();
    const extPubKeyB64 = await KKitCrypto.exportPublicKey(keyPair);

    wsSendPlaintext({ type: 'key-exchange', publicKey: extPubKeyB64 });

    const keyResponse = await waitForMessage(socket, 5000);
    if (!keyResponse || keyResponse.type !== 'key-exchange' || typeof keyResponse.publicKey !== 'string') {
      throw new Error('Key exchange failed: expected key-exchange response');
    }

    daemonPubKeyB64 = keyResponse.publicKey;
    console.log('[kkit] Key exchange received daemon pubkey');

    // Derive session key
    const sharedBits = await KKitCrypto.deriveBits(keyPair.privateKey, daemonPubKeyB64);
    sessionKey = await KKitCrypto.deriveSessionKey(sharedBits, pskHex, extPubKeyB64, daemonPubKeyB64);
    console.log('[kkit] Session key derived');

    // Phase 3: Send encrypted hello (seq=1)
    sendSeq = 0; // reset before first encrypted message
    await encryptedSend({ type: 'hello', userAgent: navigator.userAgent });

    // Wait for encrypted hello-ack
    const ackRaw = await waitForMessage(socket, 5000);
    if (!ackRaw || ackRaw.type !== 'encrypted') {
      throw new Error('Hello handshake failed: expected encrypted hello-ack');
    }

    // Validate and decrypt hello-ack
    const expectedAckSeq = recvSeq + 1;
    if (ackRaw.seq !== expectedAckSeq) {
      throw new Error(`Hello handshake failed: sequence violation (got ${ackRaw.seq}, expected ${expectedAckSeq})`);
    }
    recvSeq = ackRaw.seq;

    const ackText = await KKitCrypto.decrypt(sessionKey, ackRaw);
    const ack = JSON.parse(ackText);
    if (!ack || ack.type !== 'hello-ack') {
      throw new Error(`Hello handshake failed: expected hello-ack, got ${ack && ack.type}`);
    }

    console.log('[kkit] Encrypted session established');
  } else {
    // No PSK — send plaintext hello
    wsSendPlaintext({ type: 'hello', userAgent: navigator.userAgent });
    console.log('[kkit] Plaintext hello sent (no PSK)');
  }

  // Handshake complete — mark connected
  if (socket !== ws) return; // socket was replaced during handshake

  connState = 'connected';
  setBadge('connected');

  // Attach debugger to currently active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    await attachTab(activeTab.id);
  }

  // Start keepalive alarm
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_SECONDS / 60 });

  broadcastState();
}

// ---------------------------------------------------------------------------
// Wait for a single message from socket (for handshake phases)
// The message listener in connectToDaemon calls handleDaemonMessage which
// won't process handshake messages, so we use a one-time event listener here.
// ---------------------------------------------------------------------------
function waitForMessage(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('waitForMessage timeout'));
    }, timeoutMs);

    const onMessage = (event) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      try {
        resolve(JSON.parse(event.data));
      } catch (err) {
        reject(new Error('waitForMessage: invalid JSON'));
      }
    };

    socket.addEventListener('message', onMessage);
  });
}

// ---------------------------------------------------------------------------
// WebSocket: disconnect
// ---------------------------------------------------------------------------
async function disconnectFromDaemon() {
  if (ws) {
    ws.close(1000, 'User disconnected');
    ws = null;
  }
  await handleDisconnect();
}

async function handleDisconnect() {
  connState = 'disconnected';
  setBadge('disconnected');
  chrome.alarms.clear(KEEPALIVE_ALARM);
  clearCryptoState();
  await detachAll();
  broadcastState();
  console.log('[kkit] Disconnected');
}

// ---------------------------------------------------------------------------
// Handle incoming daemon message (post-handshake)
// ---------------------------------------------------------------------------
async function handleDaemonMessage(raw) {
  // During handshake, messages are handled by waitForMessage — ignore them here.
  // After handshake (connState === 'connected'), all messages are encrypted.
  if (connState !== 'connected') return;

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    console.warn('[kkit] Received non-JSON message', raw);
    return;
  }

  // If we have a session key, all messages must be encrypted envelopes
  if (sessionKey) {
    if (msg.type !== 'encrypted') {
      console.warn('[kkit] Expected encrypted envelope, got plaintext type:', msg.type);
      return;
    }

    // Validate sequence
    const expectedSeq = recvSeq + 1;
    if (msg.seq !== expectedSeq) {
      console.error('[kkit] Sequence violation: got', msg.seq, 'expected', expectedSeq);
      ws && ws.close(4003, 'Sequence violation');
      return;
    }
    recvSeq = msg.seq;

    // Decrypt
    let inner;
    try {
      const plaintext = await KKitCrypto.decrypt(sessionKey, msg);
      inner = JSON.parse(plaintext);
    } catch (err) {
      console.error('[kkit] Decryption failed', err);
      ws && ws.close(4002, 'Decryption failed');
      return;
    }

    await handleInnerMessage(inner);
  } else {
    // No session key — plaintext messages
    await handleInnerMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// Handle decrypted (or plaintext) inner message
// ---------------------------------------------------------------------------
async function handleInnerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    // -------------------------------------------------------------------
    // CDP command from daemon — forward to attached tab
    // -------------------------------------------------------------------
    case 'cdp': {
      const { id, method, params } = msg;

      if (!attachedTarget) {
        await encryptedSend({ type: 'cdp-error', id, error: { code: -32000, message: 'No tab attached' } });
        return;
      }

      const target = { tabId: attachedTarget.tabId };
      try {
        const result = await chrome.debugger.sendCommand(target, method, params || {});
        await encryptedSend({ type: 'cdp-result', id, result });
      } catch (err) {
        await encryptedSend({
          type: 'cdp-error',
          id,
          error: { code: -32000, message: err.message || String(err) },
        });
      }
      break;
    }

    // -------------------------------------------------------------------
    // Daemon asks for list of open tabs
    // -------------------------------------------------------------------
    case 'list-tabs': {
      const { id } = msg;
      const tabs = await chrome.tabs.query({});
      const tabList = tabs.map((t) => ({
        tabId: t.id,
        title: t.title || '',
        url: t.url || '',
        active: t.active,
        windowId: t.windowId,
      }));
      await encryptedSend({ type: 'tab-list', id, tabs: tabList });
      break;
    }

    // -------------------------------------------------------------------
    // Daemon asks to switch to a specific tab
    // -------------------------------------------------------------------
    case 'switch-tab': {
      const { id, tabId } = msg;

      // Detach current tab
      if (attachedTarget) {
        await detachTab(attachedTarget.tabId);
      }

      // Bring the requested tab to foreground and attach
      try {
        await chrome.tabs.update(tabId, { active: true });
        await attachTab(tabId);
        await encryptedSend({ type: 'tab-switched', id, tabId });
      } catch (err) {
        await encryptedSend({
          type: 'cdp-error',
          id,
          error: { code: -32001, message: `switch-tab failed: ${err.message}` },
        });
      }
      break;
    }

    // -------------------------------------------------------------------
    // Keepalive pong
    // -------------------------------------------------------------------
    case 'ping':
      await encryptedSend({ type: 'pong' });
      break;

    case 'pong':
      // Acknowledged — no action needed
      break;

    default:
      console.warn('[kkit] Unknown message type from daemon:', msg.type);
  }
}

// ---------------------------------------------------------------------------
// chrome.debugger event listener — forward CDP events to daemon
// ---------------------------------------------------------------------------
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (connState !== 'connected') return;
  encryptedSend({
    type: 'cdp-event',
    method,
    params: params || {},
    sessionId: source.sessionId,
  });
});

// ---------------------------------------------------------------------------
// chrome.debugger detach listener — daemon/user detached us externally
// ---------------------------------------------------------------------------
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  console.log('[kkit] Debugger detached from tab', tabId, 'reason:', reason);

  attachedTabs.delete(tabId);
  if (attachedTarget && attachedTarget.tabId === tabId) {
    attachedTarget = null;
  }

  // Notify daemon
  encryptedSend({ type: 'tab-changed', tabId: null, title: null, url: null });
  broadcastState();
});

// ---------------------------------------------------------------------------
// Tab lifecycle: user switches active tab
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (connState !== 'connected') return;

  // Detach from previous tab if it's not the new one
  if (attachedTarget && attachedTarget.tabId !== tabId) {
    await detachTab(attachedTarget.tabId);
  }

  // Attach to new active tab
  await attachTab(tabId);
});

// ---------------------------------------------------------------------------
// Tab lifecycle: tab removed
// ---------------------------------------------------------------------------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!attachedTabs.has(tabId)) return;

  attachedTabs.delete(tabId);
  if (attachedTarget && attachedTarget.tabId === tabId) {
    attachedTarget = null;
    broadcastState();
  }

  // If still connected, attach to whatever tab is now active
  if (connState === 'connected') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await attachTab(activeTab.id);
    }
  }
});

// ---------------------------------------------------------------------------
// Tab updated: capture title/url changes for the attached tab
// ---------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (connState !== 'connected') return;
  if (!attachedTarget || attachedTarget.tabId !== tabId) return;
  if (!changeInfo.url && !changeInfo.title) return;

  attachedTarget.title = tab.title || attachedTarget.title;
  attachedTarget.url = tab.url || attachedTarget.url;

  encryptedSend({ type: 'tab-changed', tabId, title: attachedTarget.title, url: attachedTarget.url });
  broadcastState();
});

// ---------------------------------------------------------------------------
// Alarm: keepalive heartbeat ping
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (connState === 'connected') {
    encryptedSend({ type: 'ping' });
  }
});

// ---------------------------------------------------------------------------
// Messages from popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    // -------------------------------------------------------------------
    // Popup asks for current state
    // -------------------------------------------------------------------
    case 'get-state':
      sendResponse({ connState, attachedTarget });
      return false; // synchronous

    // -------------------------------------------------------------------
    // Popup requests connect
    // -------------------------------------------------------------------
    case 'connect': {
      const { host, port, token, psk } = message;
      // Save config and credentials
      chrome.storage.local.set({ host, port, psk: psk || null });
      if (token) {
        chrome.storage.session.set({ token });
      } else {
        chrome.storage.session.remove('token');
      }
      // Async connect — respond immediately
      connectToDaemon(host, port);
      sendResponse({ ok: true });
      return false;
    }

    // -------------------------------------------------------------------
    // Popup requests disconnect
    // -------------------------------------------------------------------
    case 'disconnect':
      disconnectFromDaemon();
      sendResponse({ ok: true });
      return false;

    default:
      sendResponse({ error: 'unknown message type' });
      return false;
  }
});

// ---------------------------------------------------------------------------
// Startup: restore state after service worker restart
// ---------------------------------------------------------------------------
chrome.runtime.onStartup.addListener(() => {
  setBadge('disconnected');
});

// Ensure badge is cleared on install/update
chrome.runtime.onInstalled.addListener(() => {
  setBadge('disconnected');
  console.log('[kkit] KithKit Chrome Connect installed');
});

console.log('[kkit] Background service worker started');
