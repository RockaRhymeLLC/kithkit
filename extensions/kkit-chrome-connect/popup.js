/**
 * KithKit Chrome Connect — Popup Script
 *
 * Handles the popup UI. Talks to the background service worker via
 * chrome.runtime.sendMessage and listens for state-update broadcasts.
 */

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const statusDot       = document.getElementById('statusDot');
const statusText      = document.getElementById('statusText');
const hostInput       = document.getElementById('hostInput');
const tokenInput      = document.getElementById('tokenInput');
const pskToggle       = document.getElementById('pskToggle');
const pskChevron      = document.getElementById('pskChevron');
const pskSection      = document.getElementById('pskSection');
const pskInput        = document.getElementById('pskInput');
const connectBtn      = document.getElementById('connectBtn');
const disconnectBtn   = document.getElementById('disconnectBtn');
const tabInfo         = document.getElementById('tabInfo');
const tabTitle        = document.getElementById('tabTitle');
const tabUrl          = document.getElementById('tabUrl');
const errorArea       = document.getElementById('errorArea');
const fingerprintArea = document.getElementById('fingerprintArea');
const fingerprintValue = document.getElementById('fingerprintValue');

// ---------------------------------------------------------------------------
// PSK collapsible toggle
// ---------------------------------------------------------------------------
pskToggle.addEventListener('click', () => {
  const isOpen = pskSection.classList.contains('open');
  if (isOpen) {
    pskSection.classList.remove('open');
    pskChevron.classList.remove('open');
  } else {
    pskSection.classList.add('open');
    pskChevron.classList.add('open');
  }
});

// ---------------------------------------------------------------------------
// Apply a state snapshot to the UI
// ---------------------------------------------------------------------------
function applyState(connState, attachedTarget, encrypted, fingerprint, error) {
  // Clear previous error display unless this update carries one
  if (!error) {
    clearError();
  } else {
    showError(error);
  }

  // Status dot
  if (connState === 'connected') {
    statusDot.className = 'status-dot connected';
  } else if (connState === 'connecting') {
    statusDot.className = 'status-dot connecting';
  } else if (error) {
    statusDot.className = 'status-dot error';
  } else {
    statusDot.className = 'status-dot disconnected';
  }

  // Status text
  if (connState === 'connected') {
    const host = hostInput.value.trim() || 'cowork.bmobot.ai';
    const encLabel = encrypted ? ' (encrypted)' : '';
    statusText.textContent = `Connected to ${host}${encLabel}`;
  } else if (connState === 'connecting') {
    statusText.textContent = 'Connecting…';
  } else {
    statusText.textContent = 'Disconnected';
  }

  // Buttons
  const isConnected  = connState === 'connected';
  const isConnecting = connState === 'connecting';

  connectBtn.textContent = isConnecting ? 'Connecting…' : 'Connect';
  connectBtn.disabled = isConnected || isConnecting;
  connectBtn.classList.toggle('connecting', isConnecting);

  if (isConnected) {
    disconnectBtn.classList.remove('hidden');
  } else {
    disconnectBtn.classList.add('hidden');
  }

  // Input fields disabled while connected or connecting
  const inputsDisabled = connState !== 'disconnected';
  hostInput.disabled  = inputsDisabled;
  tokenInput.disabled = inputsDisabled;
  pskInput.disabled   = inputsDisabled;

  // Tab info panel
  if (isConnected && attachedTarget) {
    tabInfo.classList.remove('hidden');
    tabTitle.textContent = attachedTarget.title || '(no title)';
    tabUrl.textContent   = attachedTarget.url   || '(no url)';
  } else {
    tabInfo.classList.add('hidden');
  }

  // Fingerprint — only show when connected and encrypted
  if (isConnected && encrypted && fingerprint) {
    fingerprintArea.classList.add('visible');
    fingerprintValue.textContent = fingerprint;
  } else {
    fingerprintArea.classList.remove('visible');
    fingerprintValue.textContent = '';
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
    applyState(
      message.connState,
      message.attachedTarget,
      message.encrypted,
      message.fingerprint,
      message.error,
    );

    // Fix up status text with stored host when connected
    if (message.connState === 'connected') {
      chrome.storage.local.get(['host'], ({ host }) => {
        const resolvedHost = host || 'cowork.bmobot.ai';
        const encLabel = message.encrypted ? ' (encrypted)' : '';
        statusText.textContent = `Connected to ${resolvedHost}${encLabel}`;
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Connect button handler
// ---------------------------------------------------------------------------
connectBtn.addEventListener('click', () => {
  clearError();

  const host  = hostInput.value.trim()  || 'cowork.bmobot.ai';
  const token = tokenInput.value.trim() || null;
  const psk   = pskInput.value.trim()   || null;

  chrome.runtime.sendMessage({ type: 'connect', host, token, psk });
});

// ---------------------------------------------------------------------------
// Disconnect button handler
// ---------------------------------------------------------------------------
disconnectBtn.addEventListener('click', () => {
  clearError();
  chrome.runtime.sendMessage({ type: 'disconnect' });
});

// ---------------------------------------------------------------------------
// On popup open: load saved config, then query background for live state
// ---------------------------------------------------------------------------
async function init() {
  // 1. Load saved host and psk from local storage
  const localStored = await chrome.storage.local.get(['host', 'psk']);
  if (localStored.host) hostInput.value = localStored.host;
  if (localStored.psk)  {
    pskInput.value = localStored.psk;
    // Auto-expand PSK section if PSK is configured
    pskSection.classList.add('open');
    pskChevron.classList.add('open');
  }

  // 2. Load token from session storage (not persisted to local)
  const sessionStored = await chrome.storage.session.get(['token', 'connState', 'encrypted', 'fingerprint']);
  if (sessionStored.token) tokenInput.value = sessionStored.token;

  // 3. Query background for live state
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'get-state' });
  } catch (err) {
    // Background may not be running yet — fall back to session-cached state
    state = {
      connState:      sessionStored.connState || 'disconnected',
      attachedTarget: null,
      encrypted:      sessionStored.encrypted || false,
      fingerprint:    sessionStored.fingerprint || null,
      error:          null,
    };
  }

  applyState(
    state.connState,
    state.attachedTarget,
    state.encrypted,
    state.fingerprint,
    state.error,
  );

  // Fix up status text with real stored host when connected
  if (state.connState === 'connected') {
    const host = localStored.host || 'cowork.bmobot.ai';
    const encLabel = state.encrypted ? ' (encrypted)' : '';
    statusText.textContent = `Connected to ${host}${encLabel}`;
  }
}

init().catch((err) => {
  console.error('[kkit popup] init error', err);
  showError('Failed to load extension state.');
});
