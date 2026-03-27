# Modern CSS Features

Container queries, CSS Grid, logical properties, scroll-snap, view transitions, :has(), and fluid typography.

---

## Container Queries

**Query the container instead of the viewport.**

```css
/* Old way - media queries */
@media (max-width: 768px) {
  .card { flex-direction: column; }
}

/* New way - container queries */
.sidebar {
  container-type: inline-size;
  container-name: sidebar;
}

@container sidebar (max-width: 300px) {
  .card { flex-direction: column; }
}
```

### Use Case — Card Adapts to Container Width

```css
.grid-container {
  container-type: inline-size;
}

.card {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 16px;
}

@container (max-width: 400px) {
  .card {
    grid-template-columns: 1fr;
  }
}
```

**Browser support:** Chrome 105+, Safari 16+, Firefox 110+ (2023+)

---

## CSS Grid Advanced Patterns

### Subgrid

Align nested grid items with parent grid.

```css
/* Parent grid */
.projects-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

/* Child inherits parent columns */
.project-card {
  display: grid;
  grid-template-rows: subgrid;
  grid-row: span 3;
}
```

### Named Grid Areas

Easier to read than line numbers:

```css
.layout {
  display: grid;
  grid-template-areas:
    "header header header"
    "sidebar content content"
    "footer footer footer";
  grid-template-columns: 200px 1fr 1fr;
  grid-template-rows: auto 1fr auto;
  gap: 24px;
}

.header { grid-area: header; }
.sidebar { grid-area: sidebar; }
.content { grid-area: content; }
.footer { grid-area: footer; }

/* Responsive - single column */
@media (max-width: 768px) {
  .layout {
    grid-template-areas:
      "header"
      "content"
      "sidebar"
      "footer";
    grid-template-columns: 1fr;
  }
}
```

### Auto-fit vs Auto-fill

```css
/* Auto-fit - collapses empty tracks */
grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));

/* Auto-fill - preserves empty tracks */
grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
```

We use `auto-fit` (correct for content-driven grids).

---

## Logical Properties

**Responsive to text direction and writing mode.**

```css
/* Old - physical properties */
margin-left: 16px;
padding-right: 24px;
border-top: 1px solid;

/* New - logical properties */
margin-inline-start: 16px;  /* Left in LTR, right in RTL */
padding-inline-end: 24px;   /* Right in LTR, left in RTL */
border-block-start: 1px solid;  /* Top in horizontal, left in vertical */
```

### Common Mappings (LTR)

- `margin-left` → `margin-inline-start`
- `margin-right` → `margin-inline-end`
- `margin-top` → `margin-block-start`
- `margin-bottom` → `margin-block-end`
- `width` → `inline-size`
- `height` → `block-size`

### Use Case — Internationalization

```css
.card {
  padding-inline: 24px;  /* Horizontal padding */
  padding-block: 32px;   /* Vertical padding */
  border-inline-start: 4px solid var(--accent);  /* Left border in LTR */
}

/* RTL support automatically */
html[dir="rtl"] .card {
  /* Border appears on right, no CSS changes needed */
}
```

---

## Scroll-Snap

**Snap to sections on scroll** (great for carousels, full-page sections).

```css
.scroll-container {
  scroll-snap-type: y mandatory;  /* Vertical snapping */
  overflow-y: scroll;
  height: 100vh;
}

.section {
  scroll-snap-align: start;  /* Snap to top of section */
  height: 100vh;
}
```

### Horizontal Carousel

```css
.carousel {
  display: flex;
  overflow-x: scroll;
  scroll-snap-type: x mandatory;
  gap: 16px;
}

.carousel-item {
  scroll-snap-align: center;
  flex: 0 0 300px;
}
```

### Accessibility — Allow Keyboard Navigation

```css
.carousel:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
```

---

## View Transitions

**Smooth transitions between pages/views** (Chrome 111+, experimental).

```css
/* Enable view transitions */
@view-transition {
  navigation: auto;
}

/* Customize transition */
::view-transition-old(root) {
  animation: fade-out 0.3s ease;
}

::view-transition-new(root) {
  animation: fade-in 0.3s ease;
}

@keyframes fade-out {
  to { opacity: 0; }
}

@keyframes fade-in {
  from { opacity: 0; }
}
```

### JavaScript API

```javascript
// Transition to new content
document.startViewTransition(() => {
  // Update DOM
  document.body.innerHTML = newContent;
});
```

**Not widely supported yet** — Use as progressive enhancement.

---

## `:has()` Selector

**Parent selector** — Style parent based on children.

```css
/* Card with image gets different layout */
.card:has(img) {
  display: grid;
  grid-template-columns: 200px 1fr;
}

/* Form with errors shows error state */
form:has(input:invalid) {
  border-color: #ef4444;
}

/* Nav with active link */
nav:has(a.active) {
  border-bottom: 2px solid var(--accent);
}

/* List item with checkbox checked */
li:has(input[type="checkbox"]:checked) {
  text-decoration: line-through;
  opacity: 0.6;
}
```

**Browser support:** Chrome 105+, Safari 15.4+, Firefox 121+ (late 2023+)

---

## `clamp()` for Fluid Typography

**We already use this!**

```css
/* Our current usage */
.hero h1 {
  font-size: clamp(2.2rem, 5vw, 3.5rem);
}

/* Breakdown: clamp(min, preferred, max) */
/* - 2.2rem on small screens */
/* - 5vw scales with viewport */
/* - 3.5rem maximum on large screens */
```

### Advanced — Fluid Spacing

```css
.section {
  padding-block: clamp(3rem, 8vw, 8rem);  /* 48px to 128px */
}

.container {
  max-width: clamp(320px, 90%, 1100px);
}
```

### Calculate Perfect Scale

```
preferred = minValue + (maxValue - minValue) * (100vw - minWidth) / (maxWidth - minWidth)

Example: 16px @ 375px → 24px @ 1440px
preferred = 16px + (24 - 16) * (100vw - 375px) / (1440 - 375)
         = 16px + 8 * (100vw - 375px) / 1065
         = 1rem + 0.75vw - 2.82px

clamp(1rem, 0.75vw + 0.82rem, 1.5rem)
```

**Online calculators:**
- https://clamp.font-size.app/
- https://min-max-calculator.9elements.com/
