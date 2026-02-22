/**
 * Skill Installer — download, verify, extract, and record installed skills.
 *
 * verifyArchiveIntegrity  — SHA-256 hash check + Ed25519 signature verification
 * extractArchive          — gzip/tar extraction with path-traversal prevention
 * writeMetadata           — persist .kithkit metadata file after install
 * readMetadata            — read existing .kithkit metadata for a skill
 * installSkill            — full install orchestrator
 * verifyRevocationList    — local Ed25519 verify on a signed revocation list
 * isRevoked               — exact name+version match check
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type {
  SignedCatalogIndex,
  KithkitMetadata,
  RevocationEntry,
  SignedRevocationList,
  InstallResult,
} from './types.ts';

const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------
// Canonical JSON (same algorithm used everywhere in the signing pipeline)
// ---------------------------------------------------------------------------

function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

// ---------------------------------------------------------------------------
// verifyArchiveIntegrity
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  valid: true;
}
export interface IntegrityFailure {
  valid: false;
  error: string;
}
export type ArchiveIntegrityResult = IntegrityResult | IntegrityFailure;

/**
 * Verify a downloaded archive against an expected SHA-256 hash and Ed25519 signature.
 *
 * The signature covers the raw hash bytes (hex-decoded), matching the signing
 * convention used by the catalog index-builder.
 *
 * Returns { valid: true } or { valid: false, error }.
 */
export function verifyArchiveIntegrity(
  archiveData: Buffer,
  expectedSha256: string,
  expectedSignature: string,
  publicKeyBase64: string,
): ArchiveIntegrityResult {
  try {
    // 1. Compute actual hash
    const actualHash = createHash('sha256').update(archiveData).digest('hex');
    if (actualHash !== expectedSha256) {
      return {
        valid: false,
        error: `Archive hash mismatch — expected ${expectedSha256}, got ${actualHash}`,
      };
    }

    // 2. Verify Ed25519 signature of hash bytes
    const hashBytes = Buffer.from(actualHash, 'hex');
    const signatureBytes = Buffer.from(expectedSignature, 'base64');

    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const ok = cryptoVerify(null, hashBytes, keyObject, signatureBytes);
    if (!ok) {
      return {
        valid: false,
        error: 'Archive signature verification failed — archive may have been tampered with',
      };
    }

    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Integrity verification error: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// extractArchive
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

/**
 * Decompress a gzipped tar archive and extract all files to targetDir.
 *
 * Security: path traversal is prevented by:
 *   - Rejecting entries that contain '..' components
 *   - Rejecting absolute paths
 *   - Stripping the first path component (e.g. skill-name/file.md → file.md)
 *   - Verifying every output path resolves within targetDir
 *
 * Returns the list of extracted file paths (absolute).
 */
export async function extractArchive(archiveData: Buffer, targetDir: string): Promise<string[]> {
  // Decompress
  const tarBuffer = await gunzipAsync(archiveData);

  // Ensure target directory exists
  await mkdir(targetDir, { recursive: true });

  const extractedPaths: string[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);

    // End-of-archive: two consecutive zero blocks
    if (header.every(b => b === 0)) break;

    // Parse header fields
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0+$/, '').trim();
    const typeFlag = header.subarray(156, 157).toString('utf8').replace(/\0+$/, '');
    const fileSize = parseInt(sizeStr || '0', 8);

    offset += TAR_BLOCK_SIZE;

    // Only extract regular files (type '0' or '' — older tars use empty)
    if (typeFlag !== '0' && typeFlag !== '' && typeFlag !== '\0') {
      // Directory or link entry — skip data blocks
      if (fileSize > 0) {
        const blocks = Math.ceil(fileSize / TAR_BLOCK_SIZE);
        offset += blocks * TAR_BLOCK_SIZE;
      }
      continue;
    }

    if (rawName === '') {
      if (fileSize > 0) {
        const blocks = Math.ceil(fileSize / TAR_BLOCK_SIZE);
        offset += blocks * TAR_BLOCK_SIZE;
      }
      continue;
    }

    // --- Path traversal prevention ---
    // Reject absolute paths
    if (rawName.startsWith('/')) {
      throw new Error(`Path traversal detected: absolute path in archive: ${rawName}`);
    }
    // Reject any component that is '..'
    const parts = rawName.split('/');
    if (parts.some(p => p === '..')) {
      throw new Error(`Path traversal detected: '..' component in archive entry: ${rawName}`);
    }

    // Strip the first component (the skill-name prefix, e.g. weather-check/SKILL.md → SKILL.md)
    const fileParts = parts.length > 1 ? parts.slice(1) : parts;
    const relPath = fileParts.join('/');

    if (!relPath || relPath === '') {
      // Was just the top-level directory entry — skip
      if (fileSize > 0) {
        const blocks = Math.ceil(fileSize / TAR_BLOCK_SIZE);
        offset += blocks * TAR_BLOCK_SIZE;
      }
      continue;
    }

    // Verify the resolved output path is inside targetDir
    const outPath = resolve(targetDir, relPath);
    const resolvedTarget = resolve(targetDir);
    if (!outPath.startsWith(resolvedTarget + '/') && outPath !== resolvedTarget) {
      throw new Error(`Path traversal detected: resolved path escapes target directory: ${rawName}`);
    }

    // Extract file content
    const fileContent = tarBuffer.subarray(offset, offset + fileSize);

    // Ensure parent directory exists
    const parentDir = join(outPath, '..');
    await mkdir(parentDir, { recursive: true });

    await writeFile(outPath, fileContent);
    extractedPaths.push(outPath);

    // Advance to next block boundary
    const blocks = Math.ceil(fileSize / TAR_BLOCK_SIZE);
    offset += blocks * TAR_BLOCK_SIZE;
  }

  return extractedPaths;
}

// ---------------------------------------------------------------------------
// writeMetadata / readMetadata
// ---------------------------------------------------------------------------

const METADATA_FILENAME = '.kithkit';

/**
 * Write the .kithkit metadata file to the skill's install directory.
 */
export async function writeMetadata(installDir: string, metadata: KithkitMetadata): Promise<void> {
  const metaPath = join(installDir, METADATA_FILENAME);
  await writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
}

/**
 * Read and parse the .kithkit metadata file from a skill's install directory.
 * Returns null if the file does not exist or cannot be parsed.
 */
export async function readMetadata(installDir: string): Promise<KithkitMetadata | null> {
  const metaPath = join(installDir, METADATA_FILENAME);
  try {
    const raw = await readFile(metaPath, 'utf8');
    return JSON.parse(raw) as KithkitMetadata;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// verifyRevocationList (local implementation — no cross-package import)
// ---------------------------------------------------------------------------

/**
 * Verify the Ed25519 signature on a signed revocation list.
 *
 * Signs the canonical JSON of the entries array (same as catalog's revocation.ts).
 * Returns true if valid, false otherwise.
 */
export function verifyRevocationList(
  list: SignedRevocationList,
  publicKeyBase64: string,
): boolean {
  try {
    const canonical = canonicalJson(list.entries);
    const data = Buffer.from(canonical, 'utf8');
    const signatureBytes = Buffer.from(list.signature, 'base64');

    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    return cryptoVerify(null, data, keyObject, signatureBytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// isRevoked (local implementation)
// ---------------------------------------------------------------------------

/**
 * Check whether a specific skill version appears in the revocation list.
 *
 * Matching is exact: both name and version must match.
 */
export function isRevoked(
  list: SignedRevocationList,
  name: string,
  version: string,
): { revoked: boolean; entry?: RevocationEntry } {
  const entry = list.entries.find(e => e.name === name && e.version === version);
  if (entry) return { revoked: true, entry };
  return { revoked: false };
}

// ---------------------------------------------------------------------------
// installSkill — main orchestrator
// ---------------------------------------------------------------------------

export interface InstallOptions {
  skillName: string;
  version?: string;                                      // defaults to latest
  index: SignedCatalogIndex;
  publicKeyBase64: string;
  fetchArchive: (url: string) => Promise<Buffer>;        // injectable for testing
  skillsDir: string;                                     // e.g. .claude/skills/
  revocationList?: SignedRevocationList;
  source?: string;                                       // catalog URL for metadata
}

/**
 * Install a skill from the catalog.
 *
 * Steps:
 *   1. Find skill in index by name
 *   2. Resolve version (latest if not specified)
 *   3. Check revocation list if provided
 *   4. Fetch archive via fetchArchive callback
 *   5. Verify archive integrity (hash + signature)
 *   6. Check if same version is already installed
 *   7. Extract archive to {skillsDir}/{skillName}/
 *   8. Write .kithkit metadata
 *   9. Return InstallResult
 */
export async function installSkill(options: InstallOptions): Promise<InstallResult> {
  const {
    skillName,
    index,
    publicKeyBase64,
    fetchArchive,
    skillsDir,
    revocationList,
    source,
  } = options;

  const installDir = join(skillsDir, skillName);

  // 1. Find skill in index
  const skillEntry = index.skills.find(s => s.name === skillName);
  if (!skillEntry) {
    return {
      success: false,
      skillName,
      version: options.version ?? '',
      installDir,
      error: `Skill '${skillName}' not found in catalog index`,
    };
  }

  // 2. Resolve version
  const targetVersion = options.version ?? skillEntry.latest;
  const versionEntry = skillEntry.versions[targetVersion];
  if (!versionEntry) {
    return {
      success: false,
      skillName,
      version: targetVersion,
      installDir,
      error: `Version '${targetVersion}' not found for skill '${skillName}'`,
    };
  }

  // 3. Check revocation list
  if (revocationList) {
    const { revoked, entry } = isRevoked(revocationList, skillName, targetVersion);
    if (revoked && entry) {
      return {
        success: false,
        skillName,
        version: targetVersion,
        installDir,
        error: `Skill '${skillName}' v${targetVersion} is revoked: ${entry.reason} (severity: ${entry.severity})`,
      };
    }
  }

  // 4. Fetch archive
  let archiveData: Buffer;
  try {
    archiveData = await fetchArchive(versionEntry.archive);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      skillName,
      version: targetVersion,
      installDir,
      error: `Failed to fetch archive: ${message}`,
    };
  }

  // 5. Verify archive integrity
  const integrityResult = verifyArchiveIntegrity(
    archiveData,
    versionEntry.sha256,
    versionEntry.signature,
    publicKeyBase64,
  );
  if (!integrityResult.valid) {
    return {
      success: false,
      skillName,
      version: targetVersion,
      installDir,
      error: integrityResult.error,
    };
  }

  // 6. Check if same version already installed
  const existing = await readMetadata(installDir);
  if (existing && existing.version === targetVersion) {
    return {
      success: false,
      skillName,
      version: targetVersion,
      installDir,
      error: `Skill '${skillName}' v${targetVersion} is already installed`,
    };
  }

  // 7. Extract archive
  try {
    await extractArchive(archiveData, installDir);
  } catch (err) {
    // Clean up partial extraction on failure
    try {
      await rm(installDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      skillName,
      version: targetVersion,
      installDir,
      error: `Failed to extract archive: ${message}`,
    };
  }

  // 8. Write metadata
  const metadata: KithkitMetadata = {
    name: skillName,
    version: targetVersion,
    source: source ?? versionEntry.archive,
    sha256: versionEntry.sha256,
    signature: versionEntry.signature,
    installed_at: new Date().toISOString(),
    trust_level: skillEntry.trust_level,
  };
  await writeMetadata(installDir, metadata);

  // 9. Return success
  return {
    success: true,
    skillName,
    version: targetVersion,
    installDir,
  };
}
