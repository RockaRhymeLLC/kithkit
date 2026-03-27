# Performance Best Practices

Critical rendering path, font loading, images, and progressive enhancement.

---

## Critical Rendering Path

**Order of operations for fast First Contentful Paint (FCP):**

1. **Inline critical CSS** — Above-the-fold styles in `<head>`
2. **Defer non-critical CSS** — Load rest asynchronously
3. **Async JavaScript** — Don't block rendering

### Our Current Approach (Good for Small Sites)

```html
<!-- Inline styles in <head> -->
<style>
  /* All our CSS is inline - good for small sites */
</style>

<!-- Fonts loaded with preconnect -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

### For Larger Sites, Split CSS

```html
<head>
  <!-- Critical CSS inline -->
  <style>
    /* Only above-the-fold styles */
    :root { --bg: #0a0e17; ... }
    body { font-family: Inter, sans-serif; ... }
    .hero { ... }
  </style>

  <!-- Non-critical CSS async -->
  <link rel="preload" href="/styles.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="/styles.css"></noscript>
</head>
```

### JavaScript Loading

```html
<!-- Current (blocks rendering) -->
<script src="/nav.js"></script>

<!-- Better: defer or async -->
<script src="/nav.js" defer></script>  <!-- Waits for DOM, maintains order -->
<script src="/analytics.js" async></script>  <!-- ASAP, doesn't block -->
```

**`defer` vs `async`:**
- `defer` — Download in parallel, execute in order after DOM ready
- `async` — Download in parallel, execute ASAP (unordered)
- Use `defer` for dependencies, `async` for standalone scripts

---

## Font Loading Strategies

**FOIT (Flash of Invisible Text)** — Text hidden until font loads (browser default)
**FOUT (Flash of Unstyled Text)** — System font first, then custom font

### Current Approach (Good)

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

The `display=swap` parameter tells the browser to use FOUT.

### Better — Add Font Face with Local Fallback

```css
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;  /* Show fallback immediately */
  src: local('Inter'), url('https://fonts.gstatic.com/...') format('woff2');
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

### Self-Host Fonts for Best Performance

```html
<!-- Preload critical font -->
<link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin>

<style>
@font-face {
  font-family: 'Inter';
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/inter-400.woff2') format('woff2');
}
</style>
```

### Variable Fonts

Single file for all weights (Google Fonts supports this):

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap" rel="stylesheet">
```

---

## Image Optimization

### WebP with Fallback

```html
<picture>
  <source srcset="/image.webp" type="image/webp">
  <source srcset="/image.jpg" type="image/jpeg">
  <img src="/image.jpg" alt="Description" loading="lazy">
</picture>
```

### Lazy Loading

```html
<!-- Native lazy loading (modern browsers) -->
<img src="/image.jpg" alt="..." loading="lazy">

<!-- Eager for above-the-fold images -->
<img src="/hero.jpg" alt="..." loading="eager">
```

### Responsive Images with `srcset`

```html
<img
  src="/image-800.jpg"
  srcset="
    /image-400.jpg 400w,
    /image-800.jpg 800w,
    /image-1200.jpg 1200w
  "
  sizes="(max-width: 768px) 100vw, 800px"
  alt="Description"
  loading="lazy"
>
```

### SVG Optimization

```bash
# Use SVGO to minify
npm install -g svgo
svgo input.svg -o output.svg

# Inline small SVGs (< 2KB) to avoid HTTP requests
```

**Our Current Usage:**
```html
<!-- Inline SVG favicon (good for small icons) -->
<link rel="icon" href="data:image/svg+xml,<svg...">

<!-- Agent avatars are inline SVG -->
```

---

## CSS Best Practices

### Avoid Over-Specificity

```css
/* Bad - overly specific */
body div.container section.hero div.hero-content h1.hero-title {
  font-size: 3rem;
}

/* Good - low specificity */
.hero-title {
  font-size: 3rem;
}
```

### Avoid `!important`

```css
/* Bad - creates specificity war */
.text { color: var(--text) !important; }

/* Good - use more specific selector */
.card .text { color: var(--text); }
```

### Group Related Styles

```css
/* Good - organized by component */
.card { ... }
.card-header { ... }
.card-body { ... }

/* Bad - scattered throughout file */
.card { ... }
.nav { ... }
.card-header { ... }
```

### Use CSS Custom Properties

```css
:root {
  --accent: #22d3ee;
}

/* Easy to theme */
.button { background: var(--accent); }
.link { color: var(--accent); }
```

### Minimize Expensive Properties

```css
/* Expensive - causes reflow */
width, height, margin, padding, border, display, position, top, left, etc.

/* Cheap - GPU composited */
transform, opacity, filter

/* Use transform instead of position changes */
/* Bad */
.card:hover {
  top: -2px;
}

/* Good */
.card:hover {
  transform: translateY(-2px);
}
```

---

## Progressive Enhancement

**Start with HTML, layer on CSS and JS.**

### Example — Hamburger Menu

```html
<!-- Works without JavaScript (desktop view) -->
<nav>
  <ul class="nav-links">
    <li><a href="/">Home</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>

<!-- JavaScript adds mobile toggle -->
<script>
  if (window.innerWidth < 768) {
    // Add hamburger button
    // Add toggle behavior
  }
</script>
```

### Example — Form

```html
<!-- Works without JavaScript (posts to server) -->
<form action="/contact" method="POST">
  <input name="email" required>
  <button type="submit">Send</button>
</form>

<!-- JavaScript enhances with validation and AJAX -->
<script>
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    await fetch('/contact', { method: 'POST', body: data });
  });
</script>
```
