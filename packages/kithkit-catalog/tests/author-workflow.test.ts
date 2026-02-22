/**
 * Author Workflow Tests
 *
 * Tests: t-092 (local linting), t-093 (PR submission workflow)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', '..');
import {
  createArchive,
  extractManifestFromArchive,
  hashArchive,
  buildIndex,
  updateIndex,
  verifySignedIndex,
  serializeIndex,
  generateKeyPair,
} from '../src/index.ts';

let tmpDir: string;
let keys: { publicKey: string; privateKey: string };

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kithkit-author-test-'));
  keys = generateKeyPair();
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function createTestSkill(baseDir: string, name: string, version = '1.0.0'): Promise<string> {
  const skillDir = join(baseDir, name);
  await mkdir(skillDir, { recursive: true });

  await writeFile(join(skillDir, 'manifest.yaml'), [
    `name: ${name}`,
    `version: ${version}`,
    `description: "A test skill for ${name}"`,
    'author:',
    '  name: Test Author',
    '  github: testauthor',
    'capabilities:',
    '  required:',
    '    - web_fetch',
    'tags:',
    '  - test',
    'category: testing',
  ].join('\n'));

  await writeFile(join(skillDir, 'SKILL.md'), `# ${name}\n\nDoes things.\n`);
  await writeFile(join(skillDir, 'CHANGELOG.md'), `# Changelog\n\n## ${version}\n\n- Initial release\n`);

  return skillDir;
}

describe('t-092: Author runs linter locally before submission', () => {
  it('step 1: kithkit-lint command is available via linter package', async () => {
    // Verify the linter package exists and has a bin entry
    const linterPkg = await readFile(
      join(packagesDir, 'kithkit-linter', 'package.json'),
      'utf8',
    );
    const pkg = JSON.parse(linterPkg);
    assert.ok(pkg.bin?.['kithkit-lint'], 'Linter should expose kithkit-lint bin');
  });

  it('step 2: lint results show pass/fail and findings', async () => {
    // Test by importing the linter directly (simulates what CLI does)
    const testDir = join(tmpDir, 't092-lint');
    const skillDir = await createTestSkill(testDir, 'lint-test-skill');

    // Import the linter
    const linterPath = join(packagesDir, 'kithkit-linter', 'src', 'index.ts');
    const { lint } = await import(linterPath);
    const result = lint(skillDir);

    assert.ok(typeof result.pass === 'boolean', 'Result should have pass boolean');
    assert.ok(typeof result.score === 'object', 'Result should have score');
    assert.ok(typeof result.score.errors === 'number', 'Score should have errors count');
    assert.ok(typeof result.checks === 'object', 'Result should have checks');
  });

  it('step 3: fixing issues makes all checks pass', async () => {
    // A well-formed skill should pass all checks
    const testDir = join(tmpDir, 't092-pass');
    const skillDir = await createTestSkill(testDir, 'good-lint-skill');

    const linterPath = join(packagesDir, 'kithkit-linter', 'src', 'index.ts');
    const { lint } = await import(linterPath);
    const result = lint(skillDir);

    assert.ok(result.pass, 'Well-formed skill should pass all checks');
    assert.equal(result.score.errors, 0, 'No errors');
  });

  it('step 4: author packages skill as .tar.gz', async () => {
    const testDir = join(tmpDir, 't092-package');
    const skillDir = await createTestSkill(testDir, 'packaged-skill');
    const archivePath = join(testDir, 'packaged-skill-1.0.0.tar.gz');

    const info = await createArchive(skillDir, archivePath);
    assert.equal(info.name, 'packaged-skill');
    assert.equal(info.version, '1.0.0');
    assert.ok(info.size > 0, 'Archive should have non-zero size');
    assert.ok(info.sha256.match(/^[a-f0-9]{64}$/), 'Should have valid SHA-256');

    // Verify archive contains manifest and SKILL.md
    const extracted = await extractManifestFromArchive(archivePath);
    assert.equal(extracted.name, 'packaged-skill');
    assert.equal(extracted.version, '1.0.0');
  });
});

describe('t-093: Author submits skill via PR workflow', () => {
  it('step 1+2: author adds archive in correct location', async () => {
    const testDir = join(tmpDir, 't093-submit');
    const repoDir = join(testDir, 'repo');
    const archivesDir = join(repoDir, 'archives');

    // Simulate fork: create directory structure
    await mkdir(join(archivesDir, 'my-new-skill'), { recursive: true });

    // Author creates their skill
    const skillDir = await createTestSkill(testDir, 'my-new-skill');
    const archivePath = join(archivesDir, 'my-new-skill', 'my-new-skill-1.0.0.tar.gz');
    await createArchive(skillDir, archivePath);

    // Verify correct location
    const stats = await stat(archivePath);
    assert.ok(stats.isFile(), 'Archive should exist at correct location');
    assert.ok(stats.size > 0, 'Archive should be non-empty');
  });

  it('step 3+4: CI triggered on PR — linter runs and produces results', async () => {
    const testDir = join(tmpDir, 't093-ci');
    const skillDir = await createTestSkill(testDir, 'ci-test-skill');

    // Simulate CI linting step
    const linterPath = join(packagesDir, 'kithkit-linter', 'src', 'index.ts');
    const { lint } = await import(linterPath);
    const result = lint(skillDir);

    // CI would post this as a PR comment
    assert.ok(result.pass, 'Valid skill should pass CI linting');
    assert.ok(result.duration_ms >= 0, 'Result should include duration');
  });

  it('step 5: after merge, skill is signed, index updated, skill discoverable', async () => {
    const testDir = join(tmpDir, 't093-merge');

    // Set up existing catalog with one skill
    const existingDir = await createTestSkill(testDir, 'existing-skill');
    const archivesDir = join(testDir, 'archives');
    await mkdir(join(archivesDir, 'existing-skill'), { recursive: true });
    await createArchive(existingDir, join(archivesDir, 'existing-skill', 'existing-skill-1.0.0.tar.gz'));

    const initialIndex = await buildIndex({
      archivesDir,
      privateKeyBase64: keys.privateKey,
      timestamp: '2026-02-21T00:00:00.000Z',
    });
    assert.equal(initialIndex.skills.length, 1);

    // Simulate PR merge: new skill archive added
    const newSkillDir = await createTestSkill(testDir, 'new-submission');
    await mkdir(join(archivesDir, 'new-submission'), { recursive: true });
    const newArchivePath = join(archivesDir, 'new-submission', 'new-submission-1.0.0.tar.gz');
    await createArchive(newSkillDir, newArchivePath);

    // CI runs: sign and update index
    const updatedIndex = await updateIndex(
      initialIndex,
      newArchivePath,
      keys.privateKey,
      '2026-02-21T01:00:00.000Z',
    );

    // Verify: skill is signed
    assert.equal(updatedIndex.skills.length, 2);
    const newSkill = updatedIndex.skills.find(s => s.name === 'new-submission');
    assert.ok(newSkill, 'New skill should be in index');
    assert.ok(newSkill!.versions['1.0.0'].signature, 'New skill should be signed');

    // Verify: index is signed and valid
    assert.ok(verifySignedIndex(updatedIndex, keys.publicKey), 'Updated index should verify');

    // Verify: skill is discoverable (can find by name)
    const found = updatedIndex.skills.find(s => s.name === 'new-submission');
    assert.ok(found, 'Skill should be discoverable by name');
    assert.equal(found!.latest, '1.0.0');
    assert.equal(found!.author.github, 'testauthor');
  });
});
