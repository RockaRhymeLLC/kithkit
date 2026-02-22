# SEO and Social Sharing

Structured data, Open Graph, canonical URLs, robots.txt, and sitemap best practices.

---

## Structured Data (JSON-LD)

### Website Schema

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Your Site Name",
  "url": "https://example.com",
  "description": "Your site description."
}
</script>
```

### Organization Schema

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Your Organization",
  "url": "https://example.com",
  "logo": "https://example.com/logo.png",
  "sameAs": [
    "https://github.com/your-org"
  ]
}
```

### Blog Post Schema

```json
{
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  "headline": "Your Post Title",
  "author": {
    "@type": "Person",
    "name": "Author Name"
  },
  "datePublished": "2026-01-15",
  "image": "https://example.com/blog/post-og.png",
  "publisher": {
    "@type": "Organization",
    "name": "Your Organization",
    "logo": {
      "@type": "ImageObject",
      "url": "https://example.com/logo.png"
    }
  }
}
```

### Software Application Schema

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Your App",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "macOS",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "author": {
    "@type": "Organization",
    "name": "Your Organization"
  }
}
```

**Test Structured Data:**
- Google Rich Results Test: https://search.google.com/test/rich-results
- Schema.org validator: https://validator.schema.org/

---

## Open Graph Best Practices

### Standard Tags

```html
<meta property="og:type" content="website">
<meta property="og:title" content="Your Page Title">
<meta property="og:description" content="Your page description.">
<meta property="og:url" content="https://example.com">
<meta property="og:site_name" content="Your Site">
<meta property="og:image" content="https://example.com/og-image.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Description of the image">
```

### Article Tags (for blog posts)

```html
<meta property="og:type" content="article">
<meta property="article:published_time" content="2026-01-15T12:00:00Z">
<meta property="article:modified_time" content="2026-01-15T14:00:00Z">
<meta property="article:author" content="Author Name">
<meta property="article:tag" content="topic1">
<meta property="article:tag" content="topic2">
```

### Twitter Card

```html
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@yourhandle">
<meta name="twitter:creator" content="@yourhandle">
<meta name="twitter:title" content="Your Page Title">
<meta name="twitter:description" content="Your page description.">
<meta name="twitter:image" content="https://example.com/og-image.png">
<meta name="twitter:image:alt" content="Description of the image">
```

### OG Image Requirements

- **Size:** 1200x630px (1.91:1 ratio)
- **Format:** PNG or JPG (PNG preferred for text/logos)
- **Max file size:** 8MB (but keep < 300KB for fast loading)
- **No text cutoff:** Keep important content in center 1200x600px
- **Test:** https://www.opengraph.xyz/

---

## Canonical URLs

Every page should have a canonical URL to prevent duplicate content penalties.

```html
<!-- Homepage -->
<link rel="canonical" href="https://example.com">

<!-- Blog post -->
<link rel="canonical" href="https://example.com/blog/my-post">

<!-- If content is syndicated elsewhere, point back to original -->
<link rel="canonical" href="https://example.com/blog/original-post">
```

### Pagination

```html
<!-- Page 1 -->
<link rel="canonical" href="https://example.com/blog">

<!-- Page 2 -->
<link rel="canonical" href="https://example.com/blog?page=2">
<link rel="prev" href="https://example.com/blog">
<link rel="next" href="https://example.com/blog?page=3">
```

---

## Robots and Sitemap

### robots.txt

```
User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml

# Block search from indexing internal tools
Disallow: /admin/
Disallow: /_internal/
```

### sitemap.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-01-15</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/blog</loc>
    <lastmod>2026-01-15</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>
```

### Generate Sitemap Automatically

```javascript
import { writeFileSync } from 'fs';

const pages = [
  { url: '/', priority: 1.0, changefreq: 'weekly' },
  { url: '/blog', priority: 0.9, changefreq: 'daily' },
  // ... add pages dynamically
];

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>https://example.com${p.url}</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

writeFileSync('public/sitemap.xml', xml);
```

**Submit sitemap to Google Search Console:** https://search.google.com/search-console
