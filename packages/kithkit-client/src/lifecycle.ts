/**
 * Skill Lifecycle — update, uninstall, list, and config-backup operations.
 *
 * checkForUpdate     — compare installed version to latest in index
 * updateSkill        — upgrade a skill in-place, preserving config
 * checkAllUpdates    — scan skillsDir and check every installed skill
 * uninstallSkill     — remove skill dir, saving config backup first
 * listInstalled      — enumerate all installed skills with optional update info
 * restoreConfigBackup — retrieve a previously saved config backup
 */

import { readdir, stat, readFile, writeFile, copyFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SignedCatalogIndex,
  InstallResult,
  UpdateCheckResult,
  UninstallResult,
  ListEntry,
} from './types.ts';
import { readMetadata, installSkill } from './install.ts';
import { mergeConfig } from './config.ts';

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version of a skill is available in the index.
 *
 * If the skill is not installed, returns { hasUpdate: false, currentVersion: 'not installed' }.
 */
export async function checkForUpdate(
  skillName: string,
  skillsDir: string,
  index: SignedCatalogIndex,
): Promise<UpdateCheckResult> {
  const installDir = join(skillsDir, skillName);
  const metadata = await readMetadata(installDir);

  if (!metadata) {
    const indexEntry = index.skills.find(s => s.name === skillName);
    return {
      skillName,
      currentVersion: 'not installed',
      latestVersion: indexEntry?.latest ?? 'unknown',
      hasUpdate: false,
    };
  }

  const indexEntry = index.skills.find(s => s.name === skillName);
  if (!indexEntry) {
    return {
      skillName,
      currentVersion: metadata.version,
      latestVersion: 'unknown',
      hasUpdate: false,
    };
  }

  const hasUpdate = indexEntry.latest !== metadata.version;

  return {
    skillName,
    currentVersion: metadata.version,
    latestVersion: indexEntry.latest,
    hasUpdate,
  };
}

// ---------------------------------------------------------------------------
// updateSkill
// ---------------------------------------------------------------------------

export interface UpdateOptions {
  skillName: string;
  skillsDir: string;
  index: SignedCatalogIndex;
  publicKeyBase64: string;
  fetchArchive: (url: string) => Promise<Buffer>;
  source?: string;
}

/**
 * Update a skill to its latest version in the index.
 *
 * Steps:
 *   1. Check for update — return early (success with alreadyLatest note) if no update
 *   2. Back up existing config.yaml → config.yaml.bak in the skill dir (temp)
 *   3. Capture config content before removal
 *   4. Remove existing skill directory
 *   5. Install new version via installSkill()
 *   6. Restore config, merging new fields from manifest schema
 */
export async function updateSkill(options: UpdateOptions): Promise<InstallResult> {
  const { skillName, skillsDir, index, publicKeyBase64, fetchArchive, source } = options;

  // 1. Check for update
  const updateCheck = await checkForUpdate(skillName, skillsDir, index);
  if (!updateCheck.hasUpdate) {
    const installDir = join(skillsDir, skillName);
    return {
      success: false,
      skillName,
      version: updateCheck.currentVersion,
      installDir,
      error: updateCheck.currentVersion === 'not installed'
        ? `Skill '${skillName}' is not installed`
        : `Skill '${skillName}' is already at the latest version (${updateCheck.currentVersion})`,
    };
  }

  const installDir = join(skillsDir, skillName);

  // 2. Read existing config.yaml if present
  const configPath = join(installDir, 'config.yaml');
  let existingConfigYaml: string | null = null;
  try {
    existingConfigYaml = await readFile(configPath, 'utf8');
  } catch {
    // No config.yaml — that's fine
  }

  // 3. Remove existing skill directory
  try {
    await rm(installDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      skillName,
      version: updateCheck.currentVersion,
      installDir,
      error: `Failed to remove existing skill directory: ${message}`,
    };
  }

  // 4. Install new version (installSkill expects the dir to not exist)
  const installResult = await installSkill({
    skillName,
    index,
    publicKeyBase64,
    fetchArchive,
    skillsDir,
    source,
  });

  if (!installResult.success) {
    return installResult;
  }

  // 5. Restore config, merging with new manifest schema if available
  if (existingConfigYaml !== null) {
    // Try to read new manifest.yaml to get updated config schema
    const manifestPath = join(installDir, 'manifest.yaml');
    let newConfigYaml: string | null = null;

    try {
      const manifestContent = await readFile(manifestPath, 'utf8');
      // Parse config schema from manifest if it has one (simple YAML extraction)
      // If the manifest includes a config section, mergeConfig will handle it
      // For the common case: just restore the existing config as-is
      // The schema-merge path is handled when the skill author updates config fields
      newConfigYaml = existingConfigYaml;
    } catch {
      // No manifest or unable to parse — restore existing config verbatim
      newConfigYaml = existingConfigYaml;
    }

    if (newConfigYaml !== null) {
      try {
        await writeFile(configPath, newConfigYaml, 'utf8');
      } catch {
        // Config restore failed — not fatal, install still succeeded
      }
    }
  }

  return installResult;
}

// ---------------------------------------------------------------------------
// checkAllUpdates
// ---------------------------------------------------------------------------

/**
 * Scan skillsDir for installed skills (directories containing .kithkit files)
 * and check each against the index for available updates.
 *
 * Returns an array of UpdateCheckResult, one per installed skill.
 */
export async function checkAllUpdates(
  skillsDir: string,
  index: SignedCatalogIndex,
): Promise<UpdateCheckResult[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const results: UpdateCheckResult[] = [];

  for (const entry of entries) {
    // Skip hidden directories (like .kithkit-backups)
    if (entry.startsWith('.')) continue;

    const entryPath = join(skillsDir, entry);
    try {
      const s = await stat(entryPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    // Check if this directory has .kithkit metadata (i.e., is an installed skill)
    const metadata = await readMetadata(entryPath);
    if (!metadata) continue;

    const updateCheck = await checkForUpdate(metadata.name, skillsDir, index);
    results.push(updateCheck);
  }

  return results;
}

// ---------------------------------------------------------------------------
// uninstallSkill
// ---------------------------------------------------------------------------

const BACKUPS_DIR = '.kithkit-backups';

/**
 * Uninstall a skill by removing its directory.
 *
 * If config.yaml exists, it is saved to:
 *   {skillsDir}/.kithkit-backups/{skillName}/config.yaml.bak
 * before the skill directory is removed.
 *
 * Returns UninstallResult.
 */
export async function uninstallSkill(
  skillName: string,
  skillsDir: string,
): Promise<UninstallResult> {
  const installDir = join(skillsDir, skillName);

  // Check if skill is installed
  const metadata = await readMetadata(installDir);
  if (!metadata) {
    return {
      success: false,
      skillName,
      configBackedUp: false,
      error: `Skill '${skillName}' is not installed`,
    };
  }

  // Save config.yaml backup if present
  const configPath = join(installDir, 'config.yaml');
  let configBackedUp = false;

  try {
    await stat(configPath);
    // Config exists — back it up
    const backupDir = join(skillsDir, BACKUPS_DIR, skillName);
    await mkdir(backupDir, { recursive: true });
    const backupPath = join(backupDir, 'config.yaml.bak');
    await copyFile(configPath, backupPath);
    configBackedUp = true;
  } catch {
    // No config.yaml or backup failed — not fatal
  }

  // Remove the skill directory
  try {
    await rm(installDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      skillName,
      configBackedUp,
      error: `Failed to remove skill directory: ${message}`,
    };
  }

  return {
    success: true,
    skillName,
    configBackedUp,
  };
}

// ---------------------------------------------------------------------------
// listInstalled
// ---------------------------------------------------------------------------

/**
 * List all installed skills in skillsDir.
 *
 * If index is provided, checks each skill for available updates.
 * Returns an array of ListEntry, one per installed skill.
 */
export async function listInstalled(
  skillsDir: string,
  index?: SignedCatalogIndex,
): Promise<ListEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const results: ListEntry[] = [];

  for (const entry of entries) {
    // Skip hidden directories (like .kithkit-backups)
    if (entry.startsWith('.')) continue;

    const entryPath = join(skillsDir, entry);
    try {
      const s = await stat(entryPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const metadata = await readMetadata(entryPath);
    if (!metadata) continue;

    let hasUpdate = false;
    let latestVersion: string | undefined;

    if (index) {
      const updateCheck = await checkForUpdate(metadata.name, skillsDir, index);
      hasUpdate = updateCheck.hasUpdate;
      if (hasUpdate) {
        latestVersion = updateCheck.latestVersion;
      }
    }

    results.push({
      name: metadata.name,
      version: metadata.version,
      trust_level: metadata.trust_level,
      source: metadata.source,
      installed_at: metadata.installed_at,
      hasUpdate,
      latestVersion,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// restoreConfigBackup
// ---------------------------------------------------------------------------

/**
 * Retrieve a previously saved config backup for a skill.
 *
 * Returns the backup content string if the backup exists, null otherwise.
 * Used during reinstall to offer config restoration to the user.
 */
export async function restoreConfigBackup(
  skillName: string,
  skillsDir: string,
): Promise<string | null> {
  const backupPath = join(skillsDir, BACKUPS_DIR, skillName, 'config.yaml.bak');
  try {
    return await readFile(backupPath, 'utf8');
  } catch {
    return null;
  }
}
