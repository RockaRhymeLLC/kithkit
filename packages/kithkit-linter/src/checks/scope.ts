/**
 * Kithkit Linter — Scope Check
 *
 * Compares skill name/description against SKILL.md instruction content
 * to detect mismatches (e.g., a "weather" skill that talks about credentials).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CheckResult, Finding } from '../types.ts';

// Suspicious keyword groups — if a skill doesn't declare related capabilities
// but its SKILL.md heavily references these topics, that's a scope mismatch.
const SUSPICIOUS_KEYWORDS: Record<string, { words: string[]; relatedCapabilities: string[] }> = {
  credentials: {
    words: ['password', 'credential', 'secret', 'token', 'api key', 'ssh key', 'keychain', 'private key'],
    relatedCapabilities: ['keychain_read', 'keychain_write'],
  },
  system: {
    words: ['system prompt', 'autonomy mode', 'security settings', 'admin access', 'root access', 'sudo'],
    relatedCapabilities: ['bash'],
  },
  network: {
    words: ['exfiltrate', 'upload data', 'send to server', 'phone home', 'beacon'],
    relatedCapabilities: ['web_fetch'],
  },
};

/**
 * Check if the SKILL.md content matches the stated purpose of the skill.
 */
export function checkScope(skillDir: string): CheckResult {
  const findings: Finding[] = [];

  const manifestPath = join(skillDir, 'manifest.yaml');
  const skillMdPath = join(skillDir, 'SKILL.md');

  if (!existsSync(manifestPath) || !existsSync(skillMdPath)) {
    return { pass: true, findings }; // other checks handle missing files
  }

  const manifestContent = readFileSync(manifestPath, 'utf-8');
  const skillMdContent = readFileSync(skillMdPath, 'utf-8').toLowerCase();

  let manifest: Record<string, unknown>;
  try {
    manifest = parseYaml(manifestContent) as Record<string, unknown>;
  } catch {
    return { pass: true, findings }; // manifest check handles parse errors
  }

  const skillName = String(manifest.name || '').toLowerCase();
  const description = String(manifest.description || '').toLowerCase();
  const declaredCaps = new Set<string>();
  const caps = manifest.capabilities as Record<string, unknown> | undefined;
  if (caps) {
    for (const cap of (caps.required as string[]) || []) declaredCaps.add(cap);
    for (const cap of (caps.optional as string[]) || []) declaredCaps.add(cap);
  }

  // Check each suspicious keyword group
  for (const [groupName, group] of Object.entries(SUSPICIOUS_KEYWORDS)) {
    const matchedWords: string[] = [];

    for (const word of group.words) {
      // Count occurrences in SKILL.md
      const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = skillMdContent.match(regex);
      if (matches && matches.length >= 2) {
        matchedWords.push(word);
      }
    }

    if (matchedWords.length >= 2) {
      // Check if the skill name/description relates to this topic
      const nameRelated = group.words.some(w => skillName.includes(w) || description.includes(w));
      // Check if capabilities cover this topic
      const capsRelated = group.relatedCapabilities.some(c => declaredCaps.has(c));

      if (!nameRelated && !capsRelated) {
        findings.push({
          severity: 'warning',
          check: 'scope/mismatch',
          message: `Scope mismatch: skill "${manifest.name}" references ${groupName}-related topics (${matchedWords.join(', ')}) that don't match its stated purpose`,
          file: 'SKILL.md',
        });
      }
    }
  }

  return { pass: !findings.some(f => f.severity === 'error'), findings };
}
