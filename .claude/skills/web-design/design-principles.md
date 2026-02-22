# Design Principles

Typography, spacing, color theory, and micro-interactions for modern dark-theme websites.

---

## Visual Hierarchy and Typography Scale

### Formal Type Scale (1.25 ratio)

```css
:root {
  /* Base */
  --font-base: 1rem;      /* 16px */

  /* Scale up */
  --font-lg: 1.25rem;     /* 20px */
  --font-xl: 1.563rem;    /* 25px */
  --font-2xl: 1.953rem;   /* 31px */
  --font-3xl: 2.441rem;   /* 39px */
  --font-4xl: 3.052rem;   /* 49px */

  /* Scale down */
  --font-sm: 0.8rem;      /* 13px */
  --font-xs: 0.64rem;     /* 10px */
}

/* Apply to elements */
h1 { font-size: clamp(var(--font-2xl), 5vw, var(--font-4xl)); }
h2 { font-size: clamp(var(--font-xl), 3vw, var(--font-2xl)); }
h3 { font-size: var(--font-lg); }
p { font-size: var(--font-base); }
small, .text-sm { font-size: var(--font-sm); }
```

### Line Height Rules

```css
/* Headings - tighter line-height */
h1, h2, h3, h4 {
  line-height: 1.2;
  letter-spacing: -0.02em;  /* Tighter tracking for large text */
}

/* Body text - generous for readability */
p, li, td {
  line-height: 1.6;
}

/* Small text - slightly tighter */
.text-sm {
  line-height: 1.5;
}
```

### Measure (line length)

45-75 characters per line for optimal readability.

```css
.hero p {
  max-width: 600px;  /* ~75 chars at 1.15rem */
}

.section-desc {
  max-width: 560px;  /* ~70 chars at 1.05rem */
}

/* For long-form content (blog posts) */
.prose {
  max-width: 65ch;  /* ch unit = width of "0" character */
}
```

---

## Whitespace and Density

### Spacing Scale (8px base)

```css
:root {
  --space-1: 0.25rem;  /* 4px */
  --space-2: 0.5rem;   /* 8px */
  --space-3: 0.75rem;  /* 12px */
  --space-4: 1rem;     /* 16px */
  --space-5: 1.5rem;   /* 24px */
  --space-6: 2rem;     /* 32px */
  --space-8: 3rem;     /* 48px */
  --space-10: 4rem;    /* 64px */
  --space-12: 6rem;    /* 96px */
}

/* Apply consistently */
.card {
  padding: var(--space-6);  /* 32px */
}

.section {
  padding: var(--space-10) 0;  /* 64px vertical */
}

.grid {
  gap: var(--space-5);  /* 24px */
}
```

### Density Guidelines

- **Cards:** 24-32px padding for comfortable breathing room
- **Sections:** 64-96px vertical spacing between major sections
- **Text blocks:** 16-24px margin-bottom for paragraphs
- **Grids:** 16-24px gap for tight layouts, 32-48px for airy layouts

---

## Card-Based Layouts

### Good Card Design

```css
.card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);  /* 12px */
  padding: var(--space-6);       /* 32px */
  transition: all 0.25s ease;
}

.card:hover {
  background: var(--bg-card-hover);
  border-color: var(--accent-dim);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

/* Internal spacing hierarchy */
.card h3 {
  margin-bottom: var(--space-2);  /* 8px */
}

.card p {
  margin-bottom: var(--space-4);  /* 16px */
}
```

### Card Grid Patterns

```css
/* Auto-fit grid (what we use) */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
}

/* Responsive 2→1 */
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
}

@media (max-width: 768px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}

/* Flexbox masonry-ish effect */
.flex-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
}

.flex-grid > * {
  flex: 1 1 280px;
}
```

---

## Color Theory for Dark Themes

### Dark Theme Principles

1. **Never pure black** — Use very dark blue/gray (#0a0e17, not #000000)
   - Pure black is harsh and causes eye strain
   - Tinted blacks feel more natural

2. **Layer backgrounds** — Create depth with subtle variations
   ```css
   body { background: var(--bg); }
   .card { background: var(--bg-card); }  /* +2-3 shades lighter */
   .card:hover { background: var(--bg-card-hover); }  /* +1 shade */
   ```

3. **Desaturate colors** — Bright colors are jarring on dark
   ```css
   /* Bad: Pure red on dark */
   --error: #ff0000;  /* Eye-searing */

   /* Good: Desaturated, slightly lighter red */
   --error: #ef4444;  /* Softer */
   ```

4. **Use glows instead of shadows**
   ```css
   /* Light theme - drop shadow */
   box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);

   /* Dark theme - subtle glow */
   box-shadow: 0 4px 12px rgba(34, 211, 238, 0.1);
   ```

5. **Accent colors should be lighter than light-theme equivalents**
   ```css
   /* Light theme accent - darker */
   --accent-light: #0891b2;

   /* Dark theme accent - lighter (what we use) */
   --accent-dark: #22d3ee;
   ```

---

## Micro-interactions and Transitions

### Button Hover States

```css
.button {
  background: var(--accent);
  color: var(--bg);
  padding: 14px 28px;
  border-radius: 8px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.button:hover {
  background: #06b6d4;
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(34, 211, 238, 0.25);
}

.button:active {
  transform: translateY(0);
  transition-duration: 0.1s;
}
```

### Card Hover

```css
.card {
  transition: all 0.25s ease;
}

.card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-dim);
}

/* Stagger animation for grid items */
.card:nth-child(1) { transition-delay: 0ms; }
.card:nth-child(2) { transition-delay: 50ms; }
.card:nth-child(3) { transition-delay: 100ms; }
```

### Link Underline Animation

```css
a {
  color: var(--accent);
  text-decoration: none;
  position: relative;
}

a::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  width: 0;
  height: 2px;
  background: var(--accent);
  transition: width 0.3s ease;
}

a:hover::after {
  width: 100%;
}
```

### Easing Functions

- `ease-out` — Fast start, slow end (most UI interactions)
- `ease-in-out` — Smooth both ends (modals, page transitions)
- `cubic-bezier(0.4, 0, 0.2, 1)` — Material Design standard (good default)

---

## Loading States and Skeleton Screens

### Skeleton Screen Pattern

```html
<div class="card skeleton">
  <div class="skeleton-line skeleton-title"></div>
  <div class="skeleton-line skeleton-text"></div>
  <div class="skeleton-line skeleton-text" style="width: 80%;"></div>
</div>
```

```css
.skeleton {
  pointer-events: none;
}

.skeleton-line {
  height: 1em;
  background: linear-gradient(
    90deg,
    var(--bg-card) 0%,
    var(--bg-card-hover) 50%,
    var(--bg-card) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-loading 1.5s ease-in-out infinite;
  border-radius: 4px;
  margin-bottom: 8px;
}

.skeleton-title {
  height: 1.5em;
  width: 60%;
}

@keyframes skeleton-loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

### Spinner (for short waits)

```html
<div class="spinner" role="status" aria-label="Loading">
  <svg viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="10" />
  </svg>
</div>
```

```css
.spinner {
  width: 24px;
  height: 24px;
}

.spinner circle {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-dasharray: 60;
  stroke-dashoffset: 0;
  animation: spinner 1.5s ease-in-out infinite;
}

@keyframes spinner {
  0% {
    stroke-dashoffset: 0;
    transform: rotate(0deg);
  }
  50% {
    stroke-dashoffset: -45;
  }
  100% {
    stroke-dashoffset: -90;
    transform: rotate(360deg);
  }
}
```

---

## Empty States

When there's no content to show:

```html
<div class="empty-state">
  <svg class="empty-icon">...</svg>
  <h3>No projects yet</h3>
  <p>Create your first project to get started.</p>
  <a href="/new" class="button">Create project</a>
</div>
```

```css
.empty-state {
  text-align: center;
  padding: var(--space-12) var(--space-5);
  color: var(--text-muted);
}

.empty-icon {
  width: 64px;
  height: 64px;
  margin-bottom: var(--space-4);
  opacity: 0.3;
}

.empty-state h3 {
  color: var(--text);
  margin-bottom: var(--space-2);
}
```
