/**
 * Tests for Telegram HTML formatter (telegram-format.ts)
 *
 * Covers: markdown-to-HTML conversion, HTML escaping, edge cases,
 * plain text passthrough, and the hasMarkdownPatterns detector.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToTelegramHtml, hasMarkdownPatterns } from '../extensions/comms/adapters/telegram-format.js';

// ── Bold ────────────────────────────────────────────────────

describe('markdownToTelegramHtml — bold', () => {
  it('converts **bold** to <b>', () => {
    assert.equal(markdownToTelegramHtml('Hello **world**'), 'Hello <b>world</b>');
  });

  it('handles multiple bold spans', () => {
    assert.equal(
      markdownToTelegramHtml('**one** and **two**'),
      '<b>one</b> and <b>two</b>',
    );
  });
});

// ── Italic ──────────────────────────────────────────────────

describe('markdownToTelegramHtml — italic', () => {
  it('converts *italic* to <i>', () => {
    assert.equal(markdownToTelegramHtml('Hello *world*'), 'Hello <i>world</i>');
  });

  it('does not convert mid-word asterisks', () => {
    // file*name*here — asterisks touching word chars should not convert
    const result = markdownToTelegramHtml('file*name*here');
    assert.equal(result, 'file*name*here');
  });
});

// ── Bold + Italic together ──────────────────────────────────

describe('markdownToTelegramHtml — bold and italic', () => {
  it('handles both **bold** and *italic* in same text', () => {
    const result = markdownToTelegramHtml('**bold** and *italic*');
    assert.equal(result, '<b>bold</b> and <i>italic</i>');
  });
});

// ── Inline code ─────────────────────────────────────────────

describe('markdownToTelegramHtml — inline code', () => {
  it('converts `code` to <code>', () => {
    assert.equal(markdownToTelegramHtml('Run `npm install`'), 'Run <code>npm install</code>');
  });

  it('escapes HTML inside inline code', () => {
    assert.equal(markdownToTelegramHtml('Use `<div>`'), 'Use <code>&lt;div&gt;</code>');
  });

  it('does not apply bold/italic inside code', () => {
    assert.equal(
      markdownToTelegramHtml('`**not bold**`'),
      '<code>**not bold**</code>',
    );
  });
});

// ── Code blocks ─────────────────────────────────────────────

describe('markdownToTelegramHtml — code blocks', () => {
  it('converts fenced code block to <pre>', () => {
    const input = '```\nconsole.log("hi");\n```';
    assert.equal(markdownToTelegramHtml(input), '<pre>console.log(&quot;hi&quot;);</pre>');
  });

  it('converts code block with language to <pre><code>', () => {
    const input = '```typescript\nconst x = 1;\n```';
    assert.equal(
      markdownToTelegramHtml(input),
      '<pre><code class="language-typescript">const x = 1;</code></pre>',
    );
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<script>alert(1)</script>\n```';
    assert.equal(
      markdownToTelegramHtml(input),
      '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>',
    );
  });

  it('does not process markdown inside code blocks', () => {
    const input = '```\n**bold** and *italic*\n```';
    assert.equal(
      markdownToTelegramHtml(input),
      '<pre>**bold** and *italic*</pre>',
    );
  });
});

// ── Headers ─────────────────────────────────────────────────

describe('markdownToTelegramHtml — headers', () => {
  it('converts # header to bold', () => {
    assert.equal(markdownToTelegramHtml('# Title'), '<b>Title</b>');
  });

  it('converts ## header to bold', () => {
    assert.equal(markdownToTelegramHtml('## Section'), '<b>Section</b>');
  });

  it('converts ### header to bold', () => {
    assert.equal(markdownToTelegramHtml('### Subsection'), '<b>Subsection</b>');
  });

  it('only converts headers at start of line', () => {
    assert.equal(markdownToTelegramHtml('Not a # header'), 'Not a # header');
  });
});

// ── Links ───────────────────────────────────────────────────

describe('markdownToTelegramHtml — links', () => {
  it('converts [text](url) to <a>', () => {
    assert.equal(
      markdownToTelegramHtml('[Click here](https://example.com)'),
      '<a href="https://example.com">Click here</a>',
    );
  });
});

// ── Strikethrough ───────────────────────────────────────────

describe('markdownToTelegramHtml — strikethrough', () => {
  it('converts ~~text~~ to <s>', () => {
    assert.equal(markdownToTelegramHtml('~~deleted~~'), '<s>deleted</s>');
  });
});

// ── HTML escaping ───────────────────────────────────────────

describe('markdownToTelegramHtml — HTML escaping', () => {
  it('escapes < > & " in regular text', () => {
    assert.equal(
      markdownToTelegramHtml('x < y & z > w "quoted"'),
      'x &lt; y &amp; z &gt; w &quot;quoted&quot;',
    );
  });

  it('escapes entities but still applies bold', () => {
    assert.equal(
      markdownToTelegramHtml('**a < b**'),
      '<b>a &lt; b</b>',
    );
  });
});

// ── Plain text passthrough ──────────────────────────────────

describe('markdownToTelegramHtml — plain text', () => {
  it('returns escaped plain text unchanged', () => {
    assert.equal(
      markdownToTelegramHtml('Just a normal message with no formatting.'),
      'Just a normal message with no formatting.',
    );
  });

  it('preserves newlines', () => {
    assert.equal(
      markdownToTelegramHtml('Line one\nLine two\nLine three'),
      'Line one\nLine two\nLine three',
    );
  });
});

// ── Complex / mixed ─────────────────────────────────────────

describe('markdownToTelegramHtml — complex messages', () => {
  it('handles a realistic mixed-format message', () => {
    const input = [
      '## Status Report',
      '',
      '**Task**: Deploy the app',
      '*Priority*: High',
      '',
      'Run `npm run build` then:',
      '```bash',
      'docker push myapp:latest',
      '```',
      '',
      'See [docs](https://docs.example.com) for details.',
    ].join('\n');

    const result = markdownToTelegramHtml(input);

    assert.ok(result.includes('<b>Status Report</b>'));
    assert.ok(result.includes('<b>Task</b>: Deploy the app'));
    assert.ok(result.includes('<i>Priority</i>: High'));
    assert.ok(result.includes('<code>npm run build</code>'));
    assert.ok(result.includes('<pre><code class="language-bash">docker push myapp:latest</code></pre>'));
    assert.ok(result.includes('<a href="https://docs.example.com">docs</a>'));
  });

  it('handles bullet lists (preserved as-is)', () => {
    const input = '- Item one\n- Item two\n- Item three';
    const result = markdownToTelegramHtml(input);
    assert.equal(result, '- Item one\n- Item two\n- Item three');
  });
});

// ── hasMarkdownPatterns ─────────────────────────────────────

describe('hasMarkdownPatterns', () => {
  it('detects bold', () => {
    assert.equal(hasMarkdownPatterns('Hello **world**'), true);
  });

  it('detects italic', () => {
    assert.equal(hasMarkdownPatterns('Hello *world*'), true);
  });

  it('detects inline code', () => {
    assert.equal(hasMarkdownPatterns('Run `npm install`'), true);
  });

  it('detects code blocks', () => {
    assert.equal(hasMarkdownPatterns('```\ncode\n```'), true);
  });

  it('detects headers', () => {
    assert.equal(hasMarkdownPatterns('## Title'), true);
  });

  it('detects links', () => {
    assert.equal(hasMarkdownPatterns('[text](url)'), true);
  });

  it('returns false for plain text', () => {
    assert.equal(hasMarkdownPatterns('Just a normal message'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(hasMarkdownPatterns(''), false);
  });
});
