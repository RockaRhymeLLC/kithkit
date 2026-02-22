/**
 * Identity system — YAML frontmatter + markdown personality for agents.
 *
 * Identity determines how an agent communicates:
 * - Comms agent: full identity (personality, humor, style, body)
 * - Orchestrator: minimal role prompt (structured output, no personality)
 * - Worker: profile body only (no identity at all)
 *
 * Identity files live in templates/identities/ (shipped) and are
 * selected during `kithkit init`. Path configurable in config.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ── Types ────────────────────────────────────────────────────

export interface IdentityFields {
  name: string;
  style: string;
  humor: string;
  voice: string;
  traits?: string[];
  [key: string]: unknown;
}

export interface Identity {
  fields: IdentityFields;
  body: string;
}

export type AgentRole = 'comms' | 'orchestrator' | 'worker';

export class IdentityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityParseError';
  }
}

// ── Parsing ──────────────────────────────────────────────────

/**
 * Parse an identity file (YAML frontmatter + markdown body).
 */
export function parseIdentity(content: string): Identity {
  const trimmed = content.trim();

  if (!trimmed.startsWith('---')) {
    throw new IdentityParseError('Identity file must start with YAML frontmatter (---)');
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    throw new IdentityParseError('Identity file has unclosed frontmatter (missing closing ---)');
  }

  const yamlStr = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  let fields: Record<string, unknown>;
  try {
    fields = (yaml.load(yamlStr) as Record<string, unknown>) ?? {};
  } catch {
    throw new IdentityParseError('Invalid YAML in identity frontmatter');
  }

  if (!fields.name || typeof fields.name !== 'string') {
    throw new IdentityParseError('Identity must have a "name" field');
  }

  return {
    fields: {
      name: fields.name,
      style: typeof fields.style === 'string' ? fields.style : 'default',
      humor: typeof fields.humor === 'string' ? fields.humor : 'none',
      voice: typeof fields.voice === 'string' ? fields.voice : 'neutral',
      traits: Array.isArray(fields.traits) ? fields.traits as string[] : undefined,
      ...fields,
    },
    body,
  };
}

/**
 * Load an identity from a file path.
 */
export function loadIdentity(filePath: string): Identity {
  if (!fs.existsSync(filePath)) {
    throw new IdentityParseError(`Identity file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return parseIdentity(content);
}

/**
 * Load all identity templates from a directory.
 * Returns a map of template name (filename without extension) → Identity.
 */
export function loadIdentityTemplates(dir: string): Map<string, Identity> {
  const templates = new Map<string, Identity>();

  if (!fs.existsSync(dir)) return templates;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep').sort();

  for (const file of files) {
    const name = path.basename(file, '.md');
    const identity = loadIdentity(path.join(dir, file));
    templates.set(name, identity);
  }

  return templates;
}

// ── Role-based prompt generation ────────────────────────────

const ORCHESTRATOR_ROLE_PROMPT = `You are an orchestrator agent. Your role is to decompose complex tasks into subtasks, spawn worker agents, and synthesize their results.

Output structured JSON when reporting results. Do not add personality, humor, or conversational tone. Be precise and efficient.`;

/**
 * Get the appropriate prompt content for an agent based on its role.
 *
 * - comms: full identity (YAML fields summary + markdown body)
 * - orchestrator: static role prompt (no personality)
 * - worker: empty string (workers get their profile body, not identity)
 */
export function getPromptForRole(identity: Identity, role: AgentRole): string {
  switch (role) {
    case 'comms': {
      const lines: string[] = [];
      lines.push(`Your name is ${identity.fields.name}.`);
      if (identity.fields.style !== 'default') {
        lines.push(`Communication style: ${identity.fields.style}.`);
      }
      if (identity.fields.humor !== 'none') {
        lines.push(`Humor: ${identity.fields.humor}.`);
      }
      if (identity.fields.voice !== 'neutral') {
        lines.push(`Voice: ${identity.fields.voice}.`);
      }
      if (identity.fields.traits && identity.fields.traits.length > 0) {
        lines.push(`Key traits: ${identity.fields.traits.join(', ')}.`);
      }
      if (identity.body) {
        lines.push('');
        lines.push(identity.body);
      }
      return lines.join('\n');
    }

    case 'orchestrator':
      return ORCHESTRATOR_ROLE_PROMPT;

    case 'worker':
      return '';
  }
}
