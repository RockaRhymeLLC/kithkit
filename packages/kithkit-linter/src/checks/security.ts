/**
 * Kithkit Linter — Security Checks
 *
 * Scans SKILL.md and other text files for security-sensitive patterns:
 * prompt injection, exfiltration, credential access.
 *
 * Supports both single-line and multi-line pattern matching. Multi-line
 * patterns test against whitespace-normalized content to catch attacks
 * split across lines (e.g., "ignore\nall previous\ninstructions").
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, Finding } from '../types.ts';
import { PROMPT_INJECTION_PATTERNS } from '../patterns/prompt-injection.ts';
import type { SecurityPattern } from '../patterns/prompt-injection.ts';
import { EXFILTRATION_PATTERNS } from '../patterns/exfiltration.ts';
import { CREDENTIAL_ACCESS_PATTERNS } from '../patterns/credential-access.ts';

const ALL_PATTERNS: SecurityPattern[] = [
  ...PROMPT_INJECTION_PATTERNS,
  ...EXFILTRATION_PATTERNS,
  ...CREDENTIAL_ACCESS_PATTERNS,
];

const LINE_PATTERNS = ALL_PATTERNS.filter(p => !p.multiline);
const MULTILINE_PATTERNS = ALL_PATTERNS.filter(p => p.multiline);

const TEXT_FILES = ['SKILL.md', 'reference.md', 'CHANGELOG.md'];

/**
 * Normalize content for multi-line matching: collapse all whitespace
 * (newlines, tabs, multiple spaces) into single spaces.
 * This lets patterns match text split across arbitrary line boundaries.
 */
function normalizeWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ');
}

/**
 * Run security checks against all text files in the skill package.
 */
export function checkSecurity(skillDir: string): CheckResult {
  const findings: Finding[] = [];

  for (const file of TEXT_FILES) {
    const filePath = join(skillDir, file);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Pass 1: Single-line pattern matching (existing behavior)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of LINE_PATTERNS) {
        if (pattern.pattern.test(line)) {
          findings.push({
            severity: pattern.severity,
            check: `security/${pattern.id}`,
            message: pattern.description,
            file,
            line: i + 1,
            pattern: pattern.pattern.source,
          });
        }
      }
    }

    // Pass 2: Multi-line pattern matching (whitespace-normalized full content)
    if (MULTILINE_PATTERNS.length > 0) {
      const normalized = normalizeWhitespace(content);
      for (const pattern of MULTILINE_PATTERNS) {
        // Reset regex lastIndex in case pattern has 'g' flag
        pattern.pattern.lastIndex = 0;
        if (pattern.pattern.test(normalized)) {
          // Check if this was already caught by the single-line pass
          // (avoid duplicate findings for patterns that match on a single line too)
          const baseId = pattern.id.replace(/-multiline$/, '');
          const alreadyCaught = findings.some(
            f => f.file === file && f.check === `security/${baseId}`
          );
          if (!alreadyCaught) {
            findings.push({
              severity: pattern.severity,
              check: `security/${pattern.id}`,
              message: `${pattern.description}`,
              file,
              pattern: pattern.pattern.source,
              // No line number for multi-line matches — the pattern spans lines
            });
          }
        }
      }
    }
  }

  const hasErrors = findings.some(f => f.severity === 'error');
  return { pass: !hasErrors, findings };
}
