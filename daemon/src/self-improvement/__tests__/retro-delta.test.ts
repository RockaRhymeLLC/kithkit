/**
 * Retro pipeline delta detection test (Q2).
 *
 * Verifies that:
 *   1. detectDelta returns null when comms_outcome is not set.
 *   2. 'corrected' comms_outcome → HIGH signal delta when result is present.
 *   3. 'redirected' comms_outcome → HIGH signal delta.
 *   4. 'cancelled' comms_outcome → MEDIUM signal when result present, LOW when absent.
 *   5. 'accepted' with no corrections → signal='none', no lesson surfaced.
 *   6. 'accepted' with corrections → LOW signal lesson.
 *   7. extractDeltaLesson returns null for 'none' signal, string for meaningful deltas.
 *   8. shouldTriggerRetro respects generate_retro=1 per-task flag (Q2).
 *   9. shouldTriggerRetro respects retro_all_terminal global config knob (Q2).
 *  10. Retro prompt includes BOTH result and comms_outcome/corrections.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import { detectDelta, extractDeltaLesson } from '../retro/extract-from-delta.js';
import { shouldTriggerRetro, spawnRetro, _setSpawnFnForTesting, _setProfilesDirForTesting } from '../retro-evaluator.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import type { JobStatus } from '../../agents/lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Partial<{
  id: string;
  title: string;
  description: string | null;
  status: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  outcome: string | null;
  outcome_notes: string | null;
  comms_outcome: string | null;
  comms_corrections: string | null;
  generate_retro: number | null;
  created_at: string;
  completed_at: string | null;
}> = {}) {
  return {
    id: 'task-delta-1',
    title: 'Delta test task',
    description: null,
    status: 'completed',
    result: 'Task completed successfully',
    error: null,
    retry_count: 0,
    outcome: null,
    outcome_notes: null,
    comms_outcome: null,
    comms_corrections: null,
    generate_retro: null,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

const RETRO_PROFILE_MD = `---
name: retro
description: Post-task retrospective analysis worker
tools: [Read, Grep]
disallowedTools: [Bash, Edit, Write, NotebookEdit]
model: haiku
permissionMode: bypassPermissions
maxTurns: 15
---

You are a retrospective analysis worker.
`;

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-delta-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  _resetConfigForTesting();

  // Write a config with self_improvement enabled
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'self_improvement:',
      '  enabled: true',
      '  retro:',
      '    enabled: true',
      '    retro_all_terminal: false',
    ].join('\n') + '\n',
  );
  loadConfig(tmpDir);

  // Write a fake retro profile
  const profilesDir = path.join(tmpDir, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'retro.md'), RETRO_PROFILE_MD);
  _setProfilesDirForTesting(profilesDir);
});

after(() => {
  _setSpawnFnForTesting(null);
  _setProfilesDirForTesting(null);
  _resetDbForTesting();
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── detectDelta tests ─────────────────────────────────────────

describe('detectDelta — delta detection between orch result and comms outcome', () => {
  it('1. returns null when comms_outcome is null (not yet acknowledged)', () => {
    const result = detectDelta({ result: 'done', comms_outcome: null, comms_corrections: null });
    assert.equal(result, null);
  });

  it('2. corrected + result → HIGH signal, diverged=true', () => {
    const result = detectDelta({
      result: 'I completed the task',
      comms_outcome: 'corrected',
      comms_corrections: '{"field":"corrected value"}',
    });
    assert.ok(result, 'Should return a delta lesson');
    assert.equal(result?.signal, 'high');
    assert.equal(result?.diverged, true);
    assert.ok(result?.description.includes('corrected'));
  });

  it('3. redirected + result → HIGH signal, diverged=true', () => {
    const result = detectDelta({
      result: 'done',
      comms_outcome: 'redirected',
      comms_corrections: null,
    });
    assert.ok(result);
    assert.equal(result?.signal, 'high');
    assert.equal(result?.diverged, true);
    assert.ok(result?.description.includes('redirected'));
  });

  it('4a. cancelled + result present → MEDIUM signal, diverged=true', () => {
    const result = detectDelta({ result: 'some work', comms_outcome: 'cancelled', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'medium');
    assert.equal(result?.diverged, true);
  });

  it('4b. cancelled + no result → LOW signal, diverged=false', () => {
    const result = detectDelta({ result: null, comms_outcome: 'cancelled', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'low');
    assert.equal(result?.diverged, false);
  });

  it('5. accepted + no corrections → signal=none, diverged=false', () => {
    const result = detectDelta({ result: 'done', comms_outcome: 'accepted', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'none');
    assert.equal(result?.diverged, false);
  });

  it('6. accepted + corrections → LOW signal', () => {
    const result = detectDelta({
      result: 'done',
      comms_outcome: 'accepted',
      comms_corrections: '{"minor":"fix"}',
    });
    assert.ok(result);
    assert.equal(result?.signal, 'low');
  });
});

// ── extractDeltaLesson tests ──────────────────────────────────

describe('extractDeltaLesson — convenience wrapper for retro prompt inclusion', () => {
  it('7a. returns null for signal=none', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'accepted', comms_corrections: null });
    assert.equal(lesson, null);
  });

  it('7b. returns null when comms_outcome is null', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: null, comms_corrections: null });
    assert.equal(lesson, null);
  });

  it('7c. returns a non-null string for HIGH signal', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'corrected', comms_corrections: null });
    assert.ok(typeof lesson === 'string', 'Should return a string');
    assert.ok(lesson.includes('[Delta signal: HIGH]'), `Expected HIGH prefix in: ${lesson}`);
  });

  it('7d. returned string contains description', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'redirected', comms_corrections: null });
    assert.ok(lesson?.includes('redirected'), 'Lesson should describe the redirection');
  });
});

// ── shouldTriggerRetro with Q2 fields ────────────────────────

describe('shouldTriggerRetro — Q2 generate_retro and retro_all_terminal', () => {
  it('8. generate_retro=1 triggers retro even without error/retry signals', () => {
    const task = makeTask({ error: null, retry_count: 0, generate_retro: 1 });
    const result = shouldTriggerRetro(task);
    assert.equal(result, true, 'generate_retro=1 should trigger retro');
  });

  it('8b. generate_retro=0 with no signals does NOT trigger retro', () => {
    const task = makeTask({ error: null, retry_count: 0, generate_retro: 0 });
    const result = shouldTriggerRetro(task);
    assert.equal(result, false, 'generate_retro=0 with no signals should not trigger');
  });

  it('9. retro_all_terminal=true triggers retro on all terminal tasks', () => {
    // Write config with retro_all_terminal=true
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'self_improvement:',
        '  enabled: true',
        '  retro:',
        '    enabled: true',
        '    retro_all_terminal: true',
      ].join('\n') + '\n',
    );
    // Must reset cached config before reloading so loadConfig picks up the new file.
    _resetConfigForTesting();
    loadConfig(tmpDir);

    const task = makeTask({ error: null, retry_count: 0, generate_retro: null });
    const result = shouldTriggerRetro(task);
    assert.equal(result, true, 'retro_all_terminal=true should trigger retro on all tasks');

    // Restore
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'self_improvement:',
        '  enabled: true',
        '  retro:',
        '    enabled: true',
        '    retro_all_terminal: false',
      ].join('\n') + '\n',
    );
    _resetConfigForTesting();
    loadConfig(tmpDir);
  });
});

// ── Retro prompt includes both result and comms fields ────────

describe('spawnRetro — prompt includes comms_outcome and comms_corrections (Q2)', () => {
  it('10. spawned retro prompt contains both orch result and comms_outcome', async () => {
    const captured: { prompt: string }[] = [];

    // Mock spawn function to capture the prompt
    _setSpawnFnForTesting(async (req) => {
      captured.push({ prompt: req.prompt });
      return { jobId: 'mock-job-id', status: 'queued' as JobStatus };
    });

    const task = makeTask({
      result: 'Task completed by orch',
      comms_outcome: 'corrected',
      comms_corrections: '{"detail":"user said it was wrong"}',
    });

    await spawnRetro(task);

    assert.equal(captured.length, 1, 'Spawn function should have been called once');
    const prompt = captured[0]!.prompt;
    assert.ok(prompt.includes('Task completed by orch'), 'Prompt should include orch result');
    assert.ok(prompt.includes('corrected'), 'Prompt should include comms_outcome');
    assert.ok(prompt.includes('user said it was wrong'), 'Prompt should include comms_corrections');
    // [Delta signal: HIGH] prefix is added by Skippy-local extractDeltaLesson wiring in
    // retro-evaluator. The upstream retro-evaluator includes comms fields in the prompt
    // but does not yet call extractDeltaLesson. Wiring is deferred to a follow-up PR.
  });
});
