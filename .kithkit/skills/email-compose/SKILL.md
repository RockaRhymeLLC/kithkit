---
name: email-compose
description: Compose professional, well-designed HTML emails with proper formatting, bulletproof buttons, and responsive layouts. Use when sending important emails that need to look polished.
user-invocable: false
---

# Email Composition — Professional HTML Styling

When composing HTML emails, follow these guidelines to produce clean, professional, well-formatted messages that render correctly across all email clients (Outlook, Gmail, Apple Mail, mobile).

## When to Apply

Apply HTML styling when:
- The email contains structured data (lists, tables, schedules, comparisons)
- The email is going to multiple recipients or needs to look polished
- The user asks for a "nice" or "professional" email
- The content benefits from visual hierarchy (headings, sections, emphasis)

For quick one-liner replies or casual messages, plain text is fine.

## Sending HTML Emails

Use the `--html` flag with `graph.js`:

```bash
node scripts/email/graph.js send "to@email.com" "Subject" "<html>...</html>" --html
```

## Core Rules

### 1. Table-Based Layout (Non-Negotiable)

Use `<table>` for ALL layout. No divs, flexbox, or grid.

```html
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
  <tr>
    <td style="padding: 20px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.5; color: #333333;">
      Content here
    </td>
  </tr>
</table>
```

### 2. Inline Styles (Mandatory)

Gmail strips `<style>` blocks. Every visible style MUST be inline. Only use `<style>` for media queries and dark mode (progressive enhancement).

### 3. 600px Max Width

```html
<table role="presentation" width="100%" style="max-width: 600px; margin: 0 auto;">
```

### 4. Web-Safe Fonts Only

- Body: `font-family: Arial, Helvetica, sans-serif;`
- Headers: `font-family: Helvetica, Arial, sans-serif;`
- Code: `font-family: 'Courier New', Courier, monospace;`

### 5. Use Proper Anchor Text for Links

Never show raw URLs. Always use descriptive clickable text:
```html
<a href="https://example.com" style="color: #0077CC; text-decoration: underline;">View the Details</a>
```

This avoids SafeLinks ugliness and improves accessibility.

## Quick Reference

| Property | Value |
|----------|-------|
| Max width | 600px |
| Body font | 16px min, Arial |
| Headings | 24-28px (H1), 20-22px (H2) |
| Line height | 1.5 for body |
| Text color | #333333 (body), #222222 (headings), #666666 (secondary) |
| Background | #F4F4F4 (outer), #FFFFFF (content) |
| Link color | Brand color, underlined |
| Button min size | 44px height, 48px preferred |
| Max email size | 102KB (Gmail clips above this) |

## Color Palette (Default Professional)

| Role | Color |
|------|-------|
| Heading text | `#222222` |
| Body text | `#333333` |
| Secondary text | `#666666` |
| Muted/footer text | `#999999` |
| Content background | `#FFFFFF` |
| Outer background | `#F4F4F4` |
| Links/accent | `#0077CC` |
| Dividers | `#E5E5E5` |
| Success/positive | `#28a745` |
| Warning | `#FFC107` |
| Urgent/error | `#dc3545` |

## Email Structure Template

Every polished email should follow this skeleton:

```
[Preheader text — hidden, 40-130 chars]
[Outer wrapper — #F4F4F4 background]
  [Inner container — 600px, white background]
    [Header — optional logo/title area]
    [Body — headings, paragraphs, lists]
    [CTA — bulletproof button if needed]
    [Footer — sign-off]
```

## Component Patterns

### Hidden Preheader

```html
<div style="display: none; max-height: 0; overflow: hidden; mso-hide: all;">
  Preview text that complements the subject line.
  &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
</div>
```

### Section Heading

```html
<tr>
  <td style="padding: 20px 30px 10px 30px; font-family: Helvetica, Arial, sans-serif; font-size: 22px; font-weight: bold; line-height: 1.3; color: #222222;">
    Section Title
  </td>
</tr>
```

### Body Paragraph

```html
<tr>
  <td style="padding: 0 30px 15px 30px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.5; color: #333333;">
    Paragraph text goes here. Keep to 2-3 sentences.
  </td>
</tr>
```

### Styled List

```html
<tr>
  <td style="padding: 0 30px 15px 30px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 1.6; color: #333333;">
    <ul style="margin: 0; padding: 0 0 0 20px;">
      <li style="padding-bottom: 8px;">First item</li>
      <li style="padding-bottom: 8px;">Second item</li>
      <li style="padding-bottom: 0;">Third item</li>
    </ul>
  </td>
</tr>
```

### Info/Callout Box

```html
<tr>
  <td style="padding: 10px 30px;">
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"
      style="background-color: #e7f3fe; border-left: 4px solid #2196F3; border-radius: 4px;">
      <tr>
        <td style="padding: 16px 20px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.5; color: #31708f;">
          <strong style="color: #1a5276;">Note:</strong> Important information here.
        </td>
      </tr>
    </table>
  </td>
</tr>
```

Callout variants:

| Type | Background | Border | Text |
|------|-----------|--------|------|
| Info | `#e7f3fe` | `#2196F3` | `#31708f` |
| Success | `#e8f5e9` | `#4CAF50` | `#2e7d32` |
| Warning | `#fff8e1` | `#FFC107` | `#856404` |
| Urgent | `#fdecea` | `#f44336` | `#a94442` |

### Data Table

```html
<tr>
  <td style="padding: 10px 30px;">
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"
      style="border-collapse: collapse;">
      <tr style="background-color: #0077CC;">
        <th style="padding: 10px 14px; font-family: Arial, sans-serif; font-size: 14px; color: #ffffff; text-align: left;">Column 1</th>
        <th style="padding: 10px 14px; font-family: Arial, sans-serif; font-size: 14px; color: #ffffff; text-align: left;">Column 2</th>
      </tr>
      <tr style="background-color: #f9f9f9;">
        <td style="padding: 10px 14px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #e0e0e0;">Data</td>
        <td style="padding: 10px 14px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #e0e0e0;">Data</td>
      </tr>
    </table>
  </td>
</tr>
```

### Bulletproof CTA Button

```html
<tr>
  <td align="center" style="padding: 20px 30px;">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 0 auto;">
      <tr>
        <td align="center" bgcolor="#0077CC" style="border-radius: 6px; background-color: #0077CC;">
          <a href="https://example.com" target="_blank"
             style="display: inline-block; padding: 14px 32px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; font-weight: bold; color: #ffffff; text-decoration: none; border-radius: 6px; background-color: #0077CC; line-height: 1;">
            Call to Action
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Divider

```html
<tr>
  <td style="padding: 15px 30px;">
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-top: 1px solid #E5E5E5; font-size: 1px; line-height: 1px;">&nbsp;</td>
      </tr>
    </table>
  </td>
</tr>
```

## Anti-Patterns (Avoid These)

- Raw URLs instead of linked text
- Image-only emails (invisible when images are off)
- Multiple competing CTAs (one primary per email)
- Centered body text (left-align for readability)
- Tiny text under 14px
- `<div>` for layout (breaks Outlook)
- External CSS or `<style>` for critical styles
- ALL CAPS body text
- Pure white (#FFF) / pure black (#000) — use off-values for dark mode compatibility

## Subject Line Tips

- 5-7 words, 40-50 characters
- Front-load key info in first 25 characters
- Be specific: "Camp Picks for Grant & Gabe" beats "Check This Out!"
- No ALL CAPS, max one exclamation mark

## Accessibility

- `role="presentation"` on all layout tables
- `lang="en"` on `<html>` tag
- Descriptive link text (never "click here")
- 4.5:1 contrast ratio minimum
- Alt text on all images
- Minimum 44x44px touch targets for buttons/links

## References

For detailed component patterns, boilerplate code, responsive techniques, dark mode CSS, and color schemes, see [reference.md](reference.md).
