/**
 * Kithkit Linter — Core Types
 *
 * Data model for skill manifests, linter results, and package structure.
 */

// --- Manifest Types ---

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: {
    name: string;
    github: string;
  };
  capabilities: {
    required: string[];
    optional?: string[];
  };
  config?: ConfigField[];
  tags?: string[];
  category?: string;
  recommends?: string[];
  trust_level?: 'first-party' | 'verified' | 'community';
  frameworks?: {
    tested?: string[];
  };
}

export interface ConfigField {
  key: string;
  type: 'credential' | 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  default?: string | number | boolean;
  description: string;
  enum_values?: string[];  // required when type is 'enum'
}

// --- Linter Result Types ---

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  check: string;
  message: string;
  file?: string;
  line?: number;
  pattern?: string;
}

export interface CheckResult {
  pass: boolean;
  findings: Finding[];
}

export interface LintResult {
  pass: boolean;
  score: { errors: number; warnings: number; info: number };
  checks: Record<string, CheckResult>;
  duration_ms: number;
}

// --- Package Structure ---

export const REQUIRED_FILES = ['manifest.yaml', 'SKILL.md'] as const;
export const OPTIONAL_FILES = ['reference.md', 'CHANGELOG.md'] as const;
export const LOCAL_ONLY_FILES = ['config.yaml', '.kithkit'] as const;

export const MANIFEST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const MANIFEST_NAME_MIN_LENGTH = 2;
export const MANIFEST_NAME_MAX_LENGTH = 64;

export const CONFIG_TYPES = ['credential', 'string', 'number', 'boolean', 'enum'] as const;
export type ConfigType = typeof CONFIG_TYPES[number];

export const TRUST_LEVELS = ['first-party', 'verified', 'community'] as const;
export type TrustLevel = typeof TRUST_LEVELS[number];
