/**
 * Config Generator — creates and merges config.yaml from manifest schema.
 *
 * On install: generates config.yaml with defaults pre-filled, required fields
 * marked with TODO comments, credential fields prompt for secure storage.
 *
 * On upgrade: merges new schema into existing config, preserving all existing
 * values and only prompting for new required fields.
 *
 * Config is LOCAL ONLY — never included in uploads or distribution.
 */

import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

export interface ConfigField {
  key: string;
  type: 'credential' | 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  default?: string | number | boolean;
  description: string;
  enum_values?: string[];
}

export interface GeneratedConfig {
  yaml: string;
  fields: Record<string, ConfigFieldInfo>;
}

export interface ConfigFieldInfo {
  key: string;
  type: string;
  value: string | number | boolean | null;
  needsSetup: boolean;
  isCredential: boolean;
  description: string;
  storageHint?: string;
}

export interface ConfigMergeResult {
  yaml: string;
  newFields: ConfigFieldInfo[];
  preservedFields: string[];
  allFields: Record<string, ConfigFieldInfo>;
}

/**
 * Generate a config.yaml from manifest config schema.
 */
export function generateConfig(configSchema: ConfigField[], skillName: string): GeneratedConfig {
  const fields: Record<string, ConfigFieldInfo> = {};
  const configObj: Record<string, string | number | boolean> = {};

  // Header comments
  const lines: string[] = [
    `# Config for ${skillName}`,
    '# This file is LOCAL ONLY — never shared or uploaded.',
    '#',
  ];

  for (const field of configSchema) {
    const isCredential = field.type === 'credential';
    const hasDefault = field.default !== undefined;
    const needsSetup = field.required && !hasDefault;

    let value: string | number | boolean | null;
    let storageHint: string | undefined;

    if (isCredential) {
      value = null;
      storageHint = `Store in Keychain (macOS): credential-${skillName}-${field.key}`;
      lines.push(`# ${field.key}: ${field.description}`);
      lines.push(`#   Type: credential (store securely)`);
      lines.push(`#   ${storageHint}`);
      if (field.required) {
        lines.push(`#   REQUIRED — TODO: Store this credential securely`);
      }
      lines.push(`${field.key}: "" # TODO: Set up credential`);
    } else if (needsSetup) {
      value = null;
      lines.push(`# ${field.key}: ${field.description}`);
      if (field.type === 'enum' && field.enum_values) {
        lines.push(`#   Options: ${field.enum_values.join(', ')}`);
      }
      lines.push(`#   REQUIRED`);
      lines.push(`${field.key}: "" # TODO: Set value`);
    } else {
      value = hasDefault ? field.default! : getTypeDefault(field.type);
      lines.push(`# ${field.key}: ${field.description}`);
      if (field.type === 'enum' && field.enum_values) {
        lines.push(`#   Options: ${field.enum_values.join(', ')}`);
      }
      lines.push(`${field.key}: ${formatYamlValue(value)}`);
    }

    lines.push('');

    fields[field.key] = {
      key: field.key,
      type: field.type,
      value,
      needsSetup: needsSetup || isCredential,
      isCredential,
      description: field.description,
      storageHint,
    };
  }

  return {
    yaml: lines.join('\n'),
    fields,
  };
}

/**
 * Merge new config schema into existing config.yaml, preserving existing values.
 * Returns the merged config and a list of new fields that need setup.
 */
export function mergeConfig(
  existingYaml: string,
  newSchema: ConfigField[],
  skillName: string,
): ConfigMergeResult {
  const existing = yamlParse(existingYaml) as Record<string, unknown> ?? {};
  const newFields: ConfigFieldInfo[] = [];
  const preservedFields: string[] = [];
  const allFields: Record<string, ConfigFieldInfo> = {};

  const lines: string[] = [
    `# Config for ${skillName}`,
    '# This file is LOCAL ONLY — never shared or uploaded.',
    '#',
  ];

  for (const field of newSchema) {
    const isCredential = field.type === 'credential';
    const existingValue = existing[field.key];
    const hasExisting = field.key in existing && existingValue !== '' && existingValue !== null;

    if (hasExisting) {
      // Preserve existing value
      preservedFields.push(field.key);
      lines.push(`# ${field.key}: ${field.description}`);
      if (field.type === 'enum' && field.enum_values) {
        lines.push(`#   Options: ${field.enum_values.join(', ')}`);
      }
      lines.push(`${field.key}: ${formatYamlValue(existingValue as string | number | boolean)}`);
      lines.push('');

      allFields[field.key] = {
        key: field.key,
        type: field.type,
        value: existingValue as string | number | boolean,
        needsSetup: false,
        isCredential,
        description: field.description,
      };
    } else {
      // New field — generate with TODO if required
      const hasDefault = field.default !== undefined;
      const needsSetup = (field.required && !hasDefault) || isCredential;
      let value: string | number | boolean | null;
      let storageHint: string | undefined;

      if (isCredential) {
        value = null;
        storageHint = `Store in Keychain (macOS): credential-${skillName}-${field.key}`;
        lines.push(`# ${field.key}: ${field.description}`);
        lines.push(`#   Type: credential (store securely)`);
        lines.push(`#   ${storageHint}`);
        if (field.required) {
          lines.push(`#   REQUIRED — TODO: Store this credential securely`);
        }
        lines.push(`${field.key}: "" # TODO: Set up credential`);
      } else if (field.required && !hasDefault) {
        value = null;
        lines.push(`# ${field.key}: ${field.description}`);
        if (field.type === 'enum' && field.enum_values) {
          lines.push(`#   Options: ${field.enum_values.join(', ')}`);
        }
        lines.push(`#   REQUIRED`);
        lines.push(`${field.key}: "" # TODO: Set value`);
      } else {
        value = hasDefault ? field.default! : getTypeDefault(field.type);
        lines.push(`# ${field.key}: ${field.description}`);
        if (field.type === 'enum' && field.enum_values) {
          lines.push(`#   Options: ${field.enum_values.join(', ')}`);
        }
        lines.push(`${field.key}: ${formatYamlValue(value)}`);
      }

      lines.push('');

      const info: ConfigFieldInfo = {
        key: field.key,
        type: field.type,
        value,
        needsSetup,
        isCredential,
        description: field.description,
        storageHint,
      };

      allFields[field.key] = info;
      if (needsSetup) {
        newFields.push(info);
      }
    }
  }

  return {
    yaml: lines.join('\n'),
    newFields,
    preservedFields,
    allFields,
  };
}

function getTypeDefault(type: string): string | number | boolean {
  switch (type) {
    case 'string': return '';
    case 'number': return 0;
    case 'boolean': return false;
    case 'enum': return '';
    default: return '';
  }
}

function formatYamlValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    if (value === '') return '""';
    if (value.includes(':') || value.includes('#') || value.includes("'") || value.includes('"')) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}
