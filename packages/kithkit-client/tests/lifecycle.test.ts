/**
 * Catalog Client Lifecycle Tests
 *
 * Tests: t-086 (update detects newer version and upgrades),
 *        t-087 (uninstall removes skill and preserves config backup),
 *        checkAllUpdates with multiple skills,
 *        listInstalled returns correct entries,
 *        uninstall of non-installed skill returns error,
 *        update when already at latest returns early
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateKeyPairSync,
  createPrivateKey,
  sign as cryptoSign,
  createHash,
} from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import {
  installSkill,
  readMetadata,
} from '../src/install.ts';
import {
  checkForUpdate,
  updateSkill,
  checkAllUpdates,
  uninstallSkill,
  listInstalled,
  restoreConfigBackup,
} from '../src/lifecycle.ts';
import type {
  SignedCatalogIndex,
  SkillEntry,
} from '../src/types.ts';

const gzipAsync = promisify(gzip);

// ---------------------------------------------------------------------------
// Test helpers (mirror install.test.ts pattern)
// ---------------------------------------------------------------------------

function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

function signData(data: Buffer, privateKeyBase64: string): string {
  const keyObject = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return cryptoSign(null, data, keyObject).toString('base64');
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

function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

// ---------------------------------------------------------------------------
// Minimal tar + gzip implementation (same as install.test.ts)
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);

  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0001000\0', 108, 8, 'utf8');
  header.write('0001000\0', 116, 8, 'utf8');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  // Compute checksum with field as spaces
  header.write('        ', 148, 8, 'utf8');
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  return header;
}

async function createTestArchive(
  skillName: string,
  files: Record<string, string>,
): Promise<Buffer> {
  const tarParts: Buffer[] = [];

  for (const [filename, content] of Object.entries(files)) {
    const contentBuffer = Buffer.from(content, 'utf8');
    const entryName = `${skillName}/${filename}`;
    const header = createTarHeader(entryName, contentBuffer.length);
    tarParts.push(header);
    tarParts.push(contentBuffer);
    const remainder = contentBuffer.length % TAR_BLOCK_SIZE;
    if (remainder > 0) {
      tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder));
    }
  }

  // End-of-archive
  tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));

  const tarBuffer = Buffer.concat(tarParts);
  return gzipAsync(tarBuffer);
}

/**
 * Build a signed catalog index with multiple version entries for one skill.
 */
function buildSignedIndexMultiVersion(
  skillName: string,
  versions: Record<string, Buffer>,  // version → archive
  latestVersion: string,
  privateKey: string,
  trustLevel: 'first-party' | 'verified' | 'community' = 'verified',
): SignedCatalogIndex {
  const versionEntries: SkillEntry['versions'] = {};

  for (const [version, archiveData] of Object.entries(versions)) {
    const sha256 = createHash('sha256').update(archiveData).digest('hex');
    const hashBytes = Buffer.from(sha256, 'hex');
    const archiveSig = signData(hashBytes, privateKey);

    versionEntries[version] = {
      version,
      archive: `archives/${skillName}/${skillName}-${version}.tar.gz`,
      sha256,
      signature: archiveSig,
      size: archiveData.length,
      published: '2026-02-21T00:00:00.000Z',
    };
  }

  const skill: SkillEntry = {
    name: skillName,
    description: `Test skill: ${skillName}`,
    author: { name: 'Test Author', github: 'testauthor' },
    capabilities: { required: ['bash'] },
    tags: ['testing'],
    category: 'testing',
    trust_level: trustLevel,
    latest: latestVersion,
    versions: versionEntries,
  };

  const indexBody = {
    version: 1,
    updated: '2026-02-21T00:00:00.000Z',
    skills: [skill],
  };

  const canonical = canonicalJson(indexBody);
  const indexSig = signData(Buffer.from(canonical, 'utf8'), privateKey);

  return { ...indexBody, signature: indexSig };
}

/**
 * Build a signed catalog index for a single version (convenience wrapper).
 */
function buildSignedIndex(
  skillName: string,
  version: string,
  archiveData: Buffer,
  privateKey: string,
  trustLevel: 'first-party' | 'verified' | 'community' = 'verified',
): SignedCatalogIndex {
  return buildSignedIndexMultiVersion(
    skillName,
    { [version]: archiveData },
    version,
    privateKey,
    trustLevel,
  );
}

/**
 * Build a signed index with multiple skills (for checkAllUpdates tests).
 */
function buildMultiSkillIndex(
  skills: Array<{
    skillName: string;
    version: string;
    archiveData: Buffer;
    trustLevel?: 'first-party' | 'verified' | 'community';
  }>,
  privateKey: string,
): SignedCatalogIndex {
  const skillEntries: SkillEntry[] = skills.map(({ skillName, version, archiveData, trustLevel }) => {
    const sha256 = createHash('sha256').update(archiveData).digest('hex');
    const hashBytes = Buffer.from(sha256, 'hex');
    const archiveSig = signData(hashBytes, privateKey);

    return {
      name: skillName,
      description: `Test skill: ${skillName}`,
      author: { name: 'Test Author', github: 'testauthor' },
      capabilities: { required: ['bash'] },
      tags: ['testing'],
      category: 'testing',
      trust_level: trustLevel ?? 'community',
      latest: version,
      versions: {
        [version]: {
          version,
          archive: `archives/${skillName}/${skillName}-${version}.tar.gz`,
          sha256,
          signature: archiveSig,
          size: archiveData.length,
          published: '2026-02-21T00:00:00.000Z',
        },
      },
    };
  });

  const indexBody = {
    version: 1,
    updated: '2026-02-21T00:00:00.000Z',
    skills: skillEntries,
  };

  const canonical = canonicalJson(indexBody);
  const indexSig = signData(Buffer.from(canonical, 'utf8'), privateKey);

  return { ...indexBody, signature: indexSig };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let tmpDir: string;
let keys: { publicKey: string; privateKey: string };

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kithkit-lifecycle-test-'));
  keys = generateKeyPair();
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// t-086: Update detects newer version and upgrades
// ---------------------------------------------------------------------------

describe('t-086: Update detects newer version and upgrades', () => {
  let archiveV1: Buffer;
  let archiveV2: Buffer;
  let indexV1: SignedCatalogIndex;
  let indexV2: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 't086-skills');
    await mkdir(skillsDir, { recursive: true });

    archiveV1 = await createTestArchive('task-manager', {
      'SKILL.md': '# Task Manager v1.0.0\nManages your tasks.',
      'manifest.yaml': [
        'name: task-manager',
        'version: 1.0.0',
        'description: Manage tasks efficiently',
        'author:',
        '  name: Test Author',
        '  github: testauthor',
        'capabilities:',
        '  required: [bash]',
        'tags: [tasks, productivity]',
        'category: productivity',
        'trust_level: verified',
      ].join('\n'),
    });

    archiveV2 = await createTestArchive('task-manager', {
      'SKILL.md': '# Task Manager v1.1.0\nManages your tasks with new features.',
      'manifest.yaml': [
        'name: task-manager',
        'version: 1.1.0',
        'description: Manage tasks efficiently with new features',
        'author:',
        '  name: Test Author',
        '  github: testauthor',
        'capabilities:',
        '  required: [bash]',
        'tags: [tasks, productivity]',
        'category: productivity',
        'trust_level: verified',
      ].join('\n'),
    });

    // Index with only v1.0.0 as latest
    indexV1 = buildSignedIndexMultiVersion(
      'task-manager',
      { '1.0.0': archiveV1 },
      '1.0.0',
      keys.privateKey,
      'verified',
    );

    // Index with both v1.0.0 and v1.1.0, v1.1.0 as latest
    indexV2 = buildSignedIndexMultiVersion(
      'task-manager',
      { '1.0.0': archiveV1, '1.1.0': archiveV2 },
      '1.1.0',
      keys.privateKey,
      'verified',
    );
  });

  it('step 1: install v1.0.0 with full verification flow', async () => {
    const result = await installSkill({
      skillName: 'task-manager',
      index: indexV1,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archiveV1,
      skillsDir,
      source: 'https://catalog.example.com',
    });

    assert.ok(result.success, `Install v1.0.0 should succeed, got: ${result.error}`);
    assert.equal(result.version, '1.0.0');

    const metadata = await readMetadata(join(skillsDir, 'task-manager'));
    assert.ok(metadata !== null, '.kithkit metadata should exist');
    assert.equal(metadata!.version, '1.0.0');
  });

  it('step 2: create index with v1.1.0 available', () => {
    assert.equal(indexV2.skills[0].latest, '1.1.0');
    assert.ok('1.0.0' in indexV2.skills[0].versions, 'v1.0.0 should still be in index');
    assert.ok('1.1.0' in indexV2.skills[0].versions, 'v1.1.0 should be in index');
  });

  it('step 3: checkForUpdate detects v1.1.0 available', async () => {
    const updateCheck = await checkForUpdate('task-manager', skillsDir, indexV2);

    assert.equal(updateCheck.skillName, 'task-manager');
    assert.equal(updateCheck.currentVersion, '1.0.0');
    assert.equal(updateCheck.latestVersion, '1.1.0');
    assert.ok(updateCheck.hasUpdate, 'Should detect available update');
  });

  it('step 4: updateSkill downloads v1.1.0 and installs it', async () => {
    const result = await updateSkill({
      skillName: 'task-manager',
      skillsDir,
      index: indexV2,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archiveV2,
      source: 'https://catalog.example.com',
    });

    assert.ok(result.success, `Update should succeed, got: ${result.error}`);
    assert.equal(result.version, '1.1.0');
    assert.equal(result.skillName, 'task-manager');
  });

  it('step 5: read .kithkit metadata shows v1.1.0', async () => {
    const metadata = await readMetadata(join(skillsDir, 'task-manager'));
    assert.ok(metadata !== null, '.kithkit metadata should exist after update');
    assert.equal(metadata!.version, '1.1.0', 'Version should be updated to 1.1.0');

    // Verify the new SKILL.md was extracted
    const skillMd = await readFile(join(skillsDir, 'task-manager', 'SKILL.md'), 'utf8');
    assert.ok(skillMd.includes('v1.1.0'), 'SKILL.md should reflect v1.1.0 content');
  });
});

// ---------------------------------------------------------------------------
// t-087: Uninstall removes skill and preserves config backup
// ---------------------------------------------------------------------------

describe('t-087: Uninstall removes skill and preserves config backup', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;
  const CONFIG_CONTENT = 'api_key: "my-secret-key"\nmax_results: 10\n';

  before(async () => {
    skillsDir = join(tmpDir, 't087-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('file-organizer', {
      'SKILL.md': '# File Organizer\nOrganizes your files automatically.',
      'manifest.yaml': 'name: file-organizer\nversion: 2.0.0\n',
    });

    signedIndex = buildSignedIndex('file-organizer', '2.0.0', archive, keys.privateKey);
  });

  it('step 1: install a skill then write a config.yaml in its directory', async () => {
    const result = await installSkill({
      skillName: 'file-organizer',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
    });

    assert.ok(result.success, `Install should succeed, got: ${result.error}`);

    // Write a config.yaml as if the user configured the skill
    const configPath = join(skillsDir, 'file-organizer', 'config.yaml');
    await writeFile(configPath, CONFIG_CONTENT, 'utf8');

    // Verify config exists
    const configContent = await readFile(configPath, 'utf8');
    assert.equal(configContent, CONFIG_CONTENT, 'Config should be written');
  });

  it('step 2: uninstallSkill removes skill directory', async () => {
    const result = await uninstallSkill('file-organizer', skillsDir);

    assert.ok(result.success, `Uninstall should succeed, got: ${result.error}`);
    assert.equal(result.skillName, 'file-organizer');
    assert.ok(result.configBackedUp, 'Config should have been backed up');

    // Verify skill directory is gone
    let dirExists = false;
    try {
      await readFile(join(skillsDir, 'file-organizer', '.kithkit'), 'utf8');
      dirExists = true;
    } catch {
      dirExists = false;
    }
    assert.ok(!dirExists, 'Skill directory should be removed');
  });

  it('step 3: config.yaml.bak exists in .kithkit-backups with original content', async () => {
    const backupPath = join(skillsDir, '.kithkit-backups', 'file-organizer', 'config.yaml.bak');
    const backupContent = await readFile(backupPath, 'utf8');
    assert.equal(backupContent, CONFIG_CONTENT, 'Backup should have original config content');
  });

  it('step 4: restoreConfigBackup returns the backup content', async () => {
    const content = await restoreConfigBackup('file-organizer', skillsDir);
    assert.ok(content !== null, 'restoreConfigBackup should return non-null');
    assert.equal(content, CONFIG_CONTENT, 'Restored content should match original config');
  });
});

// ---------------------------------------------------------------------------
// Additional: checkAllUpdates with multiple installed skills
// ---------------------------------------------------------------------------

describe('checkAllUpdates with multiple installed skills', () => {
  let skillsDir: string;
  let archiveWeatherV1: Buffer;
  let archiveCalendarV1: Buffer;
  let archiveCalendarV2: Buffer;

  before(async () => {
    skillsDir = join(tmpDir, 'multi-update-skills');
    await mkdir(skillsDir, { recursive: true });

    archiveWeatherV1 = await createTestArchive('weather-skill', {
      'SKILL.md': '# Weather Skill',
      'manifest.yaml': 'name: weather-skill\nversion: 1.0.0\n',
    });

    archiveCalendarV1 = await createTestArchive('calendar-skill', {
      'SKILL.md': '# Calendar Skill v1',
      'manifest.yaml': 'name: calendar-skill\nversion: 1.0.0\n',
    });

    archiveCalendarV2 = await createTestArchive('calendar-skill', {
      'SKILL.md': '# Calendar Skill v2',
      'manifest.yaml': 'name: calendar-skill\nversion: 2.0.0\n',
    });

    // Install weather at v1.0.0 (will remain up-to-date)
    const weatherIndex = buildSignedIndex('weather-skill', '1.0.0', archiveWeatherV1, keys.privateKey);
    await installSkill({
      skillName: 'weather-skill',
      index: weatherIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveWeatherV1,
      skillsDir,
    });

    // Install calendar at v1.0.0 (will have an update to v2.0.0)
    const calendarV1Index = buildSignedIndex('calendar-skill', '1.0.0', archiveCalendarV1, keys.privateKey);
    await installSkill({
      skillName: 'calendar-skill',
      index: calendarV1Index,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveCalendarV1,
      skillsDir,
    });
  });

  it('checkAllUpdates finds only calendar-skill has an update', async () => {
    // Index where calendar has v2.0.0 latest but weather is still v1.0.0
    const mixedIndex = buildMultiSkillIndex([
      { skillName: 'weather-skill', version: '1.0.0', archiveData: archiveWeatherV1 },
      { skillName: 'calendar-skill', version: '2.0.0', archiveData: archiveCalendarV2 },
    ], keys.privateKey);

    const results = await checkAllUpdates(skillsDir, mixedIndex);

    assert.equal(results.length, 2, 'Should have results for both installed skills');

    const weatherResult = results.find(r => r.skillName === 'weather-skill');
    const calendarResult = results.find(r => r.skillName === 'calendar-skill');

    assert.ok(weatherResult, 'Should have weather-skill result');
    assert.ok(!weatherResult!.hasUpdate, 'weather-skill should NOT have an update');
    assert.equal(weatherResult!.currentVersion, '1.0.0');

    assert.ok(calendarResult, 'Should have calendar-skill result');
    assert.ok(calendarResult!.hasUpdate, 'calendar-skill SHOULD have an update');
    assert.equal(calendarResult!.currentVersion, '1.0.0');
    assert.equal(calendarResult!.latestVersion, '2.0.0');
  });
});

// ---------------------------------------------------------------------------
// Additional: listInstalled returns correct entries
// ---------------------------------------------------------------------------

describe('listInstalled returns correct entries', () => {
  let skillsDir: string;
  let archiveA: Buffer;
  let archiveB: Buffer;

  before(async () => {
    skillsDir = join(tmpDir, 'list-installed-skills');
    await mkdir(skillsDir, { recursive: true });

    archiveA = await createTestArchive('skill-alpha', {
      'SKILL.md': '# Skill Alpha',
      'manifest.yaml': 'name: skill-alpha\nversion: 3.0.0\n',
    });

    archiveB = await createTestArchive('skill-beta', {
      'SKILL.md': '# Skill Beta',
      'manifest.yaml': 'name: skill-beta\nversion: 1.5.0\n',
    });

    const indexA = buildSignedIndex('skill-alpha', '3.0.0', archiveA, keys.privateKey, 'first-party');
    const indexB = buildSignedIndex('skill-beta', '1.5.0', archiveB, keys.privateKey, 'community');

    await installSkill({
      skillName: 'skill-alpha',
      index: indexA,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveA,
      skillsDir,
      source: 'https://catalog.kithkit.dev',
    });

    await installSkill({
      skillName: 'skill-beta',
      index: indexB,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveB,
      skillsDir,
      source: 'https://catalog.kithkit.dev',
    });
  });

  it('listInstalled without index returns basic entries', async () => {
    const entries = await listInstalled(skillsDir);

    assert.equal(entries.length, 2, 'Should list both installed skills');

    const alpha = entries.find(e => e.name === 'skill-alpha');
    const beta = entries.find(e => e.name === 'skill-beta');

    assert.ok(alpha, 'skill-alpha should be in list');
    assert.equal(alpha!.version, '3.0.0');
    assert.equal(alpha!.trust_level, 'first-party');
    assert.ok(!alpha!.hasUpdate, 'No index provided — hasUpdate should be false');

    assert.ok(beta, 'skill-beta should be in list');
    assert.equal(beta!.version, '1.5.0');
    assert.equal(beta!.trust_level, 'community');
    assert.ok(!beta!.hasUpdate, 'No index provided — hasUpdate should be false');
  });

  it('listInstalled with index correctly marks update availability', async () => {
    // Build index where skill-alpha has a newer version 4.0.0
    const archiveAlphaV4 = await createTestArchive('skill-alpha', {
      'SKILL.md': '# Skill Alpha v4',
      'manifest.yaml': 'name: skill-alpha\nversion: 4.0.0\n',
    });

    const updatedIndex = buildMultiSkillIndex([
      { skillName: 'skill-alpha', version: '4.0.0', archiveData: archiveAlphaV4, trustLevel: 'first-party' },
      { skillName: 'skill-beta', version: '1.5.0', archiveData: archiveB, trustLevel: 'community' },
    ], keys.privateKey);

    const entries = await listInstalled(skillsDir, updatedIndex);

    const alpha = entries.find(e => e.name === 'skill-alpha');
    const beta = entries.find(e => e.name === 'skill-beta');

    assert.ok(alpha, 'skill-alpha should be listed');
    assert.ok(alpha!.hasUpdate, 'skill-alpha should have an update available');
    assert.equal(alpha!.latestVersion, '4.0.0', 'latestVersion should be 4.0.0');

    assert.ok(beta, 'skill-beta should be listed');
    assert.ok(!beta!.hasUpdate, 'skill-beta should NOT have an update');
    assert.equal(beta!.latestVersion, undefined, 'latestVersion should be undefined when no update');
  });
});

// ---------------------------------------------------------------------------
// Additional: uninstall of non-installed skill returns error
// ---------------------------------------------------------------------------

describe('Uninstall of non-installed skill returns error', () => {
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 'uninstall-error-skills');
    await mkdir(skillsDir, { recursive: true });
  });

  it('uninstallSkill returns error for non-installed skill', async () => {
    const result = await uninstallSkill('ghost-skill', skillsDir);

    assert.ok(!result.success, 'Uninstall should fail for non-installed skill');
    assert.ok(result.error, 'Should have an error message');
    assert.ok(
      result.error!.includes('not installed') || result.error!.includes('ghost-skill'),
      `Error should mention not installed or skill name, got: ${result.error}`,
    );
    assert.ok(!result.configBackedUp, 'No config should be backed up');
  });

  it('restoreConfigBackup returns null when no backup exists', async () => {
    const content = await restoreConfigBackup('ghost-skill', skillsDir);
    assert.equal(content, null, 'Should return null for missing backup');
  });
});

// ---------------------------------------------------------------------------
// Additional: update when already at latest returns early
// ---------------------------------------------------------------------------

describe('Update when already at latest returns early (no change)', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 'no-update-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('stable-skill', {
      'SKILL.md': '# Stable Skill',
      'manifest.yaml': 'name: stable-skill\nversion: 5.0.0\n',
    });

    signedIndex = buildSignedIndex('stable-skill', '5.0.0', archive, keys.privateKey);

    await installSkill({
      skillName: 'stable-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archive,
      skillsDir,
    });
  });

  it('checkForUpdate returns hasUpdate=false when already at latest', async () => {
    const result = await checkForUpdate('stable-skill', skillsDir, signedIndex);
    assert.ok(!result.hasUpdate, 'Should report no update available');
    assert.equal(result.currentVersion, '5.0.0');
    assert.equal(result.latestVersion, '5.0.0');
  });

  it('updateSkill returns early without modifying files when already at latest', async () => {
    const result = await updateSkill({
      skillName: 'stable-skill',
      skillsDir,
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => { throw new Error('Should not be called'); },
    });

    assert.ok(!result.success, 'Update should report no success (no update needed)');
    assert.ok(result.error, 'Should have a message explaining no update needed');
    assert.ok(
      result.error!.includes('latest') || result.error!.includes('5.0.0'),
      `Error should explain already at latest, got: ${result.error}`,
    );

    // Verify the skill is still intact
    const metadata = await readMetadata(join(skillsDir, 'stable-skill'));
    assert.ok(metadata !== null, 'Metadata should still exist after no-op update');
    assert.equal(metadata!.version, '5.0.0', 'Version should remain 5.0.0');
  });
});

// ---------------------------------------------------------------------------
// Additional: update preserves existing config.yaml
// ---------------------------------------------------------------------------

describe('Update preserves existing config.yaml', () => {
  let archiveV1: Buffer;
  let archiveV2: Buffer;
  let skillsDir: string;
  const CONFIG_CONTENT = 'api_endpoint: "https://api.example.com"\ntimeout: 30\n';

  before(async () => {
    skillsDir = join(tmpDir, 'config-preserve-skills');
    await mkdir(skillsDir, { recursive: true });

    archiveV1 = await createTestArchive('configurable-skill', {
      'SKILL.md': '# Configurable Skill v1',
      'manifest.yaml': 'name: configurable-skill\nversion: 1.0.0\n',
    });

    archiveV2 = await createTestArchive('configurable-skill', {
      'SKILL.md': '# Configurable Skill v2 with improvements',
      'manifest.yaml': 'name: configurable-skill\nversion: 2.0.0\n',
    });

    const indexV1 = buildSignedIndex('configurable-skill', '1.0.0', archiveV1, keys.privateKey);
    await installSkill({
      skillName: 'configurable-skill',
      index: indexV1,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveV1,
      skillsDir,
    });

    // Simulate user configuring the skill
    await writeFile(join(skillsDir, 'configurable-skill', 'config.yaml'), CONFIG_CONTENT, 'utf8');
  });

  it('update to v2.0.0 preserves existing config.yaml', async () => {
    const indexV2 = buildSignedIndexMultiVersion(
      'configurable-skill',
      { '1.0.0': archiveV1, '2.0.0': archiveV2 },
      '2.0.0',
      keys.privateKey,
    );

    const result = await updateSkill({
      skillName: 'configurable-skill',
      skillsDir,
      index: indexV2,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async () => archiveV2,
    });

    assert.ok(result.success, `Update should succeed, got: ${result.error}`);
    assert.equal(result.version, '2.0.0');

    // Config should be preserved
    const restoredConfig = await readFile(
      join(skillsDir, 'configurable-skill', 'config.yaml'),
      'utf8',
    );
    assert.equal(restoredConfig, CONFIG_CONTENT, 'config.yaml should be preserved after update');

    // New SKILL.md should be from v2
    const skillMd = await readFile(join(skillsDir, 'configurable-skill', 'SKILL.md'), 'utf8');
    assert.ok(skillMd.includes('v2'), 'SKILL.md should reflect v2 content');
  });
});
