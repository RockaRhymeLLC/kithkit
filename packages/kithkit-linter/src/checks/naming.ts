/**
 * Kithkit Linter — Naming Check
 *
 * Validates skill names: character rules, length, reserved names,
 * and typosquat detection via Levenshtein distance.
 */

import type { CheckResult, Finding } from '../types.ts';
import { MANIFEST_NAME_PATTERN, MANIFEST_NAME_MIN_LENGTH, MANIFEST_NAME_MAX_LENGTH } from '../types.ts';

// Reserved names that cannot be used as skill names
const RESERVED_NAMES = new Set([
  'kithkit',
  'catalog',
  'linter',
  'sign',
  'test',
  'config',
  'core',
  'system',
  'admin',
  'root',
  'plugin',
  'skill',
  'skills',
  'official',
  'internal',
]);

/**
 * Check a skill name against naming rules.
 * @param name The skill name to validate
 * @param existingNames Optional list of existing skill names (for typosquat detection)
 */
export function checkNaming(name: string, existingNames: string[] = []): CheckResult {
  const findings: Finding[] = [];

  // Length check
  if (name.length < MANIFEST_NAME_MIN_LENGTH) {
    findings.push({
      severity: 'error',
      check: 'naming/length',
      message: `name too short: '${name}' (minimum ${MANIFEST_NAME_MIN_LENGTH} characters)`,
    });
  }

  if (name.length > MANIFEST_NAME_MAX_LENGTH) {
    findings.push({
      severity: 'error',
      check: 'naming/length',
      message: `name too long: '${name}' (maximum ${MANIFEST_NAME_MAX_LENGTH} characters)`,
    });
  }

  // Pattern check (lowercase alphanumeric + hyphens)
  if (!MANIFEST_NAME_PATTERN.test(name)) {
    // Give a more specific error for common mistakes
    if (name !== name.toLowerCase()) {
      findings.push({
        severity: 'error',
        check: 'naming/case',
        message: `name must be lowercase: '${name}'`,
      });
    } else {
      findings.push({
        severity: 'error',
        check: 'naming/pattern',
        message: `invalid name '${name}': must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$`,
      });
    }
  }

  // Reserved names
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    findings.push({
      severity: 'error',
      check: 'naming/reserved',
      message: `'${name}' is a reserved name`,
    });
  }

  // Typosquat detection
  for (const existing of existingNames) {
    if (existing === name) continue; // same name, different check
    const distance = levenshtein(name, existing);
    if (distance > 0 && distance <= 2) {
      findings.push({
        severity: 'warning',
        check: 'naming/typosquat',
        message: `name '${name}' is similar to existing skill '${existing}' (Levenshtein distance: ${distance})`,
      });
    }
  }

  const hasErrors = findings.some(f => f.severity === 'error');
  return { pass: !hasErrors, findings };
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}
