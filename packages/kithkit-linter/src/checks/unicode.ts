/**
 * Kithkit Linter — Unicode Check
 *
 * Detects hidden Unicode characters that could be used for attacks:
 * - Unicode Tags (U+E0001-U+E007F): invisible instruction embedding
 * - Homoglyphs: Cyrillic/Greek lookalikes for Latin characters
 * - Zero-width characters: invisible text manipulation
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, Finding } from '../types.ts';

// Unicode Tag range (U+E0001 to U+E007F) — used for invisible text
const UNICODE_TAG_RANGE = /[\u{E0001}-\u{E007F}]/u;

// Zero-width characters
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF]/;

// Common Cyrillic homoglyphs for Latin letters
// These are Cyrillic characters that look identical to Latin ones
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  '\u0430': 'a', // Cyrillic а
  '\u0435': 'e', // Cyrillic е
  '\u043E': 'o', // Cyrillic о
  '\u0440': 'p', // Cyrillic р
  '\u0441': 'c', // Cyrillic с
  '\u0443': 'y', // Cyrillic у (looks like y in some fonts)
  '\u0445': 'x', // Cyrillic х
  '\u0410': 'A', // Cyrillic А
  '\u0412': 'B', // Cyrillic В
  '\u0415': 'E', // Cyrillic Е
  '\u041A': 'K', // Cyrillic К
  '\u041C': 'M', // Cyrillic М
  '\u041D': 'H', // Cyrillic Н
  '\u041E': 'O', // Cyrillic О
  '\u0420': 'P', // Cyrillic Р
  '\u0421': 'C', // Cyrillic С
  '\u0422': 'T', // Cyrillic Т
  '\u0425': 'X', // Cyrillic Х
};

const HOMOGLYPH_PATTERN = new RegExp(`[${Object.keys(CYRILLIC_HOMOGLYPHS).join('')}]`);

// CJK ranges — legitimate non-ASCII that should NOT be flagged
const CJK_RANGES = /[\u3000-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/u;
const HIRAGANA_KATAKANA = /[\u3040-\u30FF\u31F0-\u31FF]/;

const TEXT_FILES = ['SKILL.md', 'reference.md', 'CHANGELOG.md', 'manifest.yaml'];

/**
 * Check for hidden Unicode characters in skill text files.
 */
export function checkUnicode(skillDir: string): CheckResult {
  const findings: Finding[] = [];

  for (const file of TEXT_FILES) {
    const filePath = join(skillDir, file);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for Unicode Tags (always error — these are invisible instruction embedding)
      if (UNICODE_TAG_RANGE.test(line)) {
        findings.push({
          severity: 'error',
          check: 'unicode/tags',
          message: 'Hidden Unicode Tags detected (U+E0001-U+E007F range) — may contain invisible instructions',
          file,
          line: i + 1,
        });
      }

      // Check for zero-width characters
      if (ZERO_WIDTH_CHARS.test(line)) {
        findings.push({
          severity: 'warning',
          check: 'unicode/zero-width',
          message: 'Zero-width character detected — may be used for text manipulation',
          file,
          line: i + 1,
        });
      }

      // Check for homoglyphs — but skip lines that are in CJK/Japanese context
      if (HOMOGLYPH_PATTERN.test(line) && !CJK_RANGES.test(line) && !HIRAGANA_KATAKANA.test(line)) {
        // Find the specific homoglyphs
        const found: string[] = [];
        for (const [char, latin] of Object.entries(CYRILLIC_HOMOGLYPHS)) {
          if (line.includes(char)) {
            found.push(`'${char}' (Cyrillic, looks like Latin '${latin}')`);
          }
        }
        if (found.length > 0) {
          findings.push({
            severity: 'warning',
            check: 'unicode/homoglyph',
            message: `Homoglyph character(s) detected: ${found.join(', ')}`,
            file,
            line: i + 1,
          });
        }
      }
    }
  }

  const hasErrors = findings.some(f => f.severity === 'error');
  return { pass: !hasErrors, findings };
}
