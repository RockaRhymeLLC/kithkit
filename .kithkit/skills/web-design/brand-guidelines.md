# Brand Guidelines

Customize this file with your project's brand identity.

## Color Palette

Define your WCAG AA compliant color palette here:

```css
:root {
  /* Backgrounds */
  --bg: #ffffff;
  --bg-card: #f8f9fa;

  /* Text */
  --text: #212529;
  --text-muted: #6c757d;

  /* Accent */
  --accent: #0d6efd;

  /* Borders */
  --border: #dee2e6;
}
```

### Contrast Requirements

All text must pass WCAG AA:
- Normal text: 4.5:1 contrast ratio minimum
- Large text (18px+ bold, 24px+ regular): 3:1 minimum
- UI components: 3:1 minimum

Tools: [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)

## Typography

Define your font stack:
- **Headings**: Sans-serif (e.g., Inter, system-ui)
- **Body**: Sans-serif (e.g., Inter, system-ui)
- **Code**: Monospace (e.g., JetBrains Mono, Fira Code)

## Components

### Cards
- Background: `var(--bg-card)`
- Border radius: 8px
- Hover: subtle lift (2px translateY)

### Buttons
- Primary: `var(--accent)` background, white text
- Minimum size: 44x44px (touch target)
- Border radius: 6px

## Voice & Tone

Define your brand's communication style here. Consider:
- Formal vs. casual
- Technical vs. approachable
- Specific terminology preferences
