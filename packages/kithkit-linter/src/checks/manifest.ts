/**
 * Kithkit Linter — Manifest Validation
 *
 * Validates manifest.yaml against the skill manifest schema.
 * Returns structured findings with actionable error messages.
 */

import { parse as parseYaml } from 'yaml';
import { valid as semverValid } from 'semver';
import type { CheckResult, Finding, SkillManifest, ConfigField } from '../types.ts';
import {
  MANIFEST_NAME_PATTERN,
  MANIFEST_NAME_MIN_LENGTH,
  MANIFEST_NAME_MAX_LENGTH,
  CONFIG_TYPES,
  TRUST_LEVELS,
} from '../types.ts';
import { isKnownCapability } from '../capabilities.ts';

/**
 * Validate a parsed manifest object.
 */
export function validateManifest(manifest: Record<string, unknown>): CheckResult {
  const findings: Finding[] = [];

  // --- Required fields ---
  validateName(manifest, findings);
  validateVersion(manifest, findings);
  validateDescription(manifest, findings);
  validateAuthor(manifest, findings);
  validateCapabilities(manifest, findings);

  // --- Optional fields ---
  validateConfig(manifest, findings);
  validateTags(manifest, findings);
  validateCategory(manifest, findings);
  validateTrustLevel(manifest, findings);
  validateFrameworks(manifest, findings);

  const hasErrors = findings.some(f => f.severity === 'error');
  return { pass: !hasErrors, findings };
}

/**
 * Parse and validate a manifest.yaml string.
 */
export function parseAndValidateManifest(yamlContent: string): CheckResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlContent);
  } catch (e) {
    return {
      pass: false,
      findings: [{
        severity: 'error',
        check: 'manifest/parse',
        message: `Invalid YAML: ${(e as Error).message}`,
        file: 'manifest.yaml',
      }],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      pass: false,
      findings: [{
        severity: 'error',
        check: 'manifest/parse',
        message: 'Manifest must be a YAML mapping (object)',
        file: 'manifest.yaml',
      }],
    };
  }

  return validateManifest(parsed as Record<string, unknown>);
}

// --- Field validators ---

function validateName(m: Record<string, unknown>, findings: Finding[]) {
  if (!('name' in m) || m.name === undefined || m.name === null) {
    findings.push({
      severity: 'error',
      check: 'manifest/name',
      message: "'name' is required",
      file: 'manifest.yaml',
    });
    return;
  }

  const name = String(m.name);

  if (name.length < MANIFEST_NAME_MIN_LENGTH || name.length > MANIFEST_NAME_MAX_LENGTH) {
    findings.push({
      severity: 'error',
      check: 'manifest/name',
      message: `name must be ${MANIFEST_NAME_MIN_LENGTH}-${MANIFEST_NAME_MAX_LENGTH} characters, got ${name.length}`,
      file: 'manifest.yaml',
    });
  }

  if (!MANIFEST_NAME_PATTERN.test(name)) {
    findings.push({
      severity: 'error',
      check: 'manifest/name',
      message: 'name must be lowercase alphanumeric with hyphens (e.g., "my-skill"), matching ^[a-z0-9][a-z0-9-]*[a-z0-9]$',
      file: 'manifest.yaml',
    });
  }
}

function validateVersion(m: Record<string, unknown>, findings: Finding[]) {
  if (!('version' in m) || !m.version) {
    findings.push({
      severity: 'error',
      check: 'manifest/version',
      message: "'version' is required",
      file: 'manifest.yaml',
    });
    return;
  }

  const version = String(m.version);
  if (!semverValid(version)) {
    findings.push({
      severity: 'error',
      check: 'manifest/version',
      message: `invalid semver: '${version}'`,
      file: 'manifest.yaml',
    });
  }
}

function validateDescription(m: Record<string, unknown>, findings: Finding[]) {
  if (!('description' in m) || !m.description) {
    findings.push({
      severity: 'error',
      check: 'manifest/description',
      message: "'description' is required",
      file: 'manifest.yaml',
    });
  }
}

function validateAuthor(m: Record<string, unknown>, findings: Finding[]) {
  if (!('author' in m) || !m.author || typeof m.author !== 'object') {
    findings.push({
      severity: 'error',
      check: 'manifest/author',
      message: "'author' is required (object with 'name' and 'github' fields)",
      file: 'manifest.yaml',
    });
    return;
  }

  const author = m.author as Record<string, unknown>;

  if (!author.name || typeof author.name !== 'string') {
    findings.push({
      severity: 'error',
      check: 'manifest/author',
      message: "'author.name' is required",
      file: 'manifest.yaml',
    });
  }

  if (!author.github || typeof author.github !== 'string') {
    findings.push({
      severity: 'error',
      check: 'manifest/author',
      message: "'author.github' is required (GitHub username — author identity for v1)",
      file: 'manifest.yaml',
    });
  }
}

function validateCapabilities(m: Record<string, unknown>, findings: Finding[]) {
  if (!('capabilities' in m) || !m.capabilities || typeof m.capabilities !== 'object') {
    findings.push({
      severity: 'error',
      check: 'manifest/capabilities',
      message: "'capabilities' is required (object with 'required' array)",
      file: 'manifest.yaml',
    });
    return;
  }

  const caps = m.capabilities as Record<string, unknown>;

  if (!Array.isArray(caps.required)) {
    findings.push({
      severity: 'error',
      check: 'manifest/capabilities',
      message: "'capabilities.required' must be an array",
      file: 'manifest.yaml',
    });
    return;
  }

  if (caps.required.length === 0) {
    findings.push({
      severity: 'warning',
      check: 'manifest/capabilities',
      message: 'skill declares no required capabilities',
      file: 'manifest.yaml',
    });
  }

  // Validate each capability
  for (const cap of caps.required) {
    if (typeof cap !== 'string') {
      findings.push({
        severity: 'error',
        check: 'manifest/capabilities',
        message: `capability must be a string, got ${typeof cap}`,
        file: 'manifest.yaml',
      });
      continue;
    }
    if (!isKnownCapability(cap)) {
      findings.push({
        severity: 'warning',
        check: 'manifest/capabilities',
        message: `unknown capability '${cap}' (not in well-known list)`,
        file: 'manifest.yaml',
      });
    }
  }

  // Optional capabilities
  if (caps.optional && Array.isArray(caps.optional)) {
    for (const cap of caps.optional) {
      if (typeof cap !== 'string') {
        findings.push({
          severity: 'error',
          check: 'manifest/capabilities',
          message: `capability must be a string, got ${typeof cap}`,
          file: 'manifest.yaml',
        });
        continue;
      }
      if (!isKnownCapability(cap)) {
        findings.push({
          severity: 'warning',
          check: 'manifest/capabilities',
          message: `unknown capability '${cap}' (not in well-known list)`,
          file: 'manifest.yaml',
        });
      }
    }
  }
}

function validateConfig(m: Record<string, unknown>, findings: Finding[]) {
  if (!('config' in m) || !m.config) return;

  if (!Array.isArray(m.config)) {
    findings.push({
      severity: 'error',
      check: 'manifest/config',
      message: "'config' must be an array of config field definitions",
      file: 'manifest.yaml',
    });
    return;
  }

  for (const field of m.config) {
    if (!field || typeof field !== 'object') {
      findings.push({
        severity: 'error',
        check: 'manifest/config',
        message: 'config field must be an object',
        file: 'manifest.yaml',
      });
      continue;
    }

    const f = field as Record<string, unknown>;

    if (!f.key || typeof f.key !== 'string') {
      findings.push({
        severity: 'error',
        check: 'manifest/config',
        message: "config field missing required 'key'",
        file: 'manifest.yaml',
      });
    }

    if (!f.type || typeof f.type !== 'string') {
      findings.push({
        severity: 'error',
        check: 'manifest/config',
        message: `config field '${f.key || '?'}' missing required 'type'`,
        file: 'manifest.yaml',
      });
    } else if (!(CONFIG_TYPES as readonly string[]).includes(f.type)) {
      findings.push({
        severity: 'error',
        check: 'manifest/config',
        message: `config type must be one of ${CONFIG_TYPES.join('|')}, got '${f.type}'`,
        file: 'manifest.yaml',
      });
    }

    if (f.type === 'enum' && (!Array.isArray(f.enum_values) || f.enum_values.length === 0)) {
      findings.push({
        severity: 'error',
        check: 'manifest/config',
        message: `config field '${f.key || '?'}' with type 'enum' must have non-empty 'enum_values'`,
        file: 'manifest.yaml',
      });
    }

    if (!('description' in f) || typeof f.description !== 'string') {
      findings.push({
        severity: 'warning',
        check: 'manifest/config',
        message: `config field '${f.key || '?'}' missing 'description'`,
        file: 'manifest.yaml',
      });
    }
  }
}

function validateTags(m: Record<string, unknown>, findings: Finding[]) {
  if (!('tags' in m) || !m.tags) return;
  if (!Array.isArray(m.tags)) {
    findings.push({
      severity: 'error',
      check: 'manifest/tags',
      message: "'tags' must be an array of strings",
      file: 'manifest.yaml',
    });
  }
}

function validateCategory(m: Record<string, unknown>, findings: Finding[]) {
  if (!('category' in m) || !m.category) return;
  if (typeof m.category !== 'string') {
    findings.push({
      severity: 'error',
      check: 'manifest/category',
      message: "'category' must be a string",
      file: 'manifest.yaml',
    });
  }
}

function validateTrustLevel(m: Record<string, unknown>, findings: Finding[]) {
  if (!('trust_level' in m) || !m.trust_level) return;

  // trust_level is catalog-set, not author-set — warn if present in submission
  findings.push({
    severity: 'info',
    check: 'manifest/trust_level',
    message: "'trust_level' is set by the catalog, not by authors — this field will be ignored in submissions",
    file: 'manifest.yaml',
  });
}

function validateFrameworks(m: Record<string, unknown>, findings: Finding[]) {
  if (!('frameworks' in m) || !m.frameworks) return;
  if (typeof m.frameworks !== 'object') {
    findings.push({
      severity: 'error',
      check: 'manifest/frameworks',
      message: "'frameworks' must be an object",
      file: 'manifest.yaml',
    });
    return;
  }

  const fw = m.frameworks as Record<string, unknown>;
  if (fw.tested && !Array.isArray(fw.tested)) {
    findings.push({
      severity: 'error',
      check: 'manifest/frameworks',
      message: "'frameworks.tested' must be an array of strings",
      file: 'manifest.yaml',
    });
  }
}
