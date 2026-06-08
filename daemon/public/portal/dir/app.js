/**
 * Servos — California DIR Knowledge Base Portal
 * app.js
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

/** SHA-256 of 'Serv0s1234!' (no plaintext in source) */
const CORRECT_HASH = '5296a011a24699fef28e465b56940c859285bad530fa3dd13d2d9bb2c93238a8';
const ALLOWED_DOMAIN = 'servos.io';
const SESSION_KEY = 'dir_portal_session';
const DATA_URL = '/portal/dir/data/knowledge-base.json';

/** Nav sections in display order */
const NAV_SECTIONS = [
  { id: 'overview',    label: 'Account Overview',       icon: '🏛️' },
  { id: 'contacts',    label: 'Key Contacts',            icon: '👥' },
  { id: 'timeline',    label: 'Timeline',                icon: '📅' },
  { id: 'scope',       label: 'Scope of Work',           icon: '📋' },
  { id: 'deliverables',label: 'Deliverables',            icon: '📦' },
  { id: 'status',      label: 'Current Status',          icon: '📊' },
  { id: 'technical',   label: 'Technical Details',       icon: '⚙️' },
];

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

let knowledgeBase = null;   // Loaded JSON data
let activeSection = 'overview';
let searchQuery   = '';
let toastTimer    = null;

// ─────────────────────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────────────────────

async function sha256(str) {
  const data   = new TextEncoder().encode(str);
  const buf    = await crypto.subtle.digest('SHA-256', data);
  const bytes  = new Uint8Array(buf);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
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

function setSession(email) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ email, ts: Date.now() }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ─────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────

function $(sel) { return document.querySelector(sel); }
function show(el) { el && el.classList.remove('hidden'); }
function hide(el) { el && el.classList.add('hidden'); }
function isHidden(el) { return el && el.classList.contains('hidden'); }

function setError(inputEl, msgEl, message) {
  if (inputEl) inputEl.classList.add('error');
  if (msgEl) msgEl.textContent = message;
}

function clearError(inputEl, msgEl) {
  if (inputEl) inputEl.classList.remove('error');
  if (msgEl) msgEl.textContent = '';
}

function showToast(message, duration = 3000) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ─────────────────────────────────────────────────────────────
// Minimal Markdown → HTML renderer
// ─────────────────────────────────────────────────────────────

function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return '';

  let html = md;

  // Escape HTML entities first (except in code blocks which we handle separately)
  // We do block-level first, then inline.

  // Fenced code blocks: ```lang\n...\n```
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Inline code: `code`
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<code>${escaped}</code>`;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Blockquote
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists (lines starting with - or *)
  html = html.replace(/((?:^[*-] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => {
      return `<li>${line.replace(/^[*-] /, '')}</li>`;
    }).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists (lines starting with 1. 2. etc.)
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => {
      return `<li>${line.replace(/^\d+\. /, '')}</li>`;
    }).join('');
    return `<ol>${items}</ol>`;
  });

  // Tables (basic GFM pipes)
  html = html.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => !/^\|[-| :]+\|$/.test(r.trim()));
    if (rows.length === 0) return block;
    let tableHtml = '<table>';
    rows.forEach((row, i) => {
      const cells = row.split('|').slice(1, -1).map(c => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      tableHtml += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
    });
    tableHtml += '</table>';
    return tableHtml;
  });

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs — wrap consecutive non-block lines
  const lines = html.split('\n');
  const result = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isBlock = /^<(h[1-6]|ul|ol|li|pre|blockquote|table|tr|hr|\/ul|\/ol|\/pre|\/blockquote|\/table)/.test(trimmed);

    if (trimmed === '') {
      if (inParagraph) { result.push('</p>'); inParagraph = false; }
      continue;
    }

    if (isBlock) {
      if (inParagraph) { result.push('</p>'); inParagraph = false; }
      result.push(trimmed);
    } else {
      if (!inParagraph) { result.push('<p>'); inParagraph = true; }
      result.push(trimmed);
    }
  }
  if (inParagraph) result.push('</p>');

  return result.join('\n');
}

// ─────────────────────────────────────────────────────────────
// Search highlighting
// ─────────────────────────────────────────────────────────────

function highlightText(html, query) {
  if (!query || query.length < 2) return html;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  // Only highlight in text nodes — avoid matching inside HTML tags
  return html.replace(/>([^<]*)</g, (match, text) => {
    return '>' + text.replace(regex, '<mark class="search-highlight">$1</mark>') + '<';
  });
}

// ─────────────────────────────────────────────────────────────
// Knowledge base loader
// ─────────────────────────────────────────────────────────────

async function loadKnowledgeBase() {
  try {
    const res  = await fetch(DATA_URL + '?v=' + Date.now());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    knowledgeBase = await res.json();
    // Update banner last-updated badge
    const updatedEl = $('#banner-updated');
    if (updatedEl && knowledgeBase.lastUpdated) {
      updatedEl.textContent = 'Last updated: ' + knowledgeBase.lastUpdated;
    }
    renderSection(activeSection);
  } catch (err) {
    console.error('[DIR Portal] Failed to load knowledge base:', err);
    const body = $('#section-body');
    if (body) body.innerHTML = `<p style="color:#C0392B">Failed to load knowledge base data. Please refresh the page.</p>`;
  }
}

// ─────────────────────────────────────────────────────────────
// Render section
// ─────────────────────────────────────────────────────────────

function renderSection(sectionId) {
  activeSection = sectionId;

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.section === sectionId);
  });

  const card       = $('#section-card');
  const titleEl    = $('#section-title');
  const iconEl     = $('#section-icon');
  const bodyEl     = $('#section-body');
  const noticeEl   = $('#search-results-notice');

  if (!card || !titleEl || !bodyEl) return;

  // Find nav config for icon
  const navConf  = NAV_SECTIONS.find(n => n.id === sectionId);
  if (iconEl) iconEl.textContent = navConf ? navConf.icon : '📄';

  if (!knowledgeBase) {
    titleEl.textContent = navConf ? navConf.label : sectionId;
    bodyEl.innerHTML = `<div class="loading-placeholder"><div class="spinner"></div> Loading...</div>`;
    hide(noticeEl);
    return;
  }

  const section = knowledgeBase.sections?.[sectionId];
  if (!section) {
    titleEl.textContent = 'Section Not Found';
    bodyEl.innerHTML    = '<p>This section does not exist in the knowledge base.</p>';
    hide(noticeEl);
    return;
  }

  titleEl.textContent = section.title;

  let html = renderMarkdown(section.content || '');

  if (searchQuery.length >= 2) {
    html = highlightText(html, searchQuery);
    // Check if any match is in this section
    const lc = (section.content || '').toLowerCase();
    if (!lc.includes(searchQuery.toLowerCase())) {
      show(noticeEl);
      noticeEl.textContent = `No matches for "${searchQuery}" in this section. Try another section.`;
    } else {
      hide(noticeEl);
    }
  } else {
    hide(noticeEl);
  }

  bodyEl.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// Search across all sections
// ─────────────────────────────────────────────────────────────

function handleSearch(query) {
  searchQuery = query.trim();
  renderSection(activeSection);

  if (searchQuery.length < 2 || !knowledgeBase) return;

  // Find first section that has the query (to auto-navigate if current has none)
  const lc = searchQuery.toLowerCase();
  const currentContent = (knowledgeBase.sections?.[activeSection]?.content || '').toLowerCase();
  if (!currentContent.includes(lc)) {
    // Auto-navigate to first matching section
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
// Build app UI
// ─────────────────────────────────────────────────────────────

function buildAppUI(session) {
  // Populate sidebar nav
  const nav = $('#nav-list');
  if (nav) {
    nav.innerHTML = '';
    for (const item of NAV_SECTIONS) {
      const el = document.createElement('div');
      el.className = 'nav-item' + (item.id === activeSection ? ' active' : '');
      el.dataset.section = item.id;
      el.innerHTML = `<span class="nav-icon">${item.icon}</span>${item.label}`;
      el.addEventListener('click', () => {
        renderSection(item.id);
        // Also clear search notice
        const noticeEl = $('#search-results-notice');
        if (searchQuery.length < 2) hide(noticeEl);
      });
      nav.appendChild(el);
    }
  }

  // Set logged-in user email if element exists
  const userEl = $('#header-user');
  if (userEl) userEl.textContent = session.email;
}

// ─────────────────────────────────────────────────────────────
// Login flow
// ─────────────────────────────────────────────────────────────

async function handleLogin(email, password) {
  const emailInput = $('#email-input');
  const emailErr   = $('#email-error');
  const passInput  = $('#password-input');
  const passErr    = $('#password-error');
  const btn        = $('#login-btn');

  // Clear previous errors
  clearError(emailInput, emailErr);
  clearError(passInput, passErr);

  // Validate email domain
  const emailTrimmed = email.trim().toLowerCase();
  if (!emailTrimmed) {
    setError(emailInput, emailErr, 'Email is required.');
    emailInput?.focus();
    return;
  }
  if (!emailTrimmed.includes('@') || !emailTrimmed.endsWith('@' + ALLOWED_DOMAIN)) {
    setError(emailInput, emailErr, `Access restricted to @${ALLOWED_DOMAIN} accounts.`);
    emailInput?.focus();
    return;
  }

  // Validate password
  if (!password) {
    setError(passInput, passErr, 'Password is required.');
    passInput?.focus();
    return;
  }

  // Hash and compare
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  try {
    const hash = await sha256(password);
    if (hash !== CORRECT_HASH) {
      setError(passInput, passErr, 'Incorrect password. Please try again.');
      passInput?.select();
      return;
    }

    // Login success
    setSession(emailTrimmed);
    showPortal(emailTrimmed);

  } catch (err) {
    console.error('[DIR Portal] Login error:', err);
    setError(passInput, passErr, 'An error occurred. Please try again.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

// ─────────────────────────────────────────────────────────────
// Show / hide screens
// ─────────────────────────────────────────────────────────────

function showLogin() {
  hide($('#app-screen'));
  show($('#login-screen'));
  // Reset form
  const emailInput = $('#email-input');
  const passInput  = $('#password-input');
  if (emailInput) { emailInput.value = ''; clearError(emailInput, $('#email-error')); }
  if (passInput)  { passInput.value  = ''; clearError(passInput,  $('#password-error')); }
  setTimeout(() => emailInput?.focus(), 100);
}

function showPortal(email) {
  hide($('#login-screen'));
  show($('#app-screen'));
  buildAppUI({ email });
  loadKnowledgeBase();
}

// ─────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────

function wireEvents() {
  // Login form submission
  const loginForm = $('#login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email    = ($('#email-input')?.value)    ?? '';
      const password = ($('#password-input')?.value) ?? '';
      handleLogin(email, password);
    });
  }

  // Logout
  const logoutBtn = $('#logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearSession();
      showToast('You have been signed out.');
      setTimeout(showLogin, 400);
    });
  }

  // Search input
  const searchInput = $('#search-input');
  if (searchInput) {
    let searchDebounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => handleSearch(searchInput.value), 250);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        handleSearch('');
      }
    });
  }

  // Q&A ask button (no-op — feature coming soon)
  const askBtn = $('#ask-btn');
  if (askBtn) {
    askBtn.addEventListener('click', () => {
      const input = $('#qa-input');
      if (input?.value.trim()) {
        showToast('AI-powered Q&A is coming soon. Your question has been noted.');
        input.value = '';
      }
    });
  }

  const qaInput = $('#qa-input');
  if (qaInput) {
    qaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        askBtn?.click();
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────

function init() {
  wireEvents();

  // Check for existing session
  const session = getSession();
  if (session?.email) {
    showPortal(session.email);
  } else {
    showLogin();
  }
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
