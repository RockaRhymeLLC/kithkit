import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkStructure } from '../src/checks/structure.ts';

// --- t-065: Structure check passes for valid skill package ---

describe('t-065: Structure check passes for valid skill package', () => {
  const fixtureDir = join(import.meta.dirname!, '..', 'tests', 'fixtures', 'valid-skill');

  it('step 1: all required files present', () => {
    // The fixture has manifest.yaml, SKILL.md, reference.md, CHANGELOG.md
    const result = checkStructure(fixtureDir);
    const missingFiles = result.findings.filter(f =>
      f.check === 'structure/required-files'
    );
    assert.equal(missingFiles.length, 0, 'All required files should be present');
  });

  it('step 2: structure check passes with no errors', () => {
    const result = checkStructure(fixtureDir);
    assert.equal(result.pass, true, `Expected pass, got findings: ${JSON.stringify(result.findings)}`);
  });

  it('step 3: total package size within limits', () => {
    const result = checkStructure(fixtureDir);
    const sizeErrors = result.findings.filter(f =>
      f.check === 'structure/package-size' || f.check === 'structure/file-size'
    );
    assert.equal(sizeErrors.length, 0, 'Size should be within limits');
  });
});

// --- t-066: Structure check rejects executable files ---

describe('t-066: Structure check rejects executable files', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kithkit-test-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSkillDir(name: string, extraFiles: string[] = []): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'name: test-skill\nversion: 1.0.0\ndescription: Test\nauthor:\n  name: Test\n  github: test\ncapabilities:\n  required:\n    - bash\n');
    writeFileSync(join(dir, 'SKILL.md'), '# Test Skill\nA test.');
    for (const f of extraFiles) {
      writeFileSync(join(dir, f), '# placeholder');
    }
    return dir;
  }

  it('step 1: .sh file produces error', () => {
    const dir = createSkillDir('with-sh', ['setup.sh']);
    const result = checkStructure(dir);
    const execErr = result.findings.find(f =>
      f.check === 'structure/no-executables' && f.message.includes('.sh')
    );
    assert.ok(execErr, 'Expected error for .sh file');
    assert.equal(result.pass, false);
  });

  it('step 2: .py file produces error', () => {
    const dir = createSkillDir('with-py', ['helper.py']);
    const result = checkStructure(dir);
    const execErr = result.findings.find(f =>
      f.check === 'structure/no-executables' && f.message.includes('.py')
    );
    assert.ok(execErr, 'Expected error for .py file');
  });

  it('step 3: .exe file produces error', () => {
    const dir = createSkillDir('with-exe', ['tool.exe']);
    const result = checkStructure(dir);
    const execErr = result.findings.find(f =>
      f.check === 'structure/no-executables' && f.message.includes('.exe')
    );
    assert.ok(execErr, 'Expected error for .exe file');
  });

  it('step 4: only .md and .yaml files pass', () => {
    const dir = createSkillDir('clean');
    const result = checkStructure(dir);
    assert.equal(result.pass, true, `Expected pass, got: ${JSON.stringify(result.findings)}`);
  });
});
