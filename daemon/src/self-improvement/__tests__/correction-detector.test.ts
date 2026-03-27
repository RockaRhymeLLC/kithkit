/**
 * Tests for the correction-detector.sh hook.
 *
 * Covers:
 * - Pattern detection (positive cases)
 * - Non-firing on benign messages (negative cases)
 * - File existence and executable bit
 * - settings.json registration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const HOOK_PATH = path.join(PROJECT_ROOT, '.kithkit/hooks/correction-detector.sh');
const SETTINGS_PATH = path.join(PROJECT_ROOT, '.claude/settings.json');

/**
 * Run the hook script with a given prompt string and return the exit code.
 * Passes an empty KITHKIT_DAEMON_URL so the daemon health check always fails
 * (we just want to test the pattern-detection logic, not the curl call).
 *
 * The hook reads JSON from stdin: { "prompt": "..." }
 */
function runHook(prompt: string): { exitCode: number; output: string } {
  const input = JSON.stringify({ prompt });
  const result = spawnSync('bash', [HOOK_PATH], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Point to a nonexistent daemon so the curl health check fails fast
      KITHKIT_DAEMON_URL: 'http://127.0.0.1:1',
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    timeout: 5000,
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}

/**
 * Check whether the hook would detect a correction pattern.
 * We do this by inspecting whether the pattern grep would match,
 * using the same regex the hook uses.
 */
function patternMatches(prompt: string): boolean {
  const result = spawnSync(
    'grep',
    ['-iqE', '(^|[^a-z])(no, |no that|no the|that is wrong|thats wrong|that was wrong|thats not right|actually, |actually it is|actually the|incorrect|not right|wrong)', '-'],
    {
      input: prompt,
      encoding: 'utf8',
      timeout: 2000,
    },
  );
  // grep exits 0 = match found, 1 = no match
  return result.status === 0;
}

// ── Pattern detection tests ────────────────────────────────────────────────

describe('correction-detector: pattern matching', () => {
  it('detects "no, that is wrong" pattern', () => {
    assert.ok(patternMatches('No, that is wrong. The value should be 42.'));
  });

  it('detects "actually it is" pattern', () => {
    assert.ok(patternMatches('Actually it is the other way around.'));
  });

  it('detects "thats incorrect" pattern', () => {
    assert.ok(patternMatches("That's incorrect, you need to call init() first."));
  });

  it('detects standalone "wrong" in a correction context', () => {
    assert.ok(patternMatches('You are wrong about the API endpoint.'));
  });

  it('detects "actually, " with comma', () => {
    assert.ok(patternMatches('Actually, the default is false.'));
  });

  it('detects "not right"', () => {
    assert.ok(patternMatches('That is not right, check the docs.'));
  });

  it('detects "no that"', () => {
    assert.ok(patternMatches('No that version is deprecated.'));
  });

  it('detects "thats not right"', () => {
    assert.ok(patternMatches("Thats not right, you should use async/await."));
  });
});

// ── Negative cases ─────────────────────────────────────────────────────────

describe('correction-detector: no false positives', () => {
  it('does not fire on "yes that looks good"', () => {
    assert.equal(patternMatches('yes that looks good'), false);
  });

  it('does not fire on "no problem"', () => {
    assert.equal(patternMatches('no problem'), false);
  });

  it('does not fire on a routine task description', () => {
    assert.equal(patternMatches('Please add a button to the settings page'), false);
  });

  it('does not fire on empty string', () => {
    assert.equal(patternMatches(''), false);
  });
});

// ── File validation tests ──────────────────────────────────────────────────

describe('correction-detector: file existence and permissions', () => {
  it('hook script exists', () => {
    assert.ok(fs.existsSync(HOOK_PATH), `Expected ${HOOK_PATH} to exist`);
  });

  it('hook script is executable', () => {
    const stat = fs.statSync(HOOK_PATH);
    // Check owner execute bit (S_IXUSR = 0o100)
    const isExecutable = (stat.mode & 0o100) !== 0;
    assert.ok(isExecutable, `Expected ${HOOK_PATH} to be executable`);
  });
});

// ── settings.json registration ─────────────────────────────────────────────

describe('correction-detector: settings.json registration', () => {
  it('settings.json has the hook registered in UserPromptSubmit', () => {
    assert.ok(fs.existsSync(SETTINGS_PATH), 'settings.json must exist');

    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const hooks = settings['hooks'] as Record<string, unknown> | undefined;
    assert.ok(hooks, 'settings.json must have a hooks section');

    const ups = hooks['UserPromptSubmit'] as Array<{ hooks: Array<{ command: string }> }> | undefined;
    assert.ok(Array.isArray(ups), 'UserPromptSubmit must be an array');

    const allCommands = ups.flatMap((entry) => entry.hooks.map((h) => h.command));
    const hasHook = allCommands.some((cmd) => cmd.includes('correction-detector.sh'));
    assert.ok(hasHook, 'correction-detector.sh must be registered in UserPromptSubmit');
  });
});
