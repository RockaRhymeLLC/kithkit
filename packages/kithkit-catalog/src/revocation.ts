/**
 * Revocation — create, verify, and check signed revocation lists.
 *
 * The revocation list is a signed list of skill versions that have been
 * revoked due to security issues, malicious behavior, or other concerns.
 * Clients must check this list before installing or using skills.
 */

import { signData, verifyData } from './signing-bridge.ts';
import { canonicalJson } from './index-builder.ts';
import type { RevocationEntry, SignedRevocationList } from './types.ts';

/**
 * Create a signed revocation list from an array of entries.
 *
 * Entries are sorted by (name, version) for determinism before signing.
 */
export function createRevocationList(
  entries: RevocationEntry[],
  privateKey: string,
): SignedRevocationList {
  // Sort entries deterministically: by name, then by version
  const sorted = [...entries].sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.version.localeCompare(b.version);
  });

  // canonicalJson does deep sort of object keys — sign sorted entries
  const canonical = canonicalJson(sorted);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, privateKey);

  return { entries: sorted, signature };
}

/**
 * Verify the signature on a signed revocation list.
 *
 * Returns true if the signature is valid for the entries with the given public key.
 */
export function verifyRevocationList(
  list: SignedRevocationList,
  publicKey: string,
): boolean {
  const canonical = canonicalJson(list.entries);
  const data = Buffer.from(canonical, 'utf8');
  return verifyData(data, list.signature, publicKey);
}

/**
 * Check whether a specific skill version is revoked.
 *
 * Matching is exact: both name and version must match.
 */
export function isRevoked(
  list: SignedRevocationList,
  skillName: string,
  version: string,
): { revoked: boolean; entry?: RevocationEntry } {
  const entry = list.entries.find(
    e => e.name === skillName && e.version === version,
  );
  if (entry) {
    return { revoked: true, entry };
  }
  return { revoked: false };
}

/**
 * Check installed skills against a revocation list.
 *
 * Returns only the skills that are revoked — does NOT remove them.
 * Callers are responsible for any remediation actions.
 */
export function checkInstalledRevocations(
  list: SignedRevocationList,
  installedSkills: Array<{ name: string; version: string }>,
): Array<{ skill: { name: string; version: string }; entry: RevocationEntry }> {
  const results: Array<{ skill: { name: string; version: string }; entry: RevocationEntry }> = [];

  for (const skill of installedSkills) {
    const { revoked, entry } = isRevoked(list, skill.name, skill.version);
    if (revoked && entry) {
      results.push({ skill: { name: skill.name, version: skill.version }, entry });
    }
  }

  return results;
}
