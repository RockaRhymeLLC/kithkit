---
name: web-design
description: Apply modern web design patterns, WCAG 2.1 AA accessibility standards, and brand guidelines when building web pages. Use when designing or implementing websites or web applications.
user-invocable: false
---

# Web Design Reference

Reference skill for building modern, accessible websites. Provides patterns, standards, and brand guidelines for the project.

## Purpose

When building or updating web pages, this skill provides:
- **Critical accessibility requirements** (WCAG 2.1 AA compliance)
- **Modern CSS patterns** and performance best practices
- **Brand guidelines** for consistent visual identity (customize in `brand-guidelines.md`)
- **Navigation patterns** and common UI components
- **Pre-launch checklist** to catch issues before shipping

## Key Directives

Every page MUST have these accessibility essentials:

- [ ] **Skip-to-content link** — First focusable element: `<a href="#main-content" class="skip-link">Skip to main content</a>`
- [ ] **`<main>` landmark** — Wrap primary content in `<main id="main-content">`
- [ ] **Focus indicators** — Visible outlines on all interactive elements (`:focus-visible` with `2px solid var(--accent)`)
- [ ] **`aria-expanded` on toggles** — Hamburger menus and collapsible sections must track state
- [ ] **44px minimum touch targets** — All interactive elements (buttons, links, inputs) must meet WCAG touch target size
- [ ] **`prefers-reduced-motion` support** — Disable animations for users who need it
- [ ] **Semantic HTML** — Use `<nav>`, `<article>`, `<header>`, `<footer>`, proper heading hierarchy (h1→h2→h3, no skips)
- [ ] **Color contrast** — All text passes WCAG AA ratios (4.5:1 for normal text, 3:1 for large text)

## Quick Reference

### Color Palette

Define your color palette in `brand-guidelines.md`

### Typography

- **Code/Terminal**: Use monospace fonts for code/terminal content (e.g., JetBrains Mono, Fira Code)
- **Body/UI**: Inter (400-800)
- **Hero H1**: `clamp(2.2rem, 5vw, 3.5rem)` weight 700
- **Section Title**: `clamp(1.6rem, 3vw, 2.2rem)` weight 700
- **Body**: 0.9-1.05rem, weight 400, line-height 1.6

### Breakpoints

- **Desktop**: 769px+
- **Mobile**: 768px and below

## Page Launch Checklist

Before shipping any new page:

**Accessibility**
- [ ] Skip-to-content link (first element after `<body>`)
- [ ] `<main>` landmark with `id="main-content"`
- [ ] Proper heading hierarchy (h1 → h2 → h3, no skips)
- [ ] All images have alt text (or `alt=""` + `role="presentation"` for decorative)
- [ ] All interactive elements ≥ 44×44px touch targets
- [ ] Focus indicators visible on all focusable elements
- [ ] Color contrast ≥ 4.5:1 for text, ≥ 3:1 for UI components
- [ ] Semantic HTML (`<nav>`, `<main>`, `<article>`, `<header>`, `<footer>`)
- [ ] ARIA labels on icon-only buttons
- [ ] `aria-live` regions for dynamic content
- [ ] Keyboard navigation works (Tab, Enter, Escape)
- [ ] `prefers-reduced-motion` support

**Responsive**
- [ ] Test at 320px, 768px, 1440px widths
- [ ] Mobile nav collapses to hamburger
- [ ] Grids respond properly
- [ ] Touch targets remain ≥ 44px on mobile

**SEO & Social**
- [ ] OG tags (title, description, image, url)
- [ ] Twitter card
- [ ] Canonical URL
- [ ] Structured data (JSON-LD)

**UX**
- [ ] Loading states for async content
- [ ] Empty states for no-content scenarios
- [ ] Error states for failures

## Reference Docs

Load these files for detailed guidance on specific topics:

- **`navigation.md`** — Navigation patterns (hamburger menus, sticky headers, active states, breadcrumbs, skip links)
- **`accessibility.md`** — WCAG 2.1 AA compliance (contrast, focus, ARIA, screen readers, touch targets, reduced motion, forms)
- **`design-principles.md`** — Typography scales, spacing, card layouts, dark theme theory, micro-interactions, loading states
- **`performance.md`** — Critical rendering path, font loading, images, CSS performance, progressive enhancement
- **`modern-css.md`** — Container queries, CSS Grid, logical properties, scroll-snap, view transitions, :has(), clamp()
- **`seo.md`** — Structured data, Open Graph, canonical URLs, robots.txt, sitemap
- **`brand-guidelines.md`** — Brand visual identity, color palette, typography, components, voice & tone

## Usage Pattern

When building a page:
1. Start with the checklist above (critical accessibility requirements)
2. Reference brand guidelines for colors, fonts, spacing
3. Use navigation.md for header/nav patterns
4. Check accessibility.md for ARIA and semantic HTML
5. Run through the launch checklist before shipping

## Notes

- Never use pure black (#000) or pure white (#fff) — use palette variables
- Cards lift 2px on hover, buttons lift 1px — keep micro-interactions subtle
