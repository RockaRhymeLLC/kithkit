/**
 * Citation S550 Knowledge Base Portal
 * app.js — Vanilla JS, ESM-compatible (no framework)
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SESSION_KEY   = 'citation_s550_session';
const QA_HISTORY_KEY = 'citation_s550_qa_history';
const DATA_URL      = '/portal/citation/data/knowledge-base.json';
const ASK_API_URL   = '/portal/citation/api/ask';

/** Sidebar navigation sections in display order */
const NAV_SECTIONS = [
  { id: 'overview',     label: 'Aircraft Overview',        icon: '✈️' },
  { id: 'airworthiness',label: 'Airworthiness Directives', icon: '⚠️' },
  { id: 'maintenance',  label: 'Maintenance & Inspections',icon: '🔧' },
  { id: 'systems',      label: 'Systems & Components',     icon: '⚙️' },
  { id: 'bulletins',    label: 'Service Bulletins & STCs', icon: '📋' },
  { id: 'economics',    label: 'Operating Economics',      icon: '💰' },
  { id: 'training',     label: 'Training & Resources',     icon: '📚' },
  { id: 'community',    label: 'Community & Forums',       icon: '👥' },
  { id: 'faq',          label: 'FAQ',                      icon: '❓' },
  { id: 'accidents',    label: 'Accidents & Incidents',    icon: '🔴' },
  { id: 'prebuy',       label: 'Pre-Purchase Guide',       icon: '🔍' },
];

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

let knowledgeBase  = null;
let activeSection  = 'overview';
let searchQuery    = '';
let qaHistory      = [];    // [{ role, content }]
let qaLoading      = false;
let toastTimer     = null;

// ─────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────

function $(sel)       { return document.querySelector(sel); }
function $$(sel)      { return document.querySelectorAll(sel); }
function show(el)     { el && el.classList.remove('hidden'); }
function hide(el)     { el && el.classList.add('hidden'); }

function showToast(message, duration = 3500) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ─────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────

function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setSession(name) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name: name || 'Pilot', ts: Date.now() }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ─────────────────────────────────────────────────────────────
// QA history persistence
// ─────────────────────────────────────────────────────────────

function loadQAHistory() {
  try {
    const raw = sessionStorage.getItem(QA_HISTORY_KEY);
    qaHistory = raw ? JSON.parse(raw) : [];
  } catch { qaHistory = []; }
}

function saveQAHistory() {
  try {
    // Keep last 20 exchanges (40 messages)
    const trimmed = qaHistory.slice(-40);
    sessionStorage.setItem(QA_HISTORY_KEY, JSON.stringify(trimmed));
    qaHistory = trimmed;
  } catch { /* sessionStorage full — ignore */ }
}

function clearQAHistory() {
  qaHistory = [];
  sessionStorage.removeItem(QA_HISTORY_KEY);
  renderQAHistory();
}

// ─────────────────────────────────────────────────────────────
// Minimal Markdown renderer
// ─────────────────────────────────────────────────────────────

function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return '';

  let html = md;

  // Fenced code blocks
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // HR
  html = html.replace(/^---+$/gm, '<hr>');

  // Blockquote
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/((?:^[*-] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^[*-] /, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line =>
      `<li>${line.replace(/^\d+\. /, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // GFM tables
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[-| :]+\|$/.test(r.trim()));
    if (!rows.length) return block;
    let tableHtml = '<table>';
    rows.forEach((row, i) => {
      const cells = row.split('|').slice(1, -1).map(c => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
  });

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g,     '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g,  '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraphs
  const lines  = html.split('\n');
  const result = [];
  let inPara   = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isBlock = /^<(h[1-6]|ul|ol|li|pre|blockquote|table|tr|hr|\/ul|\/ol|\/pre|\/blockquote|\/table)/.test(trimmed);

    if (!trimmed) {
      if (inPara) { result.push('</p>'); inPara = false; }
      continue;
    }
    if (isBlock) {
      if (inPara) { result.push('</p>'); inPara = false; }
      result.push(trimmed);
    } else {
      if (!inPara) { result.push('<p>'); inPara = true; }
      result.push(trimmed);
    }
  }
  if (inPara) result.push('</p>');

  return result.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Search highlighting
// ─────────────────────────────────────────────────────────────

function highlightText(html, query) {
  if (!query || query.length < 2) return html;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(`(${escaped})`, 'gi');
  return html.replace(/>([^<]*)</g, (match, text) =>
    '>' + text.replace(regex, '<mark class="search-highlight">$1</mark>') + '<'
  );
}

// ─────────────────────────────────────────────────────────────
// Knowledge base loader
// ─────────────────────────────────────────────────────────────

async function loadKnowledgeBase() {
  try {
    const res = await fetch(DATA_URL + '?v=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    knowledgeBase = await res.json();

    // Update banner last-updated
    const updatedEl = $('#banner-updated');
    if (updatedEl && knowledgeBase.lastUpdated) {
      updatedEl.textContent = 'Data: ' + knowledgeBase.lastUpdated;
    }

    renderSection(activeSection);
  } catch (err) {
    console.error('[Citation Portal] Failed to load knowledge base:', err);
    const body = $('#section-body');
    if (body) {
      body.innerHTML = `<p style="color:var(--error-color)">
        Failed to load knowledge base. Please refresh the page.
      </p>`;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Section renderer
// ─────────────────────────────────────────────────────────────

function renderSection(sectionId) {
  activeSection = sectionId;

  // Update nav active state
  $$('.nav-item[data-section]').forEach(el => {
    el.classList.toggle('active', el.dataset.section === sectionId);
  });

  const titleEl    = $('#section-title');
  const iconEl     = $('#section-icon-wrap');
  const bodyEl     = $('#section-body');
  const noticeEl   = $('#search-results-notice');

  if (!titleEl || !bodyEl) return;

  const navConf = NAV_SECTIONS.find(n => n.id === sectionId);
  if (iconEl) {
    iconEl.textContent = navConf?.icon ?? '📄';
    iconEl.setAttribute('aria-label', navConf?.label ?? sectionId);
  }

  if (!knowledgeBase) {
    titleEl.textContent = navConf?.label ?? sectionId;
    bodyEl.innerHTML = `<div class="loading-placeholder">
      <div class="spinner"></div> Loading knowledge base…
    </div>`;
    hide(noticeEl);
    return;
  }

  const section = knowledgeBase.sections?.[sectionId];
  if (!section) {
    titleEl.textContent = 'Section Not Found';
    bodyEl.innerHTML = '<p>This section does not exist in the knowledge base.</p>';
    hide(noticeEl);
    return;
  }

  titleEl.textContent = section.title;

  let html = renderMarkdown(section.content || '');

  if (searchQuery.length >= 2) {
    html = highlightText(html, searchQuery);
    const lc = (section.content || '').toLowerCase();
    if (!lc.includes(searchQuery.toLowerCase())) {
      show(noticeEl);
      noticeEl.textContent = `No matches for "${searchQuery}" in this section.`;
    } else {
      hide(noticeEl);
    }
  } else {
    hide(noticeEl);
  }

  bodyEl.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// Search handler
// ─────────────────────────────────────────────────────────────

function handleSearch(query) {
  searchQuery = query.trim();
  renderSection(activeSection);

  if (searchQuery.length < 2 || !knowledgeBase) return;

  // Auto-navigate to first section with a match if current doesn't match
  const lc = searchQuery.toLowerCase();
  const currentContent = (knowledgeBase.sections?.[activeSection]?.content || '').toLowerCase();
  if (!currentContent.includes(lc)) {
    for (const sec of NAV_SECTIONS) {
      const content = (knowledgeBase.sections?.[sec.id]?.content || '').toLowerCase();
      if (content.includes(lc)) {
        renderSection(sec.id);
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Q&A — render chat history
// ─────────────────────────────────────────────────────────────

function renderQAHistory() {
  const container = $('#qa-history');
  if (!container) return;

  if (!qaHistory.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = qaHistory.map(msg => buildMessageHTML(msg)).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function buildMessageHTML(msg) {
  const isUser = msg.role === 'user';
  const label  = isUser ? 'You' : 'AI Assistant';

  let bubbleContent = '';
  if (msg.error) {
    bubbleContent = `<div class="qa-error">${escapeHtml(msg.content)}</div>`;
  } else if (isUser) {
    bubbleContent = `<div class="qa-msg-bubble">${escapeHtml(msg.content)}</div>`;
  } else {
    // Render assistant response as markdown
    const html = renderMarkdown(msg.content || '');
    bubbleContent = `<div class="qa-msg-bubble">${html}</div>`;
    if (msg.sources && msg.sources.length) {
      const srcList = msg.sources.map(s => `<span>${escapeHtml(s)}</span>`).join(', ');
      bubbleContent += `<div class="qa-sources">Sources: ${srcList}</div>`;
    }
  }

  return `<div class="qa-msg ${isUser ? 'user' : 'assistant'}">
    <div class="qa-msg-label">${escapeHtml(label)}</div>
    ${bubbleContent}
  </div>`;
}

function appendThinkingIndicator() {
  const container = $('#qa-history');
  if (!container) return;
  container.style.display = 'flex';
  const el = document.createElement('div');
  el.className = 'qa-msg assistant';
  el.id = 'qa-thinking-indicator';
  el.innerHTML = `<div class="qa-msg-label">AI Assistant</div>
    <div class="qa-thinking">
      <span></span><span></span><span></span>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function removeThinkingIndicator() {
  const el = document.getElementById('qa-thinking-indicator');
  el?.remove();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─────────────────────────────────────────────────────────────
// Q&A — submit question
// ─────────────────────────────────────────────────────────────

async function submitQuestion(question) {
  if (!question.trim() || qaLoading) return;

  const input   = $('#qa-input');
  const askBtn  = $('#ask-btn');

  // Add user message to history
  qaHistory.push({ role: 'user', content: question });
  saveQAHistory();
  renderQAHistory();

  // Reset input
  if (input) input.value = '';

  // Set loading state
  qaLoading = true;
  if (askBtn) askBtn.disabled = true;
  if (input)  input.disabled  = true;
  appendThinkingIndicator();

  try {
    // Build context from the current knowledge base section
    const currentSection = knowledgeBase?.sections?.[activeSection];
    const contextHint = currentSection
      ? `The user is currently viewing the "${currentSection.title}" section.`
      : '';

    const payload = {
      question: question.trim(),
      context: contextHint,
      history: qaHistory.slice(-10),  // Send last 5 exchanges for context
      aircraft: knowledgeBase?.aircraft ?? { designation: 'S550', commonName: 'Citation S/II' },
    };

    const res = await fetch(ASK_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    removeThinkingIndicator();

    if (!res.ok) {
      // Backend not yet wired — handle gracefully
      const errorText = res.status === 404
        ? 'The AI Q&A endpoint is not yet connected. This feature will be available once the backend is configured.'
        : `Server error (${res.status}). Please try again later.`;
      qaHistory.push({ role: 'assistant', content: errorText, error: false });
    } else {
      const data = await res.json();
      qaHistory.push({
        role:    'assistant',
        content: data.answer || data.response || 'No response received.',
        sources: data.sources || [],
      });
    }
  } catch (err) {
    removeThinkingIndicator();
    console.error('[Citation Portal] Q&A error:', err);

    const isNetworkErr = err instanceof TypeError && err.message.includes('fetch');
    const errMsg = isNetworkErr
      ? 'Could not connect to the AI backend. The Q&A service may not be running yet.'
      : 'An unexpected error occurred. Please try again.';

    qaHistory.push({ role: 'assistant', content: errMsg, error: false });
  } finally {
    saveQAHistory();
    qaLoading = false;
    if (askBtn) askBtn.disabled = false;
    if (input) {
      input.disabled = false;
      input.focus();
    }
    renderQAHistory();
  }
}

// ─────────────────────────────────────────────────────────────
// Build app sidebar UI
// ─────────────────────────────────────────────────────────────

function buildSidebar() {
  const nav = $('#nav-list');
  if (!nav) return;

  nav.innerHTML = '';
  for (const item of NAV_SECTIONS) {
    const el         = document.createElement('div');
    el.className     = 'nav-item' + (item.id === activeSection ? ' active' : '');
    el.dataset.section = item.id;
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '0');
    el.innerHTML     = `<span class="nav-icon" aria-hidden="true">${item.icon}</span>${item.label}`;

    el.addEventListener('click', () => {
      renderSection(item.id);
      hide($('#search-results-notice'));
      // On mobile, scroll content into view
      if (window.innerWidth <= 620) {
        $('#content-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });

    nav.appendChild(el);
  }

  // AI Q&A nav item
  const qaEl = document.createElement('div');
  qaEl.className   = 'nav-item';
  qaEl.id          = 'qa-nav-btn';
  qaEl.setAttribute('role', 'menuitem');
  qaEl.setAttribute('tabindex', '0');
  qaEl.innerHTML   = `<span class="nav-icon" aria-hidden="true">💬</span>AI Q&amp;A`;
  qaEl.addEventListener('click', () => {
    document.getElementById('qa-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  nav.appendChild(qaEl);
}

// ─────────────────────────────────────────────────────────────
// Show / hide screens
// ─────────────────────────────────────────────────────────────

function showLogin() {
  hide($('#app-screen'));
  show($('#login-screen'));
  const nameInput = $('#name-input');
  if (nameInput) {
    nameInput.value = '';
    setTimeout(() => nameInput.focus(), 120);
  }
}

function showPortal(session) {
  hide($('#login-screen'));
  show($('#app-screen'));

  // Update header user display
  const userEl = $('#header-user');
  if (userEl && session?.name) {
    userEl.textContent = session.name;
  }

  buildSidebar();
  loadQAHistory();
  renderQAHistory();
  loadKnowledgeBase();
}

// ─────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────

function wireEvents() {
  // ── Login ─────────────────────────────────────────────
  const loginForm = $('#login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = ($('#name-input')?.value || '').trim();
      setSession(name || 'Pilot');
      showPortal(getSession());
    });
  }

  // ── Exit / Logout ─────────────────────────────────────
  const exitBtn = $('#exit-btn');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      clearSession();
      showToast('Session ended.');
      setTimeout(showLogin, 400);
    });
  }

  // ── Search ────────────────────────────────────────────
  const searchInput = $('#search-input');
  if (searchInput) {
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => handleSearch(searchInput.value), 200);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        handleSearch('');
      }
    });
  }

  // ── Q&A Ask button ────────────────────────────────────
  const askBtn = $('#ask-btn');
  if (askBtn) {
    askBtn.addEventListener('click', () => {
      const question = $('#qa-input')?.value?.trim();
      if (question) submitQuestion(question);
    });
  }

  // ── Q&A keyboard shortcut ─────────────────────────────
  const qaInput = $('#qa-input');
  if (qaInput) {
    qaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const question = qaInput.value.trim();
        if (question) submitQuestion(question);
      }
    });

    // Auto-expand textarea
    qaInput.addEventListener('input', () => {
      qaInput.style.height = 'auto';
      qaInput.style.height = Math.min(qaInput.scrollHeight, 140) + 'px';
    });
  }

  // ── Clear QA history ──────────────────────────────────
  const clearBtn = document.getElementById('qa-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearQAHistory();
      showToast('Conversation cleared.');
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────

function init() {
  wireEvents();

  const session = getSession();
  if (session?.name) {
    showPortal(session);
  } else {
    showLogin();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
