/**
 * Agent profile loader and validator.
 *
 * Profiles are .md files with YAML frontmatter defining 7 core fields.
 * The markdown body becomes the systemPrompt append content.
 * Profiles are loaded from a configurable directory (default: .claude/agents/).
 * Built-in profiles ship in profiles/ and are copied during init.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ── Types ────────────────────────────────────────────────────

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface AgentProfile {
  name: string;
  description: string;
  tools: string[];
  disallowedTools: string[];
  model: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  maxTurns: number;
  /** Controls how much effort Claude puts into responses (maps to SDK effort param) */
  effort: EffortLevel;
  /** Markdown body — becomes systemPrompt append content */
  body: string;
  /** Override global pre_task_injection.max_memories_injected for this profile. */
  max_memories_injected?: number;
}

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

// ── Constants ────────────────────────────────────────────────

const VALID_PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const;
const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;

const DEFAULTS: Omit<AgentProfile, 'name' | 'body'> = {
  description: '',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 20,
  effort: 'high',
};

// ── Parsing ──────────────────────────────────────────────────

/**
 * Parse a profile .md file into frontmatter + body.
 * Supports standard YAML frontmatter delimited by `---`.
 */
export function parseProfileContent(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trim();

  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const yamlStr = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (yaml.load(yamlStr) as Record<string, unknown>) ?? {};
  } catch {
    throw new ProfileValidationError('Invalid YAML frontmatter');
  }

  return { frontmatter, body };
}

// ── Validation ───────────────────────────────────────────────

/**
 * Validate and normalize a profile from parsed frontmatter + body.
 * Applies defaults for optional fields.
 * Unknown fields are silently ignored (forward-compatible).
 */
export function validateProfile(
  frontmatter: Record<string, unknown>,
  body: string,
): AgentProfile {
  // Required: name
  if (!frontmatter.name || typeof frontmatter.name !== 'string') {
    throw new ProfileValidationError('name is required');
  }

  // Validate permissionMode if provided
  if (frontmatter.permissionMode !== undefined) {
    if (!VALID_PERMISSION_MODES.includes(frontmatter.permissionMode as typeof VALID_PERMISSION_MODES[number])) {
      throw new ProfileValidationError(
        `invalid permissionMode: '${frontmatter.permissionMode}' (must be ${VALID_PERMISSION_MODES.join(', ')})`,
      );
    }
  }

  // Validate maxTurns if provided
  if (frontmatter.maxTurns !== undefined) {
    if (typeof frontmatter.maxTurns !== 'number' || !Number.isInteger(frontmatter.maxTurns) || frontmatter.maxTurns < 1) {
      throw new ProfileValidationError('maxTurns must be a positive integer');
    }
  }

  // Validate tools arrays if provided
  if (frontmatter.tools !== undefined && !Array.isArray(frontmatter.tools)) {
    throw new ProfileValidationError('tools must be an array');
  }
  if (frontmatter.disallowedTools !== undefined && !Array.isArray(frontmatter.disallowedTools)) {
    throw new ProfileValidationError('disallowedTools must be an array');
  }

  // Validate effort if provided
  if (frontmatter.effort !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(frontmatter.effort as typeof VALID_EFFORT_LEVELS[number])) {
      throw new ProfileValidationError(
        `invalid effort: '${frontmatter.effort}' (must be ${VALID_EFFORT_LEVELS.join(', ')})`,
      );
    }
  }

  return {
    name: frontmatter.name as string,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : DEFAULTS.description,
    tools: Array.isArray(frontmatter.tools) ? frontmatter.tools as string[] : DEFAULTS.tools,
    disallowedTools: Array.isArray(frontmatter.disallowedTools) ? frontmatter.disallowedTools as string[] : DEFAULTS.disallowedTools,
    model: typeof frontmatter.model === 'string' ? frontmatter.model : DEFAULTS.model,
    permissionMode: VALID_PERMISSION_MODES.includes(frontmatter.permissionMode as typeof VALID_PERMISSION_MODES[number])
      ? frontmatter.permissionMode as AgentProfile['permissionMode']
      : DEFAULTS.permissionMode,
    maxTurns: typeof frontmatter.maxTurns === 'number' ? frontmatter.maxTurns : DEFAULTS.maxTurns,
    effort: VALID_EFFORT_LEVELS.includes(frontmatter.effort as typeof VALID_EFFORT_LEVELS[number])
      ? frontmatter.effort as EffortLevel
      : DEFAULTS.effort,
    body,
  };
}

// ── Loading ──────────────────────────────────────────────────

/**
 * Load a single profile from a file path.
 */
export function loadProfile(filePath: string): AgentProfile {
  const content = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = parseProfileContent(content);
  return validateProfile(frontmatter, body);
}

/**
 * Load all profiles from a directory.
 * Returns a map of profile name → AgentProfile.
 */
export function loadProfiles(dir: string): Map<string, AgentProfile> {
  const profiles = new Map<string, AgentProfile>();

  if (!fs.existsSync(dir)) return profiles;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();

  for (const file of files) {
    try {
      const profile = loadProfile(path.join(dir, file));
      profiles.set(profile.name, profile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[profiles] Skipping ${file}: ${msg}`);
    }
  }

  return profiles;
}
