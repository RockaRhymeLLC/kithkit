/**
 * KithKit Chrome Connect — Background Service Worker
 *
 * This service worker is the core bridge between:
 *   - The KithKit daemon (via WebSocket at ws://<host>:<port>/cowork)
 *   - The active Chrome tab (via chrome.debugger / CDP)
 *
 * Message protocol (all JSON):
 *   Client → Daemon  { type: "hello", userAgent: string }
 *   Daemon → Client  { type: "cdp", id, method, params }
 *   Client → Daemon  { type: "cdp-result", id, result }
 *   Client → Daemon  { type: "cdp-error", id, error }
 *   Client → Daemon  { type: "cdp-event", method, params }
 *   Daemon → Client  { type: "list-tabs", id }
 *   Client → Daemon  { type: "tab-list", id, tabs }
 *   Daemon → Client  { type: "switch-tab", id, tabId }
 *   Client → Daemon  { type: "tab-switched", id, tabId }
 *   Client → Daemon  { type: "tab-changed", tabId, title, url }
 *   Either direction { type: "ping" } / { type: "pong" }
 */

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
// Alarm name for keepalive
// ---------------------------------------------------------------------------
const KEEPALIVE_ALARM = 'kkit-keepalive';
const HEARTBEAT_INTERVAL_SECONDS = 30;

// ---------------------------------------------------------------------------
// Utility: send over WebSocket if open
// ---------------------------------------------------------------------------
function wsSend(obj) {
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
    wsSend({ type: 'tab-changed', tabId, title: attachedTarget.title, url: attachedTarget.url });
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
// WebSocket: connect to daemon
// ---------------------------------------------------------------------------
async function connectToDaemon(host, port) {
  if (ws) {
    ws.close();
    ws = null;
  }

  connState = 'connecting';
  setBadge('connecting');
  broadcastState();

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

  socket.addEventListener('open', async () => {
    if (socket !== ws) return; // stale socket
    console.log('[kkit] WebSocket connected');
    connState = 'connected';
    setBadge('connected');

    // Send hello
    wsSend({ type: 'hello', userAgent: navigator.userAgent });

    // Attach debugger to currently active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await attachTab(activeTab.id);
    }

    // Start keepalive alarm
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_SECONDS / 60 });

    broadcastState();
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
  await detachAll();
  broadcastState();
  console.log('[kkit] Disconnected');
}

// ---------------------------------------------------------------------------
// Handle incoming daemon message
// ---------------------------------------------------------------------------
async function handleDaemonMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    console.warn('[kkit] Received non-JSON message', raw);
    return;
  }

  switch (msg.type) {
    // -------------------------------------------------------------------
    // CDP command from daemon — forward to attached tab
    // -------------------------------------------------------------------
    case 'cdp': {
      const { id, method, params } = msg;

      if (!attachedTarget) {
        wsSend({ type: 'cdp-error', id, error: { code: -32000, message: 'No tab attached' } });
        return;
      }

      const target = { tabId: attachedTarget.tabId };
      try {
        const result = await chrome.debugger.sendCommand(target, method, params || {});
        wsSend({ type: 'cdp-result', id, result });
      } catch (err) {
        wsSend({
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
      wsSend({ type: 'tab-list', id, tabs: tabList });
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
        wsSend({ type: 'tab-switched', id, tabId });
      } catch (err) {
        wsSend({
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
      wsSend({ type: 'pong' });
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
  wsSend({
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
  wsSend({ type: 'tab-changed', tabId: null, title: null, url: null });
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

  wsSend({ type: 'tab-changed', tabId, title: attachedTarget.title, url: attachedTarget.url });
  broadcastState();
});

// ---------------------------------------------------------------------------
// Alarm: keepalive heartbeat ping
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (connState === 'connected') {
    wsSend({ type: 'ping' });
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
      const { host, port } = message;
      // Save config
      chrome.storage.local.set({ host, port });
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
