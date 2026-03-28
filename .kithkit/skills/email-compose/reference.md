# HTML Email Template Patterns & Building Blocks

Compiled research on battle-tested, reusable HTML email patterns that work across Outlook (Word rendering engine), Gmail, Apple Mail, and mobile clients.

**Sources:** Cerberus, Good Email Code, Litmus, Campaign Monitor, MJML, Maizzle, Email on Acid, Mailtrap, Stack Overflow Design System, EDM Designer.

---

## Table of Contents

1. [Email Boilerplate (Full Wrapper)](#1-email-boilerplate)
2. [CSS Resets](#2-css-resets)
3. [Container / Centered Column](#3-container)
4. [Single-Column Layout](#4-single-column-layout)
5. [Two-Column Layout (Hybrid/Ghost Tables)](#5-two-column-layout)
6. [Three-Column Layout](#6-three-column-layout)
7. [Header with Logo/Title](#7-header)
8. [Section with Heading + Body](#8-section-block)
9. [Typography (Headings, Paragraphs, Font Stacks)](#9-typography)
10. [Bullet/Feature Lists](#10-lists)
11. [CTA Buttons (Bulletproof)](#11-buttons)
12. [Info Cards / Callout Boxes](#12-callout-boxes)
13. [Data Tables](#13-data-tables)
14. [Dividers / Separators](#14-dividers)
15. [Images](#15-images)
16. [Footer](#16-footer)
17. [Dark Mode](#17-dark-mode)
18. [Responsive Patterns](#18-responsive)
19. [Color Schemes](#19-color-schemes)
20. [Reference & Sources](#20-sources)

---

## 1. Email Boilerplate

The complete wrapper structure that every HTML email needs. This combines patterns from Good Email Code and Email on Acid.

```html
<!DOCTYPE html>
<html lang="en" dir="ltr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=yes">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>Email Subject Line Here</title>

  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->

  <style>
    /* === CSS RESETS === */
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
    }

    html, body {
      margin: 0 auto !important;
      padding: 0 !important;
      height: 100% !important;
      width: 100% !important;
    }

    /* Outlook table spacing fix */
    table, td {
      mso-table-lspace: 0pt !important;
      mso-table-rspace: 0pt !important;
    }

    /* Prevent WebKit and Windows auto text sizing */
    body {
      -ms-text-size-adjust: 100%;
      -webkit-text-size-adjust: 100%;
    }

    /* Image rendering */
    img {
      -ms-interpolation-mode: bicubic;
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
    }

    /* Reset for semantic elements */
    h1, h2, h3, h4, h5, h6, p {
      margin: 0;
    }

    a {
      text-decoration: none;
    }

    /* Override Apple link coloring */
    a[x-apple-data-detectors] {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }

    /* === RESPONSIVE === */
    @media screen and (max-width: 600px) {
      .email-container {
        width: 100% !important;
        margin: auto !important;
      }
      .stack-column,
      .stack-column-center {
        display: block !important;
        width: 100% !important;
        max-width: 100% !important;
        direction: ltr !important;
      }
      .stack-column-center {
        text-align: center !important;
      }
      .center-on-narrow {
        text-align: center !important;
        display: block !important;
        margin-left: auto !important;
        margin-right: auto !important;
        float: none !important;
      }
      table.center-on-narrow {
        display: inline-block !important;
      }
      .mobile-padding {
        padding-left: 16px !important;
        padding-right: 16px !important;
      }
    }

    /* === DARK MODE === */
    @media (prefers-color-scheme: dark) {
      .email-bg {
        background: #111111 !important;
      }
      .darkmode-bg {
        background-color: #1a1a1a !important;
      }
      .darkmode-text {
        color: #F7F7F9 !important;
      }
      .darkmode-text-secondary {
        color: #CCCCCC !important;
      }
    }
  </style>
</head>

<body style="margin: 0; padding: 0; word-spacing: normal; background-color: #f4f4f4;">

  <!-- HIDDEN PREHEADER TEXT -->
  <div style="display: none; font-size: 1px; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden; mso-hide: all;">
    Preheader text here (shows in inbox preview, not in email body).
    &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <!-- ACCESSIBLE WRAPPER -->
  <div role="article" aria-roledescription="email" aria-label="Email Subject" lang="en" dir="ltr"
       style="font-size: medium; font-size: max(16px, 1rem);">

    <!-- OUTER BACKGROUND TABLE -->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
           style="background-color: #f4f4f4;" class="email-bg">
      <tr>
        <td align="center" valign="top" style="padding: 20px 0;">

          <!-- EMAIL CONTAINER (600px max) -->
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"
                 style="margin: auto;" class="email-container">

            <!-- === EMAIL CONTENT GOES HERE === -->

          </table>
          <!-- /email-container -->

        </td>
      </tr>
    </table>
    <!-- /outer background -->

  </div>
  <!-- /accessible wrapper -->

</body>
</html>
```

### Key Notes on the Boilerplate

| Element | Purpose |
|---------|---------|
| `xmlns:v` and `xmlns:o` | Required for VML support in Outlook |
| `format-detection` meta | Prevents iOS from auto-linking phone numbers, dates, addresses |
| `x-apple-disable-message-reformatting` | Prevents Apple Mail from resizing content |
| `color-scheme` meta | Declares dark mode support to email clients |
| `PixelsPerInch` conditional | Fixes DPI scaling issues in Outlook |
| Hidden preheader `div` | Shows in inbox preview but hidden in email body |
| `role="article"` wrapper | Accessibility -- screen readers identify content as an email article |
| Outer `table` with 100% width | Acts as `<body>` replacement (some clients strip `<body>`) |
| Inner `table` at 600px | Standard email width; responsive class shrinks it on mobile |

---

## 2. CSS Resets

These resets should go in the `<style>` block in the `<head>`. They address known rendering quirks.

```css
/* === CORE RESETS === */

/* Remove all spacing around tables in Outlook */
table, td {
  mso-table-lspace: 0pt !important;
  mso-table-rspace: 0pt !important;
}

/* Full-height body */
html, body {
  margin: 0 auto !important;
  padding: 0 !important;
  height: 100% !important;
  width: 100% !important;
}

/* Prevent auto text resizing */
body {
  -ms-text-size-adjust: 100%;
  -webkit-text-size-adjust: 100%;
}

/* Fix IE image rendering when resized */
img {
  -ms-interpolation-mode: bicubic;
}

/* Reset link styling for Apple devices */
a[x-apple-data-detectors] {
  color: inherit !important;
  text-decoration: none !important;
  font-size: inherit !important;
  font-family: inherit !important;
  font-weight: inherit !important;
  line-height: inherit !important;
}

/* Fix for Gmail centering issue */
u + #body a {
  color: inherit;
  text-decoration: none;
  font-size: inherit;
  font-family: inherit;
  font-weight: inherit;
  line-height: inherit;
}

/* Outlook.com link color fix */
#MessageViewBody a {
  color: inherit;
  text-decoration: none;
  font-size: inherit;
  font-family: inherit;
  font-weight: inherit;
  line-height: inherit;
}

/* Outlook line-height fix */
* {
  mso-line-height-rule: exactly;
}
```

---

## 3. Container

A centered container that constrains content width. Uses conditional comments for Outlook (which does not support `max-width`).

### Standard Container (Good Email Code pattern)

```html
<!--[if true]>
<table role="presentation" style="width:37.5em" align="center"><tr><td>
<![endif]-->
<div style="max-width:37.5em; margin:0 auto;">
  <!-- email content goes here -->
</div>
<!--[if true]>
</td></tr></table>
<![endif]-->
```

### Container with Background Color

For full-width background with centered content:

```html
<div style="background:#f4f4f4;">
  <!--[if true]>
  <table role="presentation" width="100%" align="center" style="background:#f4f4f4;">
    <tr><td></td><td style="width:37.5em; background:#ffffff;">
  <![endif]-->
  <div style="max-width:37.5em; margin:0 auto; background:#ffffff;">
    <!-- email content goes here -->
  </div>
  <!--[if true]>
    </td><td></td></tr>
  </table>
  <![endif]-->
</div>
```

### Table-Based Container (Cerberus pattern)

More traditional, works everywhere:

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"
       style="background-color: #f4f4f4;">
  <tr>
    <td align="center" valign="top">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"
             style="margin: auto;" class="email-container">
        <!-- content rows go here -->
      </table>
    </td>
  </tr>
</table>
```

---

## 4. Single-Column Layout

The simplest and most reliable layout. Works everywhere without any tricks.

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"
       style="margin: auto;" class="email-container">

  <!-- Section 1 -->
  <tr>
    <td style="background-color: #ffffff; padding: 20px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px; color: #333333;">
      <h1 style="margin: 0 0 16px 0; font-size: 24px; line-height: 30px; color: #222222; font-weight: bold;">
        Section Heading
      </h1>
      <p style="margin: 0 0 16px 0;">
        Body text goes here. Single-column layouts are the safest and most
        universally supported pattern in HTML email.
      </p>
    </td>
  </tr>

  <!-- Section 2 (different background) -->
  <tr>
    <td style="background-color: #f7f7f7; padding: 20px; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px; color: #333333;">
      <p style="margin: 0;">
        Another section with a different background color for visual separation.
      </p>
    </td>
  </tr>

</table>
```

---

## 5. Two-Column Layout (Hybrid/Ghost Tables)

This is the **most important multi-column pattern**. It uses `display:inline-block` and `max-width` for modern clients, with "ghost tables" (conditional comments) for Outlook.

### Pattern A: Equal Columns (Cerberus Hybrid)

Columns sit side-by-side on desktop, stack on mobile -- even in Gmail (no media queries needed).

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600"
       style="margin: auto;" class="email-container">
  <tr>
    <td style="padding: 10px; background-color: #ffffff;">

      <!-- Ghost table for Outlook -->
      <!--[if mso]>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td valign="top" width="290">
      <![endif]-->

      <!-- Column 1 -->
      <div style="display: inline-block; margin: 0; width: 100%; min-width: 200px; max-width: 290px; vertical-align: top;"
           class="stack-column-center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td style="padding: 10px;">
              <img src="https://via.placeholder.com/270x200" width="270" alt="Alt text"
                   style="width: 100%; max-width: 270px; height: auto; display: block;"
                   class="center-on-narrow">
              <p style="margin: 0; padding: 10px 0; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
                Column 1 content goes here.
              </p>
            </td>
          </tr>
        </table>
      </div>

      <!--[if mso]>
          </td>
          <td valign="top" width="290">
      <![endif]-->

      <!-- Column 2 -->
      <div style="display: inline-block; margin: 0; width: 100%; min-width: 200px; max-width: 290px; vertical-align: top;"
           class="stack-column-center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td style="padding: 10px;">
              <img src="https://via.placeholder.com/270x200" width="270" alt="Alt text"
                   style="width: 100%; max-width: 270px; height: auto; display: block;"
                   class="center-on-narrow">
              <p style="margin: 0; padding: 10px 0; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
                Column 2 content goes here.
              </p>
            </td>
          </tr>
        </table>
      </div>

      <!--[if mso]>
          </td>
        </tr>
      </table>
      <![endif]-->

    </td>
  </tr>
</table>
```

### Pattern B: Sidebar Layout (1/3 + 2/3)

Useful for thumbnail + text or sidebar content.

```html
<tr>
  <td style="padding: 10px; background-color: #ffffff;">

    <!--[if mso]>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td valign="top" width="200">
    <![endif]-->

    <!-- Sidebar (narrow) -->
    <div style="display: inline-block; width: 100%; min-width: 120px; max-width: 200px; vertical-align: top;"
         class="stack-column-center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="padding: 10px;">
            <img src="https://via.placeholder.com/180x180" width="180" alt=""
                 style="width: 100%; max-width: 180px; height: auto; display: block;">
          </td>
        </tr>
      </table>
    </div>

    <!--[if mso]>
        </td>
        <td valign="top" width="380">
    <![endif]-->

    <!-- Main content (wide) -->
    <div style="display: inline-block; width: 100%; min-width: 240px; max-width: 380px; vertical-align: top;"
         class="stack-column-center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="padding: 10px; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
            <h2 style="margin: 0 0 10px 0; font-size: 20px; line-height: 26px; color: #222222; font-weight: bold;">
              Sidebar Heading
            </h2>
            <p style="margin: 0;">
              Main content area. This column takes up the remaining space next to the sidebar.
            </p>
          </td>
        </tr>
      </table>
    </div>

    <!--[if mso]>
        </td>
      </tr>
    </table>
    <![endif]-->

  </td>
</tr>
```

### Pattern C: Good Email Code Columns (display:table-cell)

An alternative approach using `display:table-cell` with Outlook conditional tables:

```html
<!--[if true]>
<table role="presentation" width="100%" style="all:unset;opacity:0;">
  <tr>
<![endif]-->
<!--[if false]></td></tr></table><![endif]-->

<div style="display:table; width:100%;">

  <!--[if true]><td width="50%"><![endif]-->
  <!--[if !true]><!--><div style="display:table-cell; width:50%; padding: 10px;"><!--<![endif]-->
    Column 1 content
  <!--[if !true]><!--></div><!--<![endif]-->
  <!--[if true]></td><![endif]-->

  <!--[if true]><td width="50%"><![endif]-->
  <!--[if !true]><!--><div style="display:table-cell; width:50%; padding: 10px;"><!--<![endif]-->
    Column 2 content
  <!--[if !true]><!--></div><!--<![endif]-->
  <!--[if true]></td><![endif]-->

</div>

<!--[if true]>
  </tr>
</table>
<![endif]-->
```

---

## 6. Three-Column Layout

Same ghost table technique extended to three columns.

```html
<tr>
  <td style="padding: 10px; background-color: #ffffff;">

    <!--[if mso]>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td valign="top" width="190">
    <![endif]-->

    <div style="display: inline-block; margin: 0; width: 100%; min-width: 120px; max-width: 190px; vertical-align: top;"
         class="stack-column-center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="padding: 10px; text-align: center; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
            <img src="https://via.placeholder.com/170" width="170" alt=""
                 style="width: 100%; max-width: 170px; height: auto;">
            <p style="margin: 10px 0 0 0;">Column 1</p>
          </td>
        </tr>
      </table>
    </div>

    <!--[if mso]></td><td valign="top" width="190"><![endif]-->

    <div style="display: inline-block; margin: 0; width: 100%; min-width: 120px; max-width: 190px; vertical-align: top;"
         class="stack-column-center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="padding: 10px; text-align: center; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
            <img src="https://via.placeholder.com/170" width="170" alt=""
                 style="width: 100%; max-width: 170px; height: auto;">
            <p style="margin: 10px 0 0 0;">Column 2</p>
          </td>
        </tr>
      </table>
    </div>

    <!--[if mso]></td><td valign="top" width="190"><![endif]-->

    <div style="display: inline-block; margin: 0; width: 100%; min-width: 120px; max-width: 190px; vertical-align: top;"
         class="stack-column-center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        <tr>
          <td style="padding: 10px; text-align: center; font-family: Arial, sans-serif; font-size: 15px; line-height: 22px; color: #333333;">
            <img src="https://via.placeholder.com/170" width="170" alt=""
                 style="width: 100%; max-width: 170px; height: auto;">
            <p style="margin: 10px 0 0 0;">Column 3</p>
          </td>
        </tr>
      </table>
    </div>

    <!--[if mso]>
        </td>
      </tr>
    </table>
    <![endif]-->

  </td>
</tr>
```

---

## 7. Header

### Simple Header with Logo and Title

```html
<tr>
  <td style="background-color: #ffffff; padding: 20px; text-align: center;">
    <img src="https://example.com/logo.png" width="200" height="50" alt="Company Name"
         style="display: block; margin: 0 auto; width: 200px; max-width: 200px; height: auto;">
  </td>
</tr>
```

### Header with Background Color and Text

```html
<tr>
  <td style="background-color: #222222; padding: 30px 20px; text-align: center;">
    <img src="https://example.com/logo-white.png" width="180" height="44" alt="Company Name"
         style="display: block; margin: 0 auto 10px auto; width: 180px; max-width: 180px; height: auto;">
    <p style="margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 20px; color: #cccccc;">
      Your tagline or subtitle here
    </p>
  </td>
</tr>
```

### Header with Navigation Links

```html
<tr>
  <td style="background-color: #ffffff; padding: 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td style="width: 200px; vertical-align: middle;">
          <img src="https://example.com/logo.png" width="150" alt="Company"
               style="display: block; height: auto;">
        </td>
        <td style="text-align: right; vertical-align: middle; font-family: Arial, sans-serif; font-size: 14px;">
          <a href="#" style="color: #333333; text-decoration: none; padding: 0 8px;">About</a>
          <a href="#" style="color: #333333; text-decoration: none; padding: 0 8px;">Blog</a>
          <a href="#" style="color: #333333; text-decoration: none; padding: 0 8px;">Contact</a>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

---

## 8. Section Block

### Standard Section (Heading + Body)

```html
<tr>
  <td style="background-color: #ffffff; padding: 30px 20px; font-family: Arial, Helvetica, sans-serif;">
    <h2 style="margin: 0 0 12px 0; font-size: 22px; line-height: 28px; color: #222222; font-weight: bold;">
      Section Heading
    </h2>
    <p style="margin: 0 0 16px 0; font-size: 16px; line-height: 24px; color: #555555;">
      Section body text. Use padding on the td for spacing rather than margins.
      Padding is universally supported in email clients.
    </p>
    <p style="margin: 0; font-size: 16px; line-height: 24px; color: #555555;">
      Second paragraph. Keep font-family, font-size, line-height, and color
      on every text element for consistency.
    </p>
  </td>
</tr>
```

### Hero Section (Full-Width Image + Text)

```html
<!-- Hero Image -->
<tr>
  <td style="background-color: #ffffff;">
    <img src="https://example.com/hero.jpg" width="600" alt="Hero image description"
         style="width: 100%; max-width: 600px; height: auto; display: block;"
         class="fluid">
  </td>
</tr>
<!-- Hero Text -->
<tr>
  <td style="background-color: #ffffff; padding: 30px 40px; text-align: center; font-family: Arial, Helvetica, sans-serif;">
    <h1 style="margin: 0 0 16px 0; font-size: 28px; line-height: 34px; color: #222222; font-weight: bold;">
      Welcome to Our Service
    </h1>
    <p style="margin: 0 0 24px 0; font-size: 18px; line-height: 26px; color: #555555;">
      A brief description that sets context. Keep it to 2-3 lines max.
    </p>
  </td>
</tr>
```

---

## 9. Typography

### Recommended Font Stacks

```
/* Sans-serif (most common in email) */
font-family: Arial, Helvetica, sans-serif;

/* Alternative sans-serif */
font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;

/* Serif (rarely used, but works) */
font-family: Georgia, 'Times New Roman', Times, serif;

/* Monospace (code blocks) */
font-family: Consolas, Menlo, Monaco, 'Lucida Console', 'Liberation Mono',
             'DejaVu Sans Mono', 'Courier New', monospace, sans-serif;
```

### Heading Styles (inline)

```html
<h1 style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 28px; line-height: 34px; font-weight: bold; color: #222222;">
  Heading 1
</h1>

<h2 style="margin: 0 0 12px 0; font-family: Arial, Helvetica, sans-serif; font-size: 22px; line-height: 28px; font-weight: bold; color: #222222;">
  Heading 2
</h2>

<h3 style="margin: 0 0 10px 0; font-family: Arial, Helvetica, sans-serif; font-size: 18px; line-height: 24px; font-weight: bold; color: #333333;">
  Heading 3
</h3>
```

### Paragraph Style (inline)

```html
<p style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 16px; line-height: 24px; color: #555555;">
  Body text paragraph. Always set font-family, font-size, line-height, and
  color inline on every text element.
</p>
```

### Lead / Intro Paragraph

```html
<p style="margin: 0 0 16px 0; font-family: Arial, Helvetica, sans-serif; font-size: 18px; line-height: 26px; color: #444444;">
  Larger intro text for the opening paragraph of an email section.
</p>
```

### Small Text / Caption

```html
<p style="margin: 0; font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 18px; color: #999999;">
  Small caption or disclaimer text.
</p>
```

### Link Style (inline)

```html
<a href="https://example.com"
   style="color: #0077CC; text-decoration: underline; font-weight: normal;">
  Link text
</a>
```

### Outlook Font Fallback Fix

Outlook may revert to Times New Roman. Use this conditional in `<head>`:

```html
<!--[if mso]>
<style>
  h1, h2, h3, h4, h5, h6, p, a, li, td {
    font-family: Arial, Helvetica, sans-serif !important;
  }
</style>
<![endif]-->
```

### Web Font Integration (progressive enhancement)

```html
<!--[if !mso]><!-->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<!--<![endif]-->

<!-- Then in your inline styles, reference with fallback: -->
<!-- font-family: 'Inter', Arial, Helvetica, sans-serif; -->
```

Clients that support web fonts (Apple Mail, iOS Mail, Thunderbird, some Android) will use Inter; everyone else falls back to Arial.

---

## 10. Lists

### Bullet List (using HTML table for reliability)

The safest approach uses a table rather than `<ul>` tags, since some email clients strip or mangle list styling.

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
  <!-- Item 1 -->
  <tr>
    <td valign="top" width="20"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      &bull;
    </td>
    <td valign="top"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      First list item with text that can wrap to multiple lines and still align properly.
    </td>
  </tr>
  <!-- Item 2 -->
  <tr>
    <td valign="top" width="20"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      &bull;
    </td>
    <td valign="top"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      Second list item.
    </td>
  </tr>
  <!-- Item 3 -->
  <tr>
    <td valign="top" width="20"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      &bull;
    </td>
    <td valign="top"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      Third list item.
    </td>
  </tr>
</table>
```

### Native HTML List (simpler but less consistent)

Works in most clients. Add inline styles to control rendering:

```html
<ul style="margin: 0 0 16px 0; padding: 0 0 0 24px; font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555;">
  <li style="margin: 0 0 8px 0; padding: 0;">First item</li>
  <li style="margin: 0 0 8px 0; padding: 0;">Second item</li>
  <li style="margin: 0 0 8px 0; padding: 0;">Third item</li>
</ul>
```

### Numbered List (table-based)

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
  <tr>
    <td valign="top" width="30"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #222222; font-weight: bold; padding: 0 0 8px 0;">
      1.
    </td>
    <td valign="top"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      First numbered item
    </td>
  </tr>
  <tr>
    <td valign="top" width="30"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #222222; font-weight: bold; padding: 0 0 8px 0;">
      2.
    </td>
    <td valign="top"
        style="font-family: Arial, sans-serif; font-size: 16px; line-height: 24px; color: #555555; padding: 0 0 8px 0;">
      Second numbered item
    </td>
  </tr>
</table>
```

### Feature List with Icons (icon + title + description)

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
  <tr>
    <td valign="top" width="50" style="padding: 0 10px 20px 0;">
      <img src="https://example.com/icon-check.png" width="32" height="32" alt=""
           style="display: block;">
    </td>
    <td valign="top" style="padding: 0 0 20px 0; font-family: Arial, sans-serif;">
      <p style="margin: 0 0 4px 0; font-size: 16px; line-height: 22px; color: #222222; font-weight: bold;">
        Feature Title
      </p>
      <p style="margin: 0; font-size: 14px; line-height: 20px; color: #666666;">
        Brief description of this feature or benefit.
      </p>
    </td>
  </tr>
  <tr>
    <td valign="top" width="50" style="padding: 0 10px 20px 0;">
      <img src="https://example.com/icon-star.png" width="32" height="32" alt=""
           style="display: block;">
    </td>
    <td valign="top" style="padding: 0 0 20px 0; font-family: Arial, sans-serif;">
      <p style="margin: 0 0 4px 0; font-size: 16px; line-height: 22px; color: #222222; font-weight: bold;">
        Another Feature
      </p>
      <p style="margin: 0; font-size: 14px; line-height: 20px; color: #666666;">
        Description of this second feature.
      </p>
    </td>
  </tr>
</table>
```

---

## 11. Buttons

### Pattern A: Padding-Based Button (simplest, most reliable)

Uses a table cell with padding. The entire cell is clickable in most clients.

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"
       style="margin: auto;">
  <tr>
    <td style="border-radius: 6px; background: #0077CC;">
      <a href="https://example.com"
         style="background: #0077CC; border: 1px solid #0066AA; font-family: Arial, sans-serif;
                font-size: 16px; line-height: 18px; text-decoration: none; padding: 14px 28px;
                color: #ffffff; display: block; border-radius: 6px; font-weight: bold;">
        Call to Action
      </a>
    </td>
  </tr>
</table>
```

### Pattern B: Good Email Code Button (with MSO padding fix)

Compact and handles Outlook padding correctly:

```html
<a href="https://example.com"
   style="background-color: #0077CC; text-decoration: none; padding: .75em 1.5em;
          color: #ffffff; display: inline-block; border-radius: 6px;
          font-family: Arial, sans-serif; font-size: 16px; font-weight: bold;
          mso-padding-alt: 0; text-underline-color: #0077CC;">
  <!--[if mso]><i style="mso-font-width:200%;mso-text-raise:100%" hidden>&emsp;</i><span style="mso-text-raise:50%;"><![endif]-->
  Call to Action
  <!--[if mso]></span><i style="mso-font-width:200%;" hidden>&emsp;&#8203;</i><![endif]-->
</a>
```

### Pattern C: VML Bulletproof Button (full Outlook support via VML)

Uses VML for Outlook desktop clients with an HTML/CSS fallback for everything else. This is the most robust approach when you need pixel-perfect buttons in Outlook.

```html
<!-- Bulletproof Button: VML for Outlook + HTML for everyone else -->
<div style="text-align: center;">

  <!--[if mso]>
  <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"
               xmlns:w="urn:schemas-microsoft-com:office:word"
               href="https://example.com"
               style="height:48px; v-text-anchor:middle; width:220px;"
               arcsize="13%"
               strokecolor="#0066AA"
               fillcolor="#0077CC">
    <w:anchorlock/>
    <center style="color:#ffffff; font-family:Arial,sans-serif; font-size:16px; font-weight:bold;">
      Call to Action
    </center>
  </v:roundrect>
  <![endif]-->

  <!--[if !mso]><!-->
  <a href="https://example.com" target="_blank" role="button"
     style="background-color: #0077CC; border: 1px solid #0066AA; border-radius: 6px;
            color: #ffffff; display: inline-block; font-family: Arial, sans-serif;
            font-size: 16px; font-weight: bold; line-height: 48px;
            text-align: center; text-decoration: none; width: 220px;
            -webkit-text-size-adjust: none; mso-hide: all;">
    Call to Action
  </a>
  <!--<![endif]-->

</div>
```

### Pattern D: Ghost / Outline Button

```html
<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
  <tr>
    <td style="border-radius: 6px; border: 2px solid #0077CC; background: transparent;">
      <a href="https://example.com"
         style="border: 0; font-family: Arial, sans-serif; font-size: 16px; line-height: 18px;
                text-decoration: none; padding: 12px 28px; color: #0077CC;
                display: block; border-radius: 6px; font-weight: bold;">
        Learn More
      </a>
    </td>
  </tr>
</table>
```

### Button Color Variants

| Use Case | Background | Border | Text |
|----------|-----------|--------|------|
| Primary  | `#0077CC` | `#0066AA` | `#ffffff` |
| Secondary | `#6c757d` | `#5a6268` | `#ffffff` |
| Success  | `#28a745` | `#218838` | `#ffffff` |
| Warning  | `#ffc107` | `#e0a800` | `#333333` |
| Danger   | `#dc3545` | `#c82333` | `#ffffff` |
| Dark     | `#222222` | `#000000` | `#ffffff` |

### Button Tool

Campaign Monitor provides a visual tool for generating VML bulletproof buttons at [buttons.cm](https://buttons.cm/).

---

## 12. Callout Boxes / Info Cards

### Info Box (left border accent)

```html
<tr>
  <td style="padding: 20px; background-color: #ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-left: 4px solid #2196F3; background-color: #e7f3fe; border-radius: 4px;">
      <tr>
        <td style="padding: 16px 20px; font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 22px; color: #1a5276;">
          <strong style="font-size: 16px; color: #1a5276;">Note</strong><br><br>
          This is an informational callout. Use it to highlight key details,
          tips, or important notes.
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Callout Variants

| Type | Background | Border | Text Color |
|------|-----------|--------|------------|
| Info | `#e7f3fe` | `#2196F3` | `#1a5276` |
| Success | `#e8f5e9` | `#4CAF50` | `#2e7d32` |
| Warning | `#fff8e1` | `#FFC107` | `#856404` |
| Error | `#fdecea` | `#f44336` | `#a94442` |

### Highlight Card (full background)

```html
<tr>
  <td style="padding: 0 20px 20px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="background-color: #f0f7ff; border: 1px solid #d0e3f7; border-radius: 8px;">
      <tr>
        <td style="padding: 24px; font-family: Arial, Helvetica, sans-serif;">
          <h3 style="margin: 0 0 10px 0; font-size: 18px; line-height: 24px; color: #1a3e5c; font-weight: bold;">
            Highlight Title
          </h3>
          <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 22px; color: #3a5f82;">
            Important content that deserves visual prominence. Use cards to
            break up long emails and draw attention to key information.
          </p>
          <a href="https://example.com"
             style="color: #0077CC; font-size: 15px; font-weight: bold; text-decoration: underline;">
            Learn more &rarr;
          </a>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Quote / Testimonial Block

```html
<tr>
  <td style="padding: 20px; background-color: #ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border-left: 4px solid #cccccc; background-color: #fafafa;">
      <tr>
        <td style="padding: 20px; font-family: Georgia, 'Times New Roman', serif; font-size: 17px; line-height: 26px; color: #555555; font-style: italic;">
          &ldquo;This product changed how our team works. We shipped 3x faster
          in the first month.&rdquo;
          <p style="margin: 12px 0 0 0; font-family: Arial, sans-serif; font-size: 14px; font-style: normal; color: #888888;">
            &mdash; Jane Smith, CTO at Acme Corp
          </p>
        </td>
      </tr>
    </table>
  </td>
</tr>
```

---

## 13. Data Tables

### Simple Data Table (schedule, pricing, specs)

```html
<tr>
  <td style="padding: 20px; background-color: #ffffff;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="border: 1px solid #e0e0e0; border-radius: 4px;">
      <!-- Header Row -->
      <tr>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #222222; background-color: #f7f7f7; border-bottom: 2px solid #e0e0e0; text-align: left;">
          Plan
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #222222; background-color: #f7f7f7; border-bottom: 2px solid #e0e0e0; text-align: center;">
          Monthly
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 14px; font-weight: bold; color: #222222; background-color: #f7f7f7; border-bottom: 2px solid #e0e0e0; text-align: center;">
          Annual
        </td>
      </tr>
      <!-- Row 1 -->
      <tr>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee;">
          Basic
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; text-align: center;">
          $9/mo
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; text-align: center;">
          $90/yr
        </td>
      </tr>
      <!-- Row 2 -->
      <tr>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; background-color: #fafafa;">
          Pro
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; background-color: #fafafa; text-align: center;">
          $29/mo
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333; border-bottom: 1px solid #eeeeee; background-color: #fafafa; text-align: center;">
          $290/yr
        </td>
      </tr>
      <!-- Row 3 (highlighted) -->
      <tr>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #1a5276; font-weight: bold;">
          Enterprise
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #1a5276; font-weight: bold; text-align: center;">
          $99/mo
        </td>
        <td style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #1a5276; font-weight: bold; text-align: center;">
          $990/yr
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Responsive Table CSS

Add to the `<style>` block in `<head>` for mobile stacking:

```css
@media screen and (max-width: 600px) {
  .responsive-table {
    border: 0 !important;
  }
  .responsive-table thead {
    display: none !important;
  }
  .responsive-table tr {
    display: block !important;
    width: 90% !important;
    margin: 10px auto !important;
    border: 1px solid #e0e0e0 !important;
    border-radius: 4px !important;
  }
  .responsive-table td {
    display: block !important;
    text-align: left !important;
    border-bottom: 1px solid #eeeeee !important;
    padding: 10px 16px !important;
  }
  .responsive-table td:before {
    content: attr(data-label);
    font-weight: bold;
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    color: #888888;
    text-transform: uppercase;
  }
}
```

Then mark cells with `data-label` and `class="responsive-table"`:

```html
<td data-label="Plan" class="...">Basic</td>
<td data-label="Monthly" class="...">$9/mo</td>
```

### Schedule / Agenda Table

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td width="80" valign="top"
        style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 14px; color: #0077CC; font-weight: bold; border-right: 2px solid #0077CC;">
      9:00 AM
    </td>
    <td valign="top"
        style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333;">
      <strong>Opening Keynote</strong><br>
      <span style="font-size: 13px; color: #888888;">Main Stage &middot; 45 min</span>
    </td>
  </tr>
  <tr>
    <td width="80" valign="top"
        style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 14px; color: #0077CC; font-weight: bold; border-right: 2px solid #0077CC;">
      10:00 AM
    </td>
    <td valign="top"
        style="padding: 12px 16px; font-family: Arial, sans-serif; font-size: 15px; color: #333333;">
      <strong>Workshop: Building Email Templates</strong><br>
      <span style="font-size: 13px; color: #888888;">Room B &middot; 90 min</span>
    </td>
  </tr>
</table>
```

---

## 14. Dividers / Separators

### HR-Style Divider (table-based, most reliable)

```html
<tr>
  <td style="padding: 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td style="border-top: 1px solid #e0e0e0; font-size: 1px; line-height: 1px;">
          &nbsp;
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Thicker Divider with Color

```html
<tr>
  <td style="padding: 20px 0;">
    <div style="height: 3px; background-color: #0077CC; font-size: 1px; line-height: 1px; mso-line-height-rule: exactly;">
      &nbsp;
    </div>
  </td>
</tr>
```

### Centered Partial-Width Divider

```html
<tr>
  <td align="center" style="padding: 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="60%"
           style="margin: 0 auto;">
      <tr>
        <td style="border-top: 1px solid #dddddd; font-size: 1px; line-height: 1px;">
          &nbsp;
        </td>
      </tr>
    </table>
  </td>
</tr>
```

### Spacer (vertical whitespace only)

```html
<tr>
  <td style="height: 20px; font-size: 1px; line-height: 1px; mso-line-height-rule: exactly;">
    &nbsp;
  </td>
</tr>
```

### Dotted / Dashed Divider

```html
<tr>
  <td style="padding: 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td style="border-top: 2px dashed #cccccc; font-size: 1px; line-height: 1px;">
          &nbsp;
        </td>
      </tr>
    </table>
  </td>
</tr>
```

---

## 15. Images

### Block Image (full width of container)

```html
<tr>
  <td style="background-color: #ffffff;">
    <img src="https://example.com/image.jpg" width="600" height="" alt="Description of image"
         style="width: 100%; max-width: 600px; height: auto; display: block; margin: 0 auto;"
         class="fluid">
  </td>
</tr>
```

### Inline Image with Padding

```html
<tr>
  <td style="padding: 20px; background-color: #ffffff; text-align: center;">
    <img src="https://example.com/image.jpg" width="560" alt="Description"
         style="width: 100%; max-width: 560px; height: auto; display: block; margin: 0 auto;
                border-radius: 8px;">
  </td>
</tr>
```

### Image Best Practices

- Always set `width` attribute in HTML and `max-width` in CSS
- Always include descriptive `alt` text
- Use `display: block` to remove bottom gap
- Set `border: 0` to remove link borders
- Use `height: auto` for responsive scaling
- Keep total email size under 100KB to avoid Gmail clipping

---

## 16. Footer

### Standard Footer

```html
<tr>
  <td style="padding: 30px 20px; background-color: #f7f7f7; text-align: center; font-family: Arial, Helvetica, sans-serif;">
    <!-- Company Info -->
    <p style="margin: 0 0 8px 0; font-size: 14px; line-height: 20px; color: #666666; font-weight: bold;">
      Company Name
    </p>
    <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 18px; color: #999999;">
      123 Main Street, Suite 100<br>
      City, State 12345
    </p>

    <!-- Links -->
    <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 18px; color: #999999;">
      <a href="#" style="color: #0077CC; text-decoration: underline;">Unsubscribe</a>
      &nbsp;&bull;&nbsp;
      <a href="#" style="color: #0077CC; text-decoration: underline;">View in browser</a>
      &nbsp;&bull;&nbsp;
      <a href="#" style="color: #0077CC; text-decoration: underline;">Privacy Policy</a>
    </p>

    <!-- Legal -->
    <p style="margin: 0; font-size: 12px; line-height: 16px; color: #bbbbbb;">
      &copy; 2026 Company Name. All rights reserved.<br>
      You received this email because you signed up at example.com.
    </p>
  </td>
</tr>
```

### Footer with Social Icons

```html
<tr>
  <td style="padding: 30px 20px; background-color: #222222; text-align: center; font-family: Arial, Helvetica, sans-serif;">

    <!-- Social Icons -->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center"
           style="margin: 0 auto 16px auto;">
      <tr>
        <td style="padding: 0 8px;">
          <a href="https://twitter.com/company">
            <img src="https://example.com/icon-twitter.png" width="32" height="32" alt="Twitter"
                 style="display: block;">
          </a>
        </td>
        <td style="padding: 0 8px;">
          <a href="https://linkedin.com/company">
            <img src="https://example.com/icon-linkedin.png" width="32" height="32" alt="LinkedIn"
                 style="display: block;">
          </a>
        </td>
        <td style="padding: 0 8px;">
          <a href="https://github.com/company">
            <img src="https://example.com/icon-github.png" width="32" height="32" alt="GitHub"
                 style="display: block;">
          </a>
        </td>
      </tr>
    </table>

    <!-- Company + Links -->
    <p style="margin: 0 0 8px 0; font-size: 13px; line-height: 18px; color: #aaaaaa;">
      <a href="#" style="color: #ffffff; text-decoration: underline;">Unsubscribe</a>
      &nbsp;&bull;&nbsp;
      <a href="#" style="color: #ffffff; text-decoration: underline;">Preferences</a>
    </p>
    <p style="margin: 0; font-size: 12px; line-height: 16px; color: #777777;">
      &copy; 2026 Company Name &middot; 123 Main St, City, ST 12345
    </p>
  </td>
</tr>
```

---

## 17. Dark Mode

### Strategy Overview

There are three layers to dark mode in email:

1. **`<meta>` declaration** -- Tells clients your email supports dark mode
2. **CSS `@media (prefers-color-scheme: dark)`** -- Override colors for supporting clients
3. **Inline fallbacks** -- Ensure nothing breaks in clients that aggressively invert

### Meta Tags (in `<head>`)

```html
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
```

### CSS Declarations (in `<style>`)

```css
:root {
  color-scheme: light dark;
  supported-color-schemes: light dark;
}

@media (prefers-color-scheme: dark) {
  /* Backgrounds */
  .email-bg         { background-color: #121212 !important; }
  .darkmode-bg      { background-color: #1e1e1e !important; }
  .darkmode-bg-card { background-color: #2a2a2a !important; }

  /* Text */
  h1, h2, h3,
  .darkmode-text         { color: #f0f0f0 !important; }
  .darkmode-text-body    { color: #cccccc !important; }
  .darkmode-text-muted   { color: #999999 !important; }

  /* Links */
  .darkmode-link { color: #5eb8ff !important; }

  /* Borders */
  .darkmode-border { border-color: #444444 !important; }

  /* Buttons */
  .darkmode-btn-bg { background-color: #1a73e8 !important; }
}

/* Outlook Android dark mode */
[data-ogsc] .darkmode-bg { background-color: #1e1e1e !important; }
[data-ogsc] .darkmode-text { color: #f0f0f0 !important; }
```

### Dark Mode Logo Swap

Provide two logo versions and swap via CSS:

```html
<!-- Light mode logo (default) -->
<img src="https://example.com/logo-dark.png" width="200" alt="Company"
     style="display: block;" class="light-logo">

<!-- Dark mode logo (hidden by default) -->
<!--[if !mso]><!-->
<div class="dark-logo" style="display: none; mso-hide: all;">
  <img src="https://example.com/logo-light.png" width="200" alt="Company"
       style="display: block;">
</div>
<!--<![endif]-->
```

```css
@media (prefers-color-scheme: dark) {
  .light-logo { display: none !important; }
  .dark-logo  { display: block !important; }
}
```

### Dark Mode Design Tips

| Guideline | Reason |
|-----------|--------|
| Use transparent PNG logos | They adapt to any background |
| Avoid pure black (#000000) backgrounds | Use #121212 or #1e1e1e instead |
| Avoid pure white (#ffffff) text | Use #f0f0f0 or #e0e0e0 |
| Test with images on colored backgrounds | Some clients invert image backgrounds |
| Use `!important` on all dark mode overrides | Required to override inline styles |
| Add a subtle border around images with white backgrounds | Prevents "floating" look on dark backgrounds |

### Client Support Matrix

| Client | Dark Mode Type | CSS Override? |
|--------|---------------|---------------|
| Apple Mail (macOS/iOS) | Full control | Yes |
| Outlook.com / Office 365 | Partial inversion | Limited (`[data-ogsc]`) |
| Gmail (web) | No dark mode | N/A |
| Gmail (mobile) | Full color inversion | No control |
| Yahoo Mail | Partial inversion | No control |
| Outlook desktop (Windows) | Partial inversion | Very limited |

---

## 18. Responsive Patterns

### Approach 1: Media Queries (classic responsive)

Best control but not supported in Gmail mobile app.

```css
@media screen and (max-width: 600px) {
  /* Container fills screen */
  .email-container { width: 100% !important; margin: auto !important; }

  /* Columns stack */
  .stack-column,
  .stack-column-center {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
  }

  /* Center content when stacked */
  .stack-column-center { text-align: center !important; }

  /* Full-width images */
  img.fluid { width: 100% !important; max-width: 100% !important; height: auto !important; }

  /* Adjust padding for mobile */
  .mobile-padding { padding-left: 16px !important; padding-right: 16px !important; }

  /* Hide elements on mobile */
  .mobile-hide { display: none !important; }

  /* Show elements only on mobile */
  .desktop-hide { display: block !important; width: auto !important; overflow: visible !important; max-height: none !important; }
}
```

### Approach 2: Hybrid/Fluid (works in Gmail)

Uses `inline-block` + `max-width` + ghost tables. No media queries needed for basic stacking.

The key pattern (used in multi-column sections above):

```html
<!-- Ghost table for Outlook (does not support max-width) -->
<!--[if mso]>
<table role="presentation" width="100%"><tr><td width="300">
<![endif]-->

<!-- Fluid column for everyone else -->
<div style="display:inline-block; width:100%; min-width:200px; max-width:300px; vertical-align:top;">
  Content
</div>

<!--[if mso]>
</td><td width="300">
<![endif]-->

<div style="display:inline-block; width:100%; min-width:200px; max-width:300px; vertical-align:top;">
  Content
</div>

<!--[if mso]>
</td></tr></table>
<![endif]-->
```

**How it works:**
- `max-width: 300px` constrains the column width on desktop
- `width: 100%` makes each column fill available space on mobile
- `display: inline-block` puts columns side-by-side when there is room
- When the viewport is too narrow, columns naturally stack
- Ghost tables give Outlook fixed widths since it ignores `max-width`

### Approach 3: Combined (recommended)

Use hybrid as the baseline, then layer media queries for fine-tuning:

```css
/* Fine-tune the hybrid layout with media queries where supported */
@media screen and (max-width: 600px) {
  .stack-column-center {
    display: block !important;
    width: 100% !important;
    text-align: center !important;
  }
  /* Increase font size on mobile for readability */
  .mobile-body-text {
    font-size: 18px !important;
    line-height: 26px !important;
  }
}
```

---

## 19. Color Schemes

### Professional Blue (corporate / SaaS)

| Role | Color | Hex |
|------|-------|-----|
| Primary | Blue | `#0077CC` |
| Primary Dark | Navy | `#004F9F` |
| Background | White | `#ffffff` |
| Alt Background | Light Gray | `#f4f4f4` |
| Card Background | Off-White | `#f7f7f7` |
| Text Primary | Dark Gray | `#222222` |
| Text Body | Medium Gray | `#555555` |
| Text Muted | Light Gray | `#999999` |
| Link | Blue | `#0077CC` |
| Border | Light Gray | `#e0e0e0` |
| Success | Green | `#28a745` |
| Warning | Amber | `#ffc107` |
| Error | Red | `#dc3545` |

### Warm Neutral (editorial / newsletter)

| Role | Color | Hex |
|------|-------|-----|
| Primary | Warm Brown | `#8B572A` |
| Background | Warm White | `#fffaf5` |
| Card Background | Cream | `#faf5ee` |
| Text Primary | Near Black | `#2c2c2c` |
| Text Body | Dark Warm Gray | `#4a4a4a` |
| Text Muted | Warm Gray | `#8c8c8c` |
| Link | Brown | `#8B572A` |
| Accent | Gold | `#D4A843` |
| Border | Warm Gray | `#e8e0d7` |

### Dark Theme (developer / tech)

| Role | Color | Hex |
|------|-------|-----|
| Primary | Electric Blue | `#5eb8ff` |
| Background | Charcoal | `#1e1e1e` |
| Card Background | Dark Gray | `#2a2a2a` |
| Text Primary | Near White | `#f0f0f0` |
| Text Body | Light Gray | `#cccccc` |
| Text Muted | Medium Gray | `#888888` |
| Link | Light Blue | `#5eb8ff` |
| Accent | Teal | `#00bfa5` |
| Border | Gray | `#444444` |

### Minimal (transactional / receipts)

| Role | Color | Hex |
|------|-------|-----|
| Primary | Black | `#222222` |
| Background | White | `#ffffff` |
| Card Background | Ultra Light Gray | `#fafafa` |
| Text Primary | Black | `#222222` |
| Text Body | Dark Gray | `#444444` |
| Text Muted | Gray | `#999999` |
| Link | Black (underlined) | `#222222` |
| Accent | Single accent only | `#0077CC` |
| Border | Light Gray | `#eeeeee` |

### Contrast Requirements (WCAG 2.0 AA)

| Combination | Ratio | Pass? |
|-------------|-------|-------|
| `#222222` on `#ffffff` | 16.75:1 | Yes (AAA) |
| `#555555` on `#ffffff` | 7.46:1 | Yes (AAA) |
| `#999999` on `#ffffff` | 2.85:1 | No (use for decorative only) |
| `#0077CC` on `#ffffff` | 4.56:1 | Yes (AA) |
| `#ffffff` on `#0077CC` | 4.56:1 | Yes (AA) |
| `#ffffff` on `#222222` | 16.75:1 | Yes (AAA) |
| `#f0f0f0` on `#1e1e1e` | 13.73:1 | Yes (AAA) |
| `#cccccc` on `#1e1e1e` | 9.33:1 | Yes (AAA) |

**Minimum ratios:**
- Normal text (under 18px): 4.5:1 (AA) or 7:1 (AAA)
- Large text (18px+ bold or 24px+ regular): 3:1 (AA) or 4.5:1 (AAA)

**Tools for checking contrast:**
- [Color Safe](http://colorsafe.co/) -- generates accessible palettes from a base color
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Coolors Contrast Checker](https://coolors.co/contrast-checker)

---

## 20. Reference & Sources

### Core Pattern Libraries

- [Cerberus -- Responsive HTML Email Patterns](https://www.cerberusemail.com/templates) (Ted Goas / emailmonday)
  - [GitHub repo](https://github.com/emailmonday/Cerberus)
- [Good Email Code](https://www.goodemailcode.com/) (Mark Robbins)
  - [Base Template](https://www.goodemailcode.com/email-code/template.html)
  - [Container](https://www.goodemailcode.com/email-code/container)
  - [Columns](https://www.goodemailcode.com/email-code/columns.html)
  - [CTA Link/Button](https://www.goodemailcode.com/email-code/link-button.html)
  - [Text](https://www.goodemailcode.com/email-code/text.html)

### Frameworks

- [MJML](https://mjml.io/) -- Component-based email markup language
  - [Documentation](https://documentation.mjml.io)
  - [Components](https://mjml.io/components)
- [Maizzle](https://maizzle.com/) -- Tailwind CSS for email
  - [Components docs](https://maizzle.com/docs/components)
  - [Dividers](https://maizzle.com/docs/examples/dividers)
- [Email Framework](https://emailframe.work/) -- Responsive grid + components
- [Foundation for Emails (Inky)](https://get.foundation/emails/docs/) -- Zurb's email framework

### Guides & Tutorials

- [Litmus: Email Coding 101](https://litmus.com/community/learning/13-foundations-email-coding-101)
- [Litmus: Guide to Bulletproof Buttons](https://www.litmus.com/blog/a-guide-to-bulletproof-buttons-in-email-design)
- [Litmus: Understanding Hybrid and Responsive Email Design](https://www.litmus.com/blog/understanding-responsive-and-hybrid-email-design)
- [Litmus: Ultimate Guide to Dark Mode](https://www.litmus.com/blog/the-ultimate-guide-to-dark-mode-for-email-marketers)
- [Litmus: Web Safe Fonts Guide](https://www.litmus.com/blog/the-ultimate-guide-to-web-fonts)
- [Litmus: Background Colors in Email](https://www.litmus.com/blog/background-colors-html-email)
- [Campaign Monitor: Dark Mode Guide](https://www.campaignmonitor.com/resources/guides/dark-mode-in-email/)
- [Campaign Monitor: Bulletproof Button Generator (buttons.cm)](https://buttons.cm/)
- [Email on Acid: HTML Boilerplate](https://www.emailonacid.com/blog/article/email-development/html-boilerplate/)
- [Email on Acid: Fluid Hybrid Primer](https://www.emailonacid.com/blog/article/email-development/a-fluid-hybrid-design-primer/)
- [Email on Acid: Email Safe Fonts](https://www.emailonacid.com/blog/article/email-development/best-font-for-email-everything-you-need-to-know-about-email-safe-fonts/)
- [Mailtrap: Building HTML Email Templates](https://mailtrap.io/blog/building-html-email-template/)
- [Mailtrap: Responsive Email Design](https://mailtrap.io/blog/responsive-email-design/)
- [EDM Designer: Tabular Data in Emails](https://blog.edmdesigner.com/tabular-data-representation-in-modern-html-emails/)
- [Envato Tuts+: Future-Proof Responsive Email Without Media Queries](https://webdesign.tutsplus.com/creating-a-future-proof-responsive-email-without-media-queries--cms-23919t)
- [DEV.to: Bulletproof VML Buttons](https://dev.to/aulate/bulletproof-email-buttons-for-outlook-vml-accessible-html-4424)

### Color & Accessibility

- [Color Safe](http://colorsafe.co/) -- WCAG-compliant color combinations
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Coolors](https://coolors.co/) -- Palette generator with contrast checking
- [Venngage Accessible Color Palette Generator](https://venngage.com/tools/accessible-color-palette-generator)

### Email Design References

- [Mailchimp Email Design Reference: HTML](https://templates.mailchimp.com/development/html/)
- [Mailchimp Email Design Reference: Typography](https://templates.mailchimp.com/design/typography/)
- [Stack Overflow Email Typography](https://stackoverflow.design/email/base/typography/)
- [Really Good Emails](https://reallygoodemails.com/) -- Curated email design gallery

### CSS Support Reference

- [Can I Email?](https://www.caniemail.com/) -- CSS/HTML support matrix for email clients
- [Litmus: HTML/CSS Support Guide](https://litmus.com/community/discussions/8019-html-css-support-guide-for-email-clients)
- [Campaign Monitor: CSS Support](https://www.campaignmonitor.com/css/)

---

## Quick Reference: What Works Where

| Feature | Outlook (Word) | Gmail Web | Gmail App | Apple Mail | iOS Mail |
|---------|---------------|-----------|-----------|------------|----------|
| `<table>` layout | Yes | Yes | Yes | Yes | Yes |
| `<div>` layout | Partial | Yes | Yes | Yes | Yes |
| `max-width` | No (use ghost tables) | Yes | Yes | Yes | Yes |
| `display: inline-block` | No (use ghost tables) | Yes | Yes | Yes | Yes |
| Media queries | No | Yes | No | Yes | Yes |
| `@import` fonts | No | No | No | Yes | Yes |
| `<link>` fonts | No | No | No | Yes | Yes |
| Dark mode CSS | Very limited | No | No | Yes | Yes |
| `background-image` | VML only | Yes | Partial | Yes | Yes |
| `border-radius` | No | Yes | Yes | Yes | Yes |
| Padding on `<a>` | Partial (MSO fix) | Yes | Yes | Yes | Yes |
| `margin` | Partial | Yes | Yes | Yes | Yes |
| `padding` | Yes | Yes | Yes | Yes | Yes |

---

## Assembly Example: Putting Components Together

Here is how these building blocks assemble into a complete email. Each section references the component patterns above.

```
+------------------------------------------+
| [Boilerplate: Section 1]                 |
| DOCTYPE + head + meta + CSS resets       |
+------------------------------------------+
| [Container: Section 3]                   |
| 600px centered wrapper table             |
+------------------------------------------+
|   [Header: Section 7]                    |
|   Logo + optional nav                    |
+------------------------------------------+
|   [Hero: Section 8]                      |
|   Full-width image + headline + CTA      |
+------------------------------------------+
|   [Divider: Section 14]                  |
+------------------------------------------+
|   [Section Block: Section 8]             |
|   Heading + body text                    |
+------------------------------------------+
|   [Feature List: Section 10]             |
|   Icon + title + description rows        |
+------------------------------------------+
|   [CTA Button: Section 11]              |
+------------------------------------------+
|   [Divider: Section 14]                  |
+------------------------------------------+
|   [Two-Column: Section 5]               |
|   Image + text side by side              |
+------------------------------------------+
|   [Callout Box: Section 12]             |
|   Info card or testimonial               |
+------------------------------------------+
|   [Data Table: Section 13]              |
|   Pricing or schedule                    |
+------------------------------------------+
|   [CTA Button: Section 11]              |
+------------------------------------------+
|   [Footer: Section 16]                   |
|   Social + links + legal                 |
+------------------------------------------+
```

Each block is a self-contained `<tr>` inside the main email container `<table>`. Mix, match, and reorder as needed.
