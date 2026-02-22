import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI_PATH = join(import.meta.dirname!, '..', 'src', 'cli.ts');
const FIXTURE_DIR = join(import.meta.dirname!, '..', 'tests', 'fixtures', 'valid-skill');

function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [
      '--experimental-strip-types',
      '--no-warnings',
      CLI_PATH,
      ...args,
    ], { encoding: 'utf-8', timeout: 10000 });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '') + (e.stderr || ''), exitCode: e.status ?? 1 };
  }
}

// --- t-067: CLI outputs human-readable and machine-parseable results ---

describe('t-067: CLI outputs human-readable and machine-parseable results', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kithkit-cli-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('step 1: human-readable output with severity indicators', () => {
    // Create a skill with a warning (unknown capability)
    const dir = join(tmpDir, 'warn-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'name: test-skill\nversion: 1.0.0\ndescription: Test\nauthor:\n  name: Test\n  github: test\ncapabilities:\n  required:\n    - custom_thing\n');
    writeFileSync(join(dir, 'SKILL.md'), '# Test\nA test.');

    const { stdout } = runCli([dir]);
    // Should contain severity indicator and pass (warnings don't fail)
    assert.ok(stdout.includes('WARNING') || stdout.includes('warning') || stdout.includes('PASSED'),
      `Expected severity indicators in output: ${stdout}`);
  });

  it('step 2: --json produces valid JSON matching LintResult schema', () => {
    const { stdout, exitCode } = runCli(['--json', FIXTURE_DIR]);
    const result = JSON.parse(stdout);
    assert.ok('pass' in result, 'LintResult must have pass field');
    assert.ok('score' in result, 'LintResult must have score field');
    assert.ok('checks' in result, 'LintResult must have checks field');
    assert.ok('duration_ms' in result, 'LintResult must have duration_ms field');
    assert.equal(typeof result.score.errors, 'number');
    assert.equal(typeof result.score.warnings, 'number');
  });

  it('step 3: passing skill exits with code 0', () => {
    const { exitCode } = runCli(['--json', FIXTURE_DIR]);
    assert.equal(exitCode, 0);
  });

  it('step 4: failing skill exits with code 1', () => {
    // Create a skill missing SKILL.md
    const dir = join(tmpDir, 'bad-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'name: bad\nversion: 1.0.0\ndescription: Bad\nauthor:\n  name: T\n  github: t\ncapabilities:\n  required: []\n');
    // No SKILL.md — should fail

    const { exitCode, stdout } = runCli([dir]);
    assert.equal(exitCode, 1, `Expected exit code 1 for failing skill, got: ${exitCode}`);
  });
});
