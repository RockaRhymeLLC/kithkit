/**
 * Tests for the transcript-review PostToolUse hook (Story 5).
 *
 * These are structural/behavioral tests — they verify the hook script,
 * prompt template, and settings wiring without requiring a running daemon.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Project root is four levels up from daemon/dist/self-improvement/__tests__/
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../../');
const HOOK_SCRIPT = path.join(PROJECT_ROOT, '.claude/hooks/transcript-review.sh');
const PROMPT_TEMPLATE = path.join(PROJECT_ROOT, '.claude/hooks/transcript-review-prompt.md');
const SETTINGS_FILE = path.join(PROJECT_ROOT, '.claude/settings.json');

const COUNTER_FILE = '/tmp/kithkit-transcript-review-counter';
const LAST_FILE = '/tmp/kithkit-transcript-review-last';

function cleanTempFiles() {
  for (const f of [COUNTER_FILE, LAST_FILE]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

/** Run the hook with fake input, returns exit code */
function runHook(extraEnv: Record<string, string> = {}): number {
  const input = JSON.stringify({ transcript_path: '' });
  const result = spawnSync('bash', [HOOK_SCRIPT], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return result.status ?? 1;
}

// ── Test 1: Script exists and is executable ───────────────────────────────────

describe('transcript-review hook: file existence and permissions', () => {
  it('hook script exists', () => {
    assert.ok(fs.existsSync(HOOK_SCRIPT), `Hook script not found at ${HOOK_SCRIPT}`);
  });

  it('hook script is executable', () => {
    const stat = fs.statSync(HOOK_SCRIPT);
    const executable = (stat.mode & 0o111) !== 0;
    assert.ok(executable, 'Hook script is not executable');
  });

  it('prompt template exists', () => {
    assert.ok(fs.existsSync(PROMPT_TEMPLATE), `Prompt template not found at ${PROMPT_TEMPLATE}`);
  });
});

// ── Test 2: Counter increments on each invocation ────────────────────────────

describe('transcript-review hook: counter management', () => {
  beforeEach(() => {
    cleanTempFiles();
    // Set last-review to NOW so time threshold does not trigger
    fs.writeFileSync(LAST_FILE, String(Math.floor(Date.now() / 1000)));
  });

  afterEach(() => {
    cleanTempFiles();
  });

  it('counter file is created and incremented on first call', () => {
    // Counter file does not exist yet — hook should create it with value 1
    runHook();
    assert.ok(fs.existsSync(COUNTER_FILE), 'Counter file was not created');
    const value = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    assert.equal(value, 1, `Expected counter=1, got ${value}`);
  });

  it('counter increments on successive calls below threshold', () => {
    fs.writeFileSync(COUNTER_FILE, '5');
    runHook();
    const value = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    assert.equal(value, 6, `Expected counter=6, got ${value}`);
  });
});

// ── Test 3: Threshold logic ───────────────────────────────────────────────────

describe('transcript-review hook: threshold triggering', () => {
  beforeEach(() => {
    cleanTempFiles();
  });

  afterEach(() => {
    cleanTempFiles();
  });

  it('counter resets to 0 when action threshold (25) is reached', () => {
    // Set counter to 24 (one below threshold) and last to NOW (disable time threshold)
    fs.writeFileSync(COUNTER_FILE, '24');
    fs.writeFileSync(LAST_FILE, String(Math.floor(Date.now() / 1000)));

    runHook();

    // Counter becomes 25, threshold met → reset to 0 before daemon check
    const value = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    assert.equal(value, 0, `Expected counter=0 after reset, got ${value}`);
  });

  it('counter resets when time threshold is met (no last-review file)', () => {
    // No LAST_FILE means elapsed = NOW - 0 = very large (always exceeds 1800s)
    fs.writeFileSync(COUNTER_FILE, '1');
    // Do NOT create LAST_FILE

    runHook();

    // Time threshold triggered → counter reset to 0
    const value = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
    assert.equal(value, 0, `Expected counter=0 after time reset, got ${value}`);
  });

  it('hook script contains ACTION_THRESHOLD=25', () => {
    const content = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.ok(
      content.includes('ACTION_THRESHOLD=25'),
      'Hook script does not define ACTION_THRESHOLD=25',
    );
  });

  it('hook script contains TIME_THRESHOLD_SECS=1800', () => {
    const content = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.ok(
      content.includes('TIME_THRESHOLD_SECS=1800'),
      'Hook script does not define TIME_THRESHOLD_SECS=1800',
    );
  });
});

// ── Test 4: Prompt template content ──────────────────────────────────────────

describe('transcript-review prompt template: required sections', () => {
  let content: string;

  beforeEach(() => {
    content = fs.readFileSync(PROMPT_TEMPLATE, 'utf8');
  });

  it('contains instructions about reading the transcript', () => {
    assert.ok(
      content.includes('transcript') || content.includes('Transcript'),
      'Prompt template does not mention transcript',
    );
  });

  it('contains classification categories', () => {
    const required = ['api-format', 'behavioral', 'process', 'tool-usage', 'communication'];
    for (const cat of required) {
      assert.ok(content.includes(cat), `Prompt template missing category: ${cat}`);
    }
  });

  it('mentions max 3 learnings rate limit', () => {
    assert.ok(
      content.includes('3') && (content.includes('learning') || content.includes('Learning')),
      'Prompt template does not specify max-3 learnings limit',
    );
  });

  it('references /api/memory/store endpoint', () => {
    assert.ok(
      content.includes('/api/memory/store'),
      'Prompt template does not reference /api/memory/store',
    );
  });

  it('specifies trigger: transcript field', () => {
    assert.ok(
      content.includes('trigger') && content.includes('transcript'),
      'Prompt template does not specify trigger=transcript',
    );
  });

  it('specifies origin_agent placeholder field', () => {
    assert.ok(
      content.includes('origin_agent') && content.includes('{{AGENT_NAME}}'),
      'Prompt template does not specify origin_agent={{AGENT_NAME}} placeholder',
    );
  });

  it('specifies dedup: true', () => {
    assert.ok(content.includes('dedup'), 'Prompt template does not mention dedup');
  });
});

// ── Test 5: settings.json hook registration ───────────────────────────────────

describe('transcript-review hook: settings.json registration', () => {
  it('settings.json is valid JSON', () => {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'settings.json is not valid JSON');
  });

  it('PostToolUse array contains transcript-review.sh', () => {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
    const hooks = settings['hooks'] as Record<string, unknown>;
    assert.ok(hooks, 'settings.json has no "hooks" key');

    const postToolUse = hooks['PostToolUse'] as Array<{ hooks: Array<{ command?: string }> }>;
    assert.ok(Array.isArray(postToolUse), 'PostToolUse is not an array');

    const allCommands = postToolUse.flatMap((entry) =>
      (entry.hooks ?? []).map((h) => h.command ?? ''),
    );

    const registered = allCommands.some((cmd) => cmd.includes('transcript-review.sh'));
    assert.ok(registered, 'transcript-review.sh is not registered in PostToolUse hooks');
  });
});
