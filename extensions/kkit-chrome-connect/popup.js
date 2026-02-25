/**
 * KithKit Chrome Connect — Popup Script
 *
 * Handles the popup UI. Talks to the background service worker via
 * chrome.runtime.sendMessage and listens for state-update broadcasts.
 */

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const statusDot  = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const hostInput  = document.getElementById('hostInput');
const portInput  = document.getElementById('portInput');
const connectBtn = document.getElementById('connectBtn');
const tabInfo    = document.getElementById('tabInfo');
const tabTitle   = document.getElementById('tabTitle');
const tabUrl     = document.getElementById('tabUrl');
const errorArea  = document.getElementById('errorArea');

// ---------------------------------------------------------------------------
// Apply a state snapshot to the UI
// ---------------------------------------------------------------------------
function applyState(connState, attachedTarget) {
  // Status dot + text
  statusDot.className = `status-dot ${connState}`;

  if (connState === 'connected') {
    const host = hostInput.value.trim() || 'localhost';
    const port = portInput.value.trim() || '3847';
    statusText.textContent = `Connected to ${host}:${port}`;
  } else if (connState === 'connecting') {
    statusText.textContent = 'Connecting…';
  } else {
    statusText.textContent = 'Disconnected';
  }

  // Button
  connectBtn.className = `btn-connect state-${connState}`;
  if (connState === 'connected') {
    connectBtn.textContent = 'Disconnect';
    connectBtn.disabled = false;
  } else if (connState === 'connecting') {
    connectBtn.textContent = 'Connecting…';
    connectBtn.disabled = true;
  } else {
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = false;
  }

  // Input fields disabled while connected or connecting
  const inputsDisabled = connState !== 'disconnected';
  hostInput.disabled = inputsDisabled;
  portInput.disabled = inputsDisabled;

  // Tab info panel
  if (connState === 'connected' && attachedTarget) {
    tabInfo.classList.remove('hidden');
    tabTitle.textContent = attachedTarget.title || '(no title)';
    tabUrl.textContent   = attachedTarget.url   || '(no url)';
  } else {
    tabInfo.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Show / hide error
// ---------------------------------------------------------------------------
function showError(msg) {
  errorArea.textContent = msg;
  errorArea.classList.add('visible');
}

function clearError() {
  errorArea.textContent = '';
  errorArea.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Listen for state-update broadcasts from the background
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'state-update') {
    applyState(message.connState, message.attachedTarget);
    // Update status text with stored host:port for "connected" display
    chrome.storage.local.get(['host', 'port'], ({ host, port }) => {
      if (message.connState === 'connected') {
        statusText.textContent = `Connected to ${host || 'localhost'}:${port || '3847'}`;
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Connect button handler
// ---------------------------------------------------------------------------
connectBtn.addEventListener('click', () => {
  clearError();

  // Determine action based on current button state
  const isConnected = connectBtn.classList.contains('state-connected');

  if (isConnected) {
    // Disconnect
    chrome.runtime.sendMessage({ type: 'disconnect' });
  } else {
    // Connect
    const host = hostInput.value.trim() || 'localhost';
    const port = portInput.value.trim() || '3847';

    // Basic validation
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      showError('Port must be a number between 1 and 65535.');
      return;
    }

    chrome.runtime.sendMessage({ type: 'connect', host, port });
  }
});

// ---------------------------------------------------------------------------
// On popup open: load saved config, then query background for live state
// ---------------------------------------------------------------------------
async function init() {
  // 1. Load saved host:port
  const stored = await chrome.storage.local.get(['host', 'port']);
  if (stored.host) hostInput.value = stored.host;
  if (stored.port) portInput.value = stored.port;

  // 2. Query background for current state
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'get-state' });
  } catch (err) {
    // Background may not be running yet
    state = { connState: 'disconnected', attachedTarget: null };
  }

  applyState(state.connState, state.attachedTarget);

  // Fix up status text with real stored host:port when connected
  if (state.connState === 'connected') {
    const host = stored.host || 'localhost';
    const port = stored.port || '3847';
    statusText.textContent = `Connected to ${host}:${port}`;
  }
}

init().catch((err) => {
  console.error('[kkit popup] init error', err);
  showError('Failed to load extension state.');
});
