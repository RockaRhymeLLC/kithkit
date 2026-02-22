import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkUnicode } from '../src/checks/unicode.ts';

function createSkillDir(tmpDir: string, name: string, skillMd: string): string {
  const dir = join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.yaml'), `name: ${name}\nversion: 1.0.0\n`);
  writeFileSync(join(dir, 'SKILL.md'), skillMd);
  return dir;
}

// --- t-072: Unicode check detects hidden characters ---

describe('t-072: Unicode check detects hidden characters', () => {
  let tmpDir: string;
  before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'kithkit-uni-')); });
  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('step 1: detects Unicode Tags', () => {
    // U+E0001 (Language Tag) through U+E007F — embed a Unicode Tag character
    const tagChar = String.fromCodePoint(0xE0001);
    const dir = createSkillDir(tmpDir, 'uni1', `# Skill\nSome text${tagChar}with hidden tags.`);
    const result = checkUnicode(dir);
    assert.equal(result.pass, false);
    const finding = result.findings.find(f => f.check === 'unicode/tags');
    assert.ok(finding, 'Expected Unicode Tags finding');
    assert.equal(finding!.severity, 'error');
  });

  it('step 2: detects Cyrillic homoglyphs', () => {
    // \u0430 is Cyrillic 'а' that looks like Latin 'a'
    const dir = createSkillDir(tmpDir, 'uni2', '# Skill\nRun the \u0430ction to complete the t\u0430sk.');
    const result = checkUnicode(dir);
    const finding = result.findings.find(f => f.check === 'unicode/homoglyph');
    assert.ok(finding, 'Expected homoglyph finding');
    assert.equal(finding!.severity, 'warning');
  });

  it('step 3: detects zero-width characters', () => {
    // U+200B is zero-width space
    const dir = createSkillDir(tmpDir, 'uni3', '# Skill\nRun the\u200B command.');
    const result = checkUnicode(dir);
    const finding = result.findings.find(f => f.check === 'unicode/zero-width');
    assert.ok(finding, 'Expected zero-width finding');
    assert.equal(finding!.severity, 'warning');
  });

  it('step 4: legitimate Japanese text passes', () => {
    const dir = createSkillDir(tmpDir, 'uni4', '# スキル\nこのスキルは天気予報を確認します。\n\n## 使い方\n場所を指定して天気を取得します。');
    const result = checkUnicode(dir);
    const unicodeFindings = result.findings.filter(f => f.check.startsWith('unicode/'));
    assert.equal(unicodeFindings.length, 0, `Expected no Unicode findings for Japanese text, got: ${JSON.stringify(unicodeFindings)}`);
  });
});
