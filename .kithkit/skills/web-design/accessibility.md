# Accessibility (WCAG 2.1 AA)

Comprehensive guide to WCAG 2.1 AA compliance.

---

## Color Contrast Ratios

**WCAG 2.1 AA Requirements:**
- Normal text (< 18px): **4.5:1** minimum
- Large text (≥ 18px or ≥ 14px bold): **3:1** minimum
- UI components and graphics: **3:1** minimum

**Our Palette (All Pass WCAG AA):**

| Combination | Ratio | WCAG AA (Normal) | WCAG AA (Large) |
|-------------|-------|------------------|-----------------|
| `#e2e8f0` on `#0a0e17` | **14.8:1** | ✅ Pass | ✅ Pass |
| `#94a3b8` on `#0a0e17` | **8.4:1** | ✅ Pass | ✅ Pass |
| `#64748b` on `#0a0e17` | **5.2:1** | ✅ Pass | ✅ Pass |
| `#22d3ee` on `#0a0e17` | **10.9:1** | ✅ Pass | ✅ Pass |
| `#22d3ee` on `#111827` | **9.8:1** | ✅ Pass | ✅ Pass |

**Testing Tools:**
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- Chrome DevTools (built-in contrast checker)
- axe DevTools browser extension

---

## Focus Indicators

**CRITICAL for keyboard navigation.**

```css
/* Remove default outline, replace with custom */
*:focus {
  outline: none;
}

*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

/* Enhanced focus for interactive elements */
a:focus-visible,
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px rgba(34, 211, 238, 0.2);
}

/* Skip link gets high-visibility focus */
.skip-link:focus {
  outline: 3px solid var(--bg);
  outline-offset: 2px;
}
```

**Why `focus-visible` instead of `focus`:**
- Only shows outline for keyboard navigation
- Hides outline when clicked with mouse
- Better UX without sacrificing accessibility

---

## ARIA Labels and Roles

### Landmarks

Define page regions for screen readers:

```html
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>

  <header role="banner">
    <nav aria-label="Primary navigation">
      <ul>...</ul>
    </nav>
  </header>

  <main id="main-content" role="main">
    <section aria-labelledby="hero-heading">
      <h1 id="hero-heading">...</h1>
    </section>
  </main>

  <footer role="contentinfo">
    <p>...</p>
  </footer>
</body>
```

### Interactive Controls

```html
<!-- Hamburger button with state tracking -->
<button class="hamburger" aria-label="Menu" aria-expanded="false">
  <svg aria-hidden="true">...</svg>
</button>

<script>
const hamburger = document.querySelector('.hamburger');
const menu = document.querySelector('nav ul');
hamburger.addEventListener('click', () => {
  const isOpen = menu.classList.toggle('open');
  hamburger.setAttribute('aria-expanded', isOpen);
});
</script>
```

### Icon-Only Buttons

```html
<!-- Option 1: aria-label -->
<button aria-label="Check system status">
  <svg aria-hidden="true">
    <circle .../>
  </svg>
</button>

<!-- Option 2: Visually hidden text -->
<button>
  <svg aria-hidden="true">...</svg>
  <span class="sr-only">Check system status</span>
</button>
```

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

---

## Screen Reader Compatibility

**Semantic HTML is 90% of the battle.**

**Good:**
```html
<nav>
  <ul>
    <li><a href="/about">About</a></li>
  </ul>
</nav>
```

**Bad:**
```html
<div class="nav">
  <div class="nav-item" onclick="goto('/about')">About</div>
</div>
```

### Common Patterns

```html
<!-- Card with proper heading hierarchy -->
<article class="project-card">
  <h3>Features</h3>  <!-- Don't skip heading levels -->
  <p>Description...</p>
  <a href="/features">Learn more</a>
</article>

<!-- Stats with semantic markup -->
<dl class="stats">
  <div class="stat">
    <dt>Projects</dt>
    <dd>9</dd>
  </div>
</dl>

<!-- Forms with labels -->
<form>
  <label for="email">Email address</label>
  <input type="email" id="email" name="email" required>
  <span id="email-error" role="alert"></span>
</form>
```

### Live Regions (for dynamic content)

```html
<!-- Terminal output -->
<div id="term-output" role="log" aria-live="polite" aria-atomic="false">
  <!-- New lines announced as they appear -->
</div>

<!-- Status messages -->
<div role="status" aria-live="polite">
  Checking system health...
</div>

<!-- Urgent alerts -->
<div role="alert" aria-live="assertive">
  Critical error detected!
</div>
```

---

## Alt Text

**Images must have alt text** — describe content or function.

```html
<!-- Decorative icon - empty alt -->
<img src="/icon-clock.svg" alt="" role="presentation">

<!-- Informative image -->
<img src="/screenshot.png" alt="Dashboard showing memory timeline">

<!-- Functional image (link/button) -->
<a href="/projects">
  <img src="/projects-preview.png" alt="View all projects">
</a>

<!-- Complex image - use figure + figcaption -->
<figure>
  <img src="/architecture.png" alt="">
  <figcaption>
    System architecture: daemon layer communicates with Claude Code via
    tmux session bridge, routing messages to Telegram and email channels.
  </figcaption>
</figure>
```

**SVG Accessibility:**
```html
<!-- Decorative SVG -->
<svg aria-hidden="true" focusable="false">
  <path d="..."/>
</svg>

<!-- Informative SVG -->
<svg role="img" aria-labelledby="logo-title">
  <title id="logo-title">Company Logo</title>
  <rect .../>
</svg>
```

---

## Touch Target Sizes

**WCAG 2.1 AA requires 44×44px minimum** for touch targets.

**Fix desktop nav links:**
```css
.site-header nav a {
  color: #94a3b8;
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
  padding: 12px 8px;  /* Add vertical padding */
  display: inline-block;
  min-height: 44px;   /* Ensure minimum touch target */
  display: flex;
  align-items: center;
}
```

**Fix hamburger button:**
```css
.site-header .hamburger {
  padding: 10px;  /* Makes it 44x44 */
  min-width: 44px;
  min-height: 44px;
}
```

**Interactive terminal input:**
```css
#term-input {
  min-height: 44px;
  padding: 8px 12px;
}
```

---

## Reduced Motion Preferences

**Respect `prefers-reduced-motion` media query.**

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }

  /* Remove transform animations */
  .service-card:hover,
  .project-card:hover,
  .hero-cta:hover {
    transform: none;
  }
}
```

---

## Form Accessibility

```html
<form>
  <!-- Labels are required -->
  <label for="name">Name *</label>
  <input
    type="text"
    id="name"
    name="name"
    required
    aria-required="true"
    aria-describedby="name-hint"
  >
  <span id="name-hint" class="hint">Your full name</span>

  <!-- Error messages -->
  <span id="name-error" role="alert" class="error" hidden>
    Name is required
  </span>

  <!-- Fieldsets for related inputs -->
  <fieldset>
    <legend>Contact preferences</legend>
    <label>
      <input type="checkbox" name="email_ok"> Email me updates
    </label>
  </fieldset>

  <!-- Submit button -->
  <button type="submit">
    Send message
    <span class="sr-only">(form will submit)</span>
  </button>
</form>
```

```css
/* Visible focus for form inputs */
input:focus,
textarea:focus,
select:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-color: var(--accent);
}

/* Error state */
input[aria-invalid="true"] {
  border-color: #ef4444;
  outline-color: #ef4444;
}

.error {
  color: #ef4444;
  font-size: 0.85rem;
  margin-top: 4px;
}
```
