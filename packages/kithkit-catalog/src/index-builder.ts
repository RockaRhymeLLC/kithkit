/**
 * Index Builder — constructs and signs the catalog index from skill archives.
 *
 * The index is deterministically generated:
 * - Skills array sorted by name
 * - Canonical JSON serialization (sorted keys, no whitespace variation)
 * - Same archives always produce same index bytes (excluding signature + timestamp)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { hashArchive, extractManifestFromArchive } from './archive.ts';
import { signData, verifyData } from './signing-bridge.ts';
import type { CatalogIndex, SignedCatalogIndex, SkillEntry, SkillVersion } from './types.ts';

// Re-implement canonical JSON here to avoid cross-package dependency at runtime
// (kithkit-sign is a dev/CI peer, not a runtime dependency)
function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

export interface BuildIndexOptions {
  archivesDir: string;
  privateKeyBase64: string;
  timestamp?: string;      // override timestamp for deterministic tests
  existingIndex?: CatalogIndex;  // for incremental updates
}

/**
 * Scan archives directory and build skill entries.
 * Directory structure: archives/{skill-name}/{skill-name}-{version}.tar.gz
 */
async function scanArchives(archivesDir: string, privateKeyBase64: string, fixedTimestamp?: string): Promise<SkillEntry[]> {

  let skillDirs: string[];
  try {
    skillDirs = await readdir(archivesDir);
  } catch {
    return [];
  }

  const entries: SkillEntry[] = [];

  for (const skillName of skillDirs.sort()) {
    const skillPath = join(archivesDir, skillName);
    const stats = await stat(skillPath);
    if (!stats.isDirectory()) continue;

    const archiveFiles = (await readdir(skillPath))
      .filter(f => f.endsWith('.tar.gz'))
      .sort();

    if (archiveFiles.length === 0) continue;

    const versions: Record<string, SkillVersion> = {};
    let manifest: Record<string, unknown> | null = null;
    let latestVersion = '0.0.0';

    for (const archiveFile of archiveFiles) {
      const archivePath = join(skillPath, archiveFile);
      const { sha256, size } = await hashArchive(archivePath);

      // Extract manifest from archive to get metadata
      const archiveManifest = await extractManifestFromArchive(archivePath);
      const version = archiveManifest.version as string;

      // Sign the archive hash
      const hashBuffer = Buffer.from(sha256, 'hex');
      const signature = signData(hashBuffer, privateKeyBase64);

      versions[version] = {
        version,
        archive: `archives/${skillName}/${archiveFile}`,
        sha256,
        signature,
        size,
        published: fixedTimestamp ?? (await stat(archivePath)).mtime.toISOString(),
      };

      // Track latest version (simple string comparison — semver is fine for sorted archives)
      if (version > latestVersion) {
        latestVersion = version;
        manifest = archiveManifest;
      }
    }

    if (!manifest) continue;

    const author = manifest.author as { name: string; github: string };
    const capabilities = manifest.capabilities as { required: string[]; optional?: string[] };

    entries.push({
      name: skillName,
      description: manifest.description as string,
      author: { name: author.name, github: author.github },
      capabilities: {
        required: [...capabilities.required].sort(),
        ...(capabilities.optional ? { optional: [...capabilities.optional].sort() } : {}),
      },
      tags: ((manifest.tags as string[]) ?? []).sort(),
      category: (manifest.category as string) ?? 'uncategorized',
      trust_level: (manifest.trust_level as SkillEntry['trust_level']) ?? 'community',
      latest: latestVersion,
      versions,
    });
  }

  // Sort skills by name for determinism
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a complete catalog index from archives directory.
 */
export async function buildIndex(options: BuildIndexOptions): Promise<SignedCatalogIndex> {
  const skills = await scanArchives(options.archivesDir, options.privateKeyBase64, options.timestamp);
  const timestamp = options.timestamp ?? new Date().toISOString();

  const index: CatalogIndex = {
    version: 1,
    updated: timestamp,
    skills,
  };

  // Sign the canonical representation
  const canonical = canonicalJson(index);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, options.privateKeyBase64);

  return {
    ...index,
    signature,
  };
}

/**
 * Add or update a single skill in an existing index.
 */
export async function updateIndex(
  existingIndex: SignedCatalogIndex,
  archivePath: string,
  privateKeyBase64: string,
  timestamp?: string,
): Promise<SignedCatalogIndex> {
  const manifest = await extractManifestFromArchive(archivePath);
  const { sha256, size } = await hashArchive(archivePath);
  const version = manifest.version as string;
  const name = manifest.name as string;

  // Sign archive hash
  const hashBuffer = Buffer.from(sha256, 'hex');
  const archiveSig = signData(hashBuffer, privateKeyBase64);

  const archiveBasename = `${name}-${version}.tar.gz`;
  const newVersion: SkillVersion = {
    version,
    archive: `archives/${name}/${archiveBasename}`,
    sha256,
    signature: archiveSig,
    size,
    published: timestamp ?? new Date().toISOString(),
  };

  // Clone skills array
  const skills = [...existingIndex.skills];
  const existingIdx = skills.findIndex(s => s.name === name);

  if (existingIdx >= 0) {
    // Update existing skill
    const existing = { ...skills[existingIdx] };
    existing.versions = { ...existing.versions, [version]: newVersion };
    existing.latest = version;
    existing.description = manifest.description as string;
    const author = manifest.author as { name: string; github: string };
    existing.author = { name: author.name, github: author.github };
    const capabilities = manifest.capabilities as { required: string[]; optional?: string[] };
    existing.capabilities = {
      required: [...capabilities.required].sort(),
      ...(capabilities.optional ? { optional: [...capabilities.optional].sort() } : {}),
    };
    existing.tags = ((manifest.tags as string[]) ?? []).sort();
    existing.category = (manifest.category as string) ?? existing.category;
    existing.trust_level = (manifest.trust_level as SkillEntry['trust_level']) ?? existing.trust_level;
    skills[existingIdx] = existing;
  } else {
    // Add new skill
    const author = manifest.author as { name: string; github: string };
    const capabilities = manifest.capabilities as { required: string[]; optional?: string[] };
    skills.push({
      name,
      description: manifest.description as string,
      author: { name: author.name, github: author.github },
      capabilities: {
        required: [...capabilities.required].sort(),
        ...(capabilities.optional ? { optional: [...capabilities.optional].sort() } : {}),
      },
      tags: ((manifest.tags as string[]) ?? []).sort(),
      category: (manifest.category as string) ?? 'uncategorized',
      trust_level: (manifest.trust_level as SkillEntry['trust_level']) ?? 'community',
      latest: version,
      versions: { [version]: newVersion },
    });
  }

  // Sort for determinism
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const ts = timestamp ?? new Date().toISOString();
  const index: CatalogIndex = {
    version: 1,
    updated: ts,
    skills,
  };

  const canonical = canonicalJson(index);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, privateKeyBase64);

  return { ...index, signature };
}

/**
 * Verify a signed index against a public key.
 */
export function verifySignedIndex(signedIndex: SignedCatalogIndex, publicKeyBase64: string): boolean {
  const { signature, ...index } = signedIndex;
  const canonical = canonicalJson(index);
  const data = Buffer.from(canonical, 'utf8');
  return verifyData(data, signature, publicKeyBase64);
}

/**
 * Serialize a signed index to deterministic JSON bytes.
 */
export function serializeIndex(signedIndex: SignedCatalogIndex): string {
  return canonicalJson(signedIndex);
}

// Export for testing
export { canonicalJson };
