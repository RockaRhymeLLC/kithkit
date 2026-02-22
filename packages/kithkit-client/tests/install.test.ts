/**
 * Catalog Client Install Tests
 *
 * Tests: t-080 (agent installs skill with full signature verification),
 *        t-081 (install rejects tampered archive),
 *        revoked skill blocked on install,
 *        already-installed skill detected
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
} from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

import {
  verifyArchiveIntegrity,
  extractArchive,
  writeMetadata,
  readMetadata,
  installSkill,
  verifyRevocationList,
  isRevoked,
} from '../src/install.ts';
import type {
  SignedCatalogIndex,
  SkillEntry,
  KithkitMetadata,
  RevocationEntry,
  SignedRevocationList,
} from '../src/types.ts';

const gzipAsync = promisify(gzip);

// ---------------------------------------------------------------------------
// Test helpers
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
// Minimal tar + gzip implementation (mirrors catalog's archive.ts)
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
  files: Record<string, string>,  // filename → content
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
 * Build a signed catalog index entry for a skill with a given archive.
 */
function buildSignedIndex(
  skillName: string,
  version: string,
  archiveData: Buffer,
  privateKey: string,
  trustLevel: 'first-party' | 'verified' | 'community' = 'verified',
): SignedCatalogIndex {
  const sha256 = createHash('sha256').update(archiveData).digest('hex');
  const hashBytes = Buffer.from(sha256, 'hex');
  const archiveSig = signData(hashBytes, privateKey);

  const skill: SkillEntry = {
    name: skillName,
    description: `Test skill: ${skillName}`,
    author: { name: 'Test Author', github: 'testauthor' },
    capabilities: { required: ['bash'] },
    tags: ['testing'],
    category: 'testing',
    trust_level: trustLevel,
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
 * Build a signed revocation list.
 */
function buildRevocationList(
  entries: RevocationEntry[],
  privateKey: string,
): SignedRevocationList {
  const sorted = [...entries].sort((a, b) => {
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.version.localeCompare(b.version);
  });
  const canonical = canonicalJson(sorted);
  const sig = signData(Buffer.from(canonical, 'utf8'), privateKey);
  return { entries: sorted, signature: sig };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let tmpDir: string;
let keys: { publicKey: string; privateKey: string };

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kithkit-install-test-'));
  keys = generateKeyPair();
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// t-080: Agent installs skill with full signature verification
// ---------------------------------------------------------------------------

describe('t-080: Agent installs skill with full signature verification', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 't080-skills');
    await mkdir(skillsDir, { recursive: true });

    // Create a proper signed archive for weather-check
    archive = await createTestArchive('weather-check', {
      'SKILL.md': '# Weather Check\nA skill to check weather.',
      'manifest.yaml': [
        'name: weather-check',
        'version: 1.0.0',
        'description: Check weather forecasts',
        'author:',
        '  name: Test Author',
        '  github: testauthor',
        'capabilities:',
        '  required: [bash]',
        'tags: [weather, api]',
        'category: utilities',
        'trust_level: verified',
      ].join('\n'),
    });

    signedIndex = buildSignedIndex('weather-check', '1.0.0', archive, keys.privateKey, 'verified');
  });

  it('step 1: build a signed archive with SKILL.md and manifest.yaml', async () => {
    assert.ok(archive.length > 0, 'Archive should be non-empty');
    // Verify archive is a valid gzip (magic bytes: 1f 8b)
    assert.equal(archive[0], 0x1f);
    assert.equal(archive[1], 0x8b);
  });

  it('step 2: build a signed index containing weather-check', () => {
    assert.equal(signedIndex.skills.length, 1);
    assert.equal(signedIndex.skills[0].name, 'weather-check');
    assert.ok(signedIndex.signature.length > 10, 'Index should have a valid signature');
  });

  it('step 3: index signature verifies correctly', () => {
    const { signature, ...body } = signedIndex;
    const canonical = canonicalJson(body);
    const keyObject = createPublicKey({
      key: Buffer.from(keys.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = cryptoVerify(null, Buffer.from(canonical, 'utf8'), keyObject, Buffer.from(signature, 'base64'));
    assert.ok(ok, 'Index signature should be valid');
  });

  it('step 4: archive hash matches expected sha256 in index', () => {
    const actualHash = createHash('sha256').update(archive).digest('hex');
    const expectedHash = signedIndex.skills[0].versions['1.0.0'].sha256;
    assert.equal(actualHash, expectedHash, 'Archive hash must match index entry');
  });

  it('step 5: archive signature verifies correctly', () => {
    const versionEntry = signedIndex.skills[0].versions['1.0.0'];
    const result = verifyArchiveIntegrity(archive, versionEntry.sha256, versionEntry.signature, keys.publicKey);
    assert.ok(result.valid, 'Archive integrity should be valid');
  });

  it('step 6: installSkill extracts files to skillsDir/weather-check/', async () => {
    const result = await installSkill({
      skillName: 'weather-check',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
      source: 'https://catalog.example.com',
    });

    assert.ok(result.success, `Install should succeed, got error: ${result.error}`);
    assert.equal(result.skillName, 'weather-check');
    assert.equal(result.version, '1.0.0');
    assert.ok(result.installDir.endsWith('weather-check'));

    // Verify files were extracted
    const skillMd = await readFile(join(skillsDir, 'weather-check', 'SKILL.md'), 'utf8');
    assert.ok(skillMd.includes('Weather Check'), 'SKILL.md should be extracted');

    const manifestYaml = await readFile(join(skillsDir, 'weather-check', 'manifest.yaml'), 'utf8');
    assert.ok(manifestYaml.includes('weather-check'), 'manifest.yaml should be extracted');
  });

  it('step 7: .kithkit metadata file is written with correct fields', async () => {
    const metadata = await readMetadata(join(skillsDir, 'weather-check'));
    assert.ok(metadata !== null, '.kithkit metadata should exist after install');
    assert.equal(metadata!.name, 'weather-check');
    assert.equal(metadata!.version, '1.0.0');
    assert.equal(metadata!.trust_level, 'verified');
    assert.equal(metadata!.source, 'https://catalog.example.com');
    assert.ok(metadata!.sha256.length === 64, 'sha256 should be 64 hex chars');
    assert.ok(metadata!.signature.length > 10, 'signature should be non-trivial base64');
    assert.ok(metadata!.installed_at.length > 0, 'installed_at should be set');
  });
});

// ---------------------------------------------------------------------------
// t-081: Install rejects tampered archive
// ---------------------------------------------------------------------------

describe('t-081: Install rejects tampered archive', () => {
  let archive: Buffer;
  let tamperedArchive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 't081-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('safe-skill', {
      'SKILL.md': '# Safe Skill\nA legitimate skill.',
      'manifest.yaml': 'name: safe-skill\nversion: 2.0.0\n',
    });

    signedIndex = buildSignedIndex('safe-skill', '2.0.0', archive, keys.privateKey);

    // Tamper: append some bytes to the archive
    tamperedArchive = Buffer.concat([archive, Buffer.from('TAMPERED_CONTENT')]);
  });

  it('step 1: build a valid signed archive and index', () => {
    assert.ok(archive.length > 0);
    assert.equal(signedIndex.skills[0].name, 'safe-skill');
  });

  it('step 2: modify the archive content (append bytes)', () => {
    assert.notEqual(
      tamperedArchive.length,
      archive.length,
      'Tampered archive should have different length',
    );
    const originalHash = createHash('sha256').update(archive).digest('hex');
    const tamperedHash = createHash('sha256').update(tamperedArchive).digest('hex');
    assert.notEqual(originalHash, tamperedHash, 'Tampered archive should have different hash');
  });

  it('step 3: installSkill with tampered archive fails with integrity error', async () => {
    const result = await installSkill({
      skillName: 'safe-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => tamperedArchive,
      skillsDir,
    });

    assert.ok(!result.success, 'Install should fail for tampered archive');
    assert.ok(result.error, 'Should have an error message');
    assert.ok(
      result.error!.toLowerCase().includes('hash') ||
      result.error!.toLowerCase().includes('mismatch') ||
      result.error!.toLowerCase().includes('integrity'),
      `Error should mention hash/integrity problem, got: ${result.error}`,
    );
  });

  it('step 4: skill directory was NOT created after failed install', async () => {
    const skillDir = join(skillsDir, 'safe-skill');
    let exists = false;
    try {
      await readFile(join(skillDir, '.kithkit'), 'utf8');
      exists = true;
    } catch {
      // Expected: directory should not exist or not have metadata
      exists = false;
    }
    assert.ok(!exists, 'Skill directory should not have been created after failed install');
  });
});

// ---------------------------------------------------------------------------
// Additional test: revoked skill is blocked on install
// ---------------------------------------------------------------------------

describe('Revoked skill blocked on install', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let revocationList: SignedRevocationList;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 'revoked-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('malicious-skill', {
      'SKILL.md': '# Malicious Skill',
      'manifest.yaml': 'name: malicious-skill\nversion: 1.0.0\n',
    });

    signedIndex = buildSignedIndex('malicious-skill', '1.0.0', archive, keys.privateKey);

    const entries: RevocationEntry[] = [
      {
        name: 'malicious-skill',
        version: '1.0.0',
        reason: 'Exfiltrates API keys to remote server',
        revoked_at: '2026-02-21T00:00:00.000Z',
        severity: 'critical',
      },
    ];
    revocationList = buildRevocationList(entries, keys.privateKey);
  });

  it('revocation list signature is valid', () => {
    const ok = verifyRevocationList(revocationList, keys.publicKey);
    assert.ok(ok, 'Revocation list signature should be valid');
  });

  it('isRevoked returns true for malicious-skill v1.0.0', () => {
    const result = isRevoked(revocationList, 'malicious-skill', '1.0.0');
    assert.ok(result.revoked, 'malicious-skill v1.0.0 should be revoked');
    assert.ok(result.entry, 'Should return the matching entry');
    assert.equal(result.entry!.severity, 'critical');
  });

  it('installSkill returns error when skill is revoked', async () => {
    const result = await installSkill({
      skillName: 'malicious-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
      revocationList,
    });

    assert.ok(!result.success, 'Install should fail for revoked skill');
    assert.ok(result.error, 'Should have an error message');
    assert.ok(
      result.error!.includes('revoked') || result.error!.includes('Exfiltrates'),
      `Error should mention revocation, got: ${result.error}`,
    );
  });

  it('skill is not installed after revocation rejection', async () => {
    const metadata = await readMetadata(join(skillsDir, 'malicious-skill'));
    assert.equal(metadata, null, 'Revoked skill should not have been installed');
  });
});

// ---------------------------------------------------------------------------
// Additional test: already-installed skill detected
// ---------------------------------------------------------------------------

describe('Already-installed skill is detected', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 'already-installed-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('idempotent-skill', {
      'SKILL.md': '# Idempotent Skill',
      'manifest.yaml': 'name: idempotent-skill\nversion: 3.0.0\n',
    });

    signedIndex = buildSignedIndex('idempotent-skill', '3.0.0', archive, keys.privateKey);
  });

  it('first install succeeds', async () => {
    const result = await installSkill({
      skillName: 'idempotent-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
    });

    assert.ok(result.success, `First install should succeed, got: ${result.error}`);
    assert.equal(result.version, '3.0.0');
  });

  it('second install of same version fails with already-installed error', async () => {
    const result = await installSkill({
      skillName: 'idempotent-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
    });

    assert.ok(!result.success, 'Second install of same version should fail');
    assert.ok(result.error, 'Should have an error message');
    assert.ok(
      result.error!.includes('already installed'),
      `Error should mention already installed, got: ${result.error}`,
    );
  });

  it('metadata is preserved after second install attempt', async () => {
    const metadata = await readMetadata(join(skillsDir, 'idempotent-skill'));
    assert.ok(metadata !== null, 'Metadata should still exist');
    assert.equal(metadata!.version, '3.0.0');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: verifyArchiveIntegrity
// ---------------------------------------------------------------------------

describe('verifyArchiveIntegrity unit tests', () => {
  it('valid archive passes verification', async () => {
    const data = Buffer.from('archive content for testing');
    const hash = createHash('sha256').update(data).digest('hex');
    const hashBytes = Buffer.from(hash, 'hex');
    const sig = signData(hashBytes, keys.privateKey);

    const result = verifyArchiveIntegrity(data, hash, sig, keys.publicKey);
    assert.ok(result.valid, 'Valid archive should pass verification');
  });

  it('wrong hash fails verification', async () => {
    const data = Buffer.from('archive content');
    const wrongHash = 'a'.repeat(64);
    const sig = signData(Buffer.from('a'.repeat(32), 'hex'), keys.privateKey);

    const result = verifyArchiveIntegrity(data, wrongHash, sig, keys.publicKey);
    assert.ok(!result.valid, 'Wrong hash should fail verification');
    assert.ok(result.valid === false && result.error.includes('mismatch'));
  });

  it('corrupted signature fails verification', async () => {
    const data = Buffer.from('archive content');
    const hash = createHash('sha256').update(data).digest('hex');
    const badSig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

    const result = verifyArchiveIntegrity(data, hash, badSig, keys.publicKey);
    assert.ok(!result.valid, 'Corrupted signature should fail');
  });

  it('wrong public key fails verification', async () => {
    const data = Buffer.from('archive content');
    const hash = createHash('sha256').update(data).digest('hex');
    const hashBytes = Buffer.from(hash, 'hex');
    const sig = signData(hashBytes, keys.privateKey);

    const otherKeys = generateKeyPair();
    const result = verifyArchiveIntegrity(data, hash, sig, otherKeys.publicKey);
    assert.ok(!result.valid, 'Wrong public key should fail verification');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: extractArchive path traversal prevention
// ---------------------------------------------------------------------------

describe('extractArchive path traversal prevention', () => {
  it('rejects archive entries with .. components', async () => {
    const targetDir = join(tmpDir, 'traversal-test-dotdot');
    await mkdir(targetDir, { recursive: true });

    // Manually create a tar with a dangerous path
    const maliciousName = 'skill-name/../../../etc/passwd';
    const content = Buffer.from('evil content');
    const tarParts: Buffer[] = [];
    const header = createTarHeader(maliciousName, content.length);
    tarParts.push(header);
    tarParts.push(content);
    const rem = content.length % TAR_BLOCK_SIZE;
    if (rem > 0) tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE - rem));
    tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
    const tarBuffer = Buffer.concat(tarParts);
    const archiveData = await gzipAsync(tarBuffer);

    await assert.rejects(
      () => extractArchive(archiveData, targetDir),
      (err: Error) => {
        return err.message.includes('Path traversal') || err.message.includes('..');
      },
      'Should reject entries with .. components',
    );
  });

  it('rejects absolute paths in archive', async () => {
    const targetDir = join(tmpDir, 'traversal-test-absolute');
    await mkdir(targetDir, { recursive: true });

    const maliciousName = '/etc/passwd';
    const content = Buffer.from('evil content');
    const tarParts: Buffer[] = [];
    const header = createTarHeader(maliciousName, content.length);
    tarParts.push(header);
    tarParts.push(content);
    const rem = content.length % TAR_BLOCK_SIZE;
    if (rem > 0) tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE - rem));
    tarParts.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
    const tarBuffer = Buffer.concat(tarParts);
    const archiveData = await gzipAsync(tarBuffer);

    await assert.rejects(
      () => extractArchive(archiveData, targetDir),
      (err: Error) => {
        return err.message.includes('Path traversal') || err.message.includes('absolute');
      },
      'Should reject absolute paths',
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests: writeMetadata / readMetadata
// ---------------------------------------------------------------------------

describe('writeMetadata / readMetadata', () => {
  it('write and read roundtrip', async () => {
    const metaDir = join(tmpDir, 'meta-test-skill');
    await mkdir(metaDir, { recursive: true });

    const metadata: KithkitMetadata = {
      name: 'test-skill',
      version: '1.2.3',
      source: 'https://catalog.example.com/archives/test-skill/test-skill-1.2.3.tar.gz',
      sha256: 'a'.repeat(64),
      signature: 'dGVzdHNpZ25hdHVyZQ==',
      installed_at: '2026-02-21T00:00:00.000Z',
      trust_level: 'first-party',
    };

    await writeMetadata(metaDir, metadata);
    const readBack = await readMetadata(metaDir);

    assert.ok(readBack !== null, 'Should read back metadata');
    assert.deepStrictEqual(readBack, metadata);
  });

  it('readMetadata returns null when .kithkit does not exist', async () => {
    const emptyDir = join(tmpDir, 'no-metadata-dir');
    await mkdir(emptyDir, { recursive: true });

    const result = await readMetadata(emptyDir);
    assert.equal(result, null, 'Should return null for missing .kithkit file');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: installSkill error cases
// ---------------------------------------------------------------------------

describe('installSkill error cases', () => {
  let archive: Buffer;
  let signedIndex: SignedCatalogIndex;
  let skillsDir: string;

  before(async () => {
    skillsDir = join(tmpDir, 'error-case-skills');
    await mkdir(skillsDir, { recursive: true });

    archive = await createTestArchive('test-error-skill', {
      'SKILL.md': '# Test Skill',
      'manifest.yaml': 'name: test-error-skill\nversion: 1.0.0\n',
    });

    signedIndex = buildSignedIndex('test-error-skill', '1.0.0', archive, keys.privateKey);
  });

  it('skill not in index returns error', async () => {
    const result = await installSkill({
      skillName: 'nonexistent-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
    });

    assert.ok(!result.success);
    assert.ok(result.error!.includes('not found'));
  });

  it('requested version not in index returns error', async () => {
    const result = await installSkill({
      skillName: 'test-error-skill',
      version: '99.0.0',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => archive,
      skillsDir,
    });

    assert.ok(!result.success);
    assert.ok(
      result.error!.includes('Version') || result.error!.includes('99.0.0'),
      `Should mention missing version, got: ${result.error}`,
    );
  });

  it('fetchArchive failure returns error', async () => {
    const result = await installSkill({
      skillName: 'test-error-skill',
      index: signedIndex,
      publicKeyBase64: keys.publicKey,
      fetchArchive: async (_url: string) => {
        throw new Error('Network unreachable');
      },
      skillsDir,
    });

    assert.ok(!result.success);
    assert.ok(
      result.error!.includes('Network unreachable') || result.error!.includes('fetch'),
      `Should mention fetch failure, got: ${result.error}`,
    );
  });
});
