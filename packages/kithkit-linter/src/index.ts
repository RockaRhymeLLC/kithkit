/**
 * Kithkit Linter — Main Entry Point
 *
 * Runs all check categories against a skill package directory.
 * Returns a unified LintResult.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LintResult, CheckResult } from './types.ts';
import { checkStructure } from './checks/structure.ts';
import { parseAndValidateManifest } from './checks/manifest.ts';
import { checkSecurity } from './checks/security.ts';
import { checkScope } from './checks/scope.ts';
import { checkNaming } from './checks/naming.ts';
import { checkUnicode } from './checks/unicode.ts';

export { checkStructure } from './checks/structure.ts';
export { parseAndValidateManifest, validateManifest } from './checks/manifest.ts';
export { checkSecurity } from './checks/security.ts';
export { checkScope } from './checks/scope.ts';
export { checkNaming, levenshtein } from './checks/naming.ts';
export { checkUnicode } from './checks/unicode.ts';
export { isKnownCapability, WELL_KNOWN_CAPABILITIES, getCapabilityDescription } from './capabilities.ts';
export type { LintResult, CheckResult, Finding, SkillManifest, ConfigField, Severity } from './types.ts';
export {
  REQUIRED_FILES,
  OPTIONAL_FILES,
  MANIFEST_NAME_PATTERN,
  CONFIG_TYPES,
  TRUST_LEVELS,
} from './types.ts';

/**
 * Lint a skill package directory. Runs all applicable checks.
 */
export function lint(skillDir: string): LintResult {
  const start = performance.now();
  const checks: Record<string, CheckResult> = {};

  // 1. Structure checks
  checks['structure'] = checkStructure(skillDir);

  // 2. Manifest checks (only if manifest.yaml exists)
  const manifestPath = join(skillDir, 'manifest.yaml');
  if (existsSync(manifestPath)) {
    const yamlContent = readFileSync(manifestPath, 'utf-8');
    checks['manifest'] = parseAndValidateManifest(yamlContent);
  }
  // If manifest doesn't exist, structure check already flagged it

  // 3. Security checks
  checks['security'] = checkSecurity(skillDir);

  // 4. Scope check
  checks['scope'] = checkScope(skillDir);

  // 5. Unicode check
  checks['unicode'] = checkUnicode(skillDir);

  // 6. Naming check (from manifest name, if available)
  if (existsSync(manifestPath)) {
    try {
      const manifest = parseYaml(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown> | null;
      if (manifest?.name) {
        checks['naming'] = checkNaming(String(manifest.name));
      }
    } catch {
      // manifest parse error already handled
    }
  }

  // Aggregate results
  let errors = 0, warnings = 0, info = 0;
  for (const result of Object.values(checks)) {
    for (const finding of result.findings) {
      if (finding.severity === 'error') errors++;
      else if (finding.severity === 'warning') warnings++;
      else info++;
    }
  }

  const duration_ms = Math.round(performance.now() - start);

  return {
    pass: errors === 0,
    score: { errors, warnings, info },
    checks,
    duration_ms,
  };
}
