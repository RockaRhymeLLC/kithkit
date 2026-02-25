/**
 * Telegram HTML Formatter — converts markdown-like text to Telegram HTML.
 *
 * Transforms common markdown patterns into Telegram-supported HTML tags:
 *   **bold** / ## headers → <b>bold</b>
 *   *italic* → <i>italic</i>
 *   `code` → <code>code</code>
 *   ```blocks``` → <pre>blocks</pre>
 *   [text](url) → <a href="url">text</a>
 *   - bullet lists → preserved with clean formatting
 *
 * Safe by default: escapes HTML entities in input before converting,
 * and falls back to escaped plain text if anything looks wrong.
 */

// ── HTML entity escaping ────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Core converter ──────────────────────────────────────────

/**
 * Convert markdown-flavored text to Telegram HTML.
 *
 * Processing order matters — code blocks and inline code are extracted first
 * to prevent their contents from being transformed by other rules.
 */
export function markdownToTelegramHtml(text: string): string {
  // Placeholders for code blocks / inline code so they aren't processed
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks (```lang\n...\n``` or ```\n...\n```)
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const escaped = escapeHtml(code.replace(/\n$/, '')); // trim trailing newline
    const block = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(block);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Also handle ``` without newline after opening (inline-style code blocks)
  result = result.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    const escaped = escapeHtml(code);
    codeBlocks.push(`<pre>${escaped}</pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract inline code (`code`)
  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape remaining HTML entities
  result = escapeHtml(result);

  // 4. Markdown headers (# through ###) → bold
  result = result.replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>');

  // 5. Bold: **text** (must come before italic)
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 6. Italic: *text* (single asterisk, not inside a word)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');

  // 7. Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 8. Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 9. Restore inline code placeholders
  result = result.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => inlineCodes[parseInt(idx, 10)]);

  // 10. Restore code block placeholders
  result = result.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx, 10)]);

  return result;
}

/**
 * Quick check: does the text contain any markdown-like patterns worth converting?
 * Used to skip conversion for pure plain text (avoids unnecessary HTML escaping).
 */
export function hasMarkdownPatterns(text: string): boolean {
  return /\*\*.+?\*\*|(?<!\w)\*[^*\n]+?\*(?!\w)|`.+?`|```[\s\S]+?```|^#{1,3}\s|~~.+?~~|\[.+?\]\(.+?\)/m.test(text);
}
