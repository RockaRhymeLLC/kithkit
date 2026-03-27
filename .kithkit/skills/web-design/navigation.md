# Navigation Patterns

Modern navigation patterns for responsive websites.

---

## Responsive Navigation Best Practices

### Hamburger Menus

Use hamburger menus on mobile (< 768px) only. Desktop should show full nav.

**Requirements:**
- Use semantic `<button>` with `aria-label="Menu"`
- Animate transition (0.3s ease-in-out)
- Make button at least 44×44px for touch targets
- Track state with `aria-expanded` attribute
- Close menu when clicking outside or on nav links
- Close on Escape key press

**Good Pattern:**
```javascript
// nav.js
const hamburger = document.querySelector('.hamburger');
const menu = document.querySelector('nav ul');

hamburger.addEventListener('click', () => {
  const isOpen = menu.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', isOpen);
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu.classList.contains('open')) {
    menu.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
  }
});

// Close on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.site-header') && menu.classList.contains('open')) {
    menu.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
  }
});
```

**Button HTML:**
```html
<button class="hamburger" aria-label="Menu" aria-expanded="false">
  <svg width="24" height="24" aria-hidden="true">
    <!-- Hamburger icon -->
  </svg>
</button>
```

---

## Sticky vs Fixed Headers

**Use `position: sticky`** (better than fixed):

```css
.site-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(10, 14, 23, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid #1e293b;
}
```

**Why sticky beats fixed:**
- Doesn't remove element from document flow
- No need to add padding-top to body
- More predictable behavior with scroll anchoring
- Works better with `scroll-snap`

**Performance enhancement:**
```css
.site-header {
  will-change: transform;
  transform: translateZ(0);  /* GPU acceleration */
}
```

---

## Active State Highlighting

**Use classes instead of inline styles** for flexibility:

```javascript
// Better approach
const active = isActive(link.href);
return `<a href="${link.href}" class="${active ? 'active' : ''}">`;
```

```css
.site-header nav a.active {
  color: var(--accent);
  position: relative;
}

/* Animated underline on active */
.site-header nav a.active::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--accent);
  border-radius: 2px;
}
```

---

## Breadcrumbs

**When to use:**
- Multi-level content hierarchy (blog categories, project types)
- Long-form documentation sites
- E-commerce product categories

**Implementation:**
```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumbs">
    <li><a href="/">Home</a></li>
    <li><a href="/blog">Blog</a></li>
    <li aria-current="page">The 2 AM Pivot</li>
  </ol>
</nav>
```

```css
.breadcrumbs {
  display: flex;
  list-style: none;
  gap: 8px;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.breadcrumbs li:not(:last-child)::after {
  content: '/';
  margin-left: 8px;
  color: var(--text-dim);
}

.breadcrumbs a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s;
}

.breadcrumbs a:hover {
  color: var(--accent);
}

.breadcrumbs [aria-current="page"] {
  color: var(--text);
  font-weight: 500;
}
```

---

## Skip-to-Content Links

**CRITICAL FOR ACCESSIBILITY** — First focusable element on every page.

```html
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <nav>...</nav>
  <main id="main-content">...</main>
</body>
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--accent);
  color: var(--bg);
  padding: 8px 16px;
  text-decoration: none;
  border-radius: 0 0 4px 0;
  z-index: 1000;
  font-weight: 600;
}

.skip-link:focus {
  top: 0;
}
```

**How it works:**
- Hidden by default (positioned off-screen)
- Appears when focused via keyboard (Tab key)
- Clicking it jumps to main content, bypassing navigation
- Essential for screen reader users and keyboard navigation
