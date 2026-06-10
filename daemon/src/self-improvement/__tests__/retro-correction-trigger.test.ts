/**
 * Tests for the comms-correction retro trigger (Round 3, Fix E):
 *
 * 1. shouldTriggerRetro consumes retro.triggers.on_correction — a task whose
 *    comms_outcome is 'corrected' or 'redirected' now triggers a retro
 *    (previously the config knob existed but was never read).
 * 2. spawnRetro embeds the structured extract-from-delta signal in the
 *    retro prompt ("Outcome delta: ..." line).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import {
  shouldTriggerRetro,
  spawnRetro,
  _setSpawnFnForTesting,
  _setProfilesDirForTesting,
} from '../retro-evaluator.js';

// ── Helpers ──────────────────────────────────────────────────

const RETRO_PROFILE_MD = `---
name: retro
description: Post-task retrospective worker
tools: [Read, Grep]
disallowedTools: [Bash, Edit, Write, NotebookEdit]
model: haiku
permissionMode: bypassPermissions
maxTurns: 8
---

You are a retrospective analysis worker.
`;

interface TaskShape {
  id: number;
  external_id: string;
  title: string;
  description: string | null;
  status: string;
  result: string | null;
  error: string | null;
  retry_count: number;
  outcome: string | null;
  outcome_notes: string | null;
  outcome_reason: string | null;
  comms_outcome?: string | null;
  comms_corrections?: string | null;
  created_at: string;
  completed_at: string | null;
}

function makeTask(overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id: 7,
    external_id: 'cccccccc-0000-4000-8000-000000000007',
    title: 'Correction trigger test task',
    description: null,
    status: 'completed',
    result: 'Orch reported success',
    error: null,
    retry_count: 0,
    outcome: null,
    outcome_notes: null,
    outcome_reason: null,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

function writeConfig(tmpDir: string, lines: string[]): void {
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), lines.join('\n') + '\n');
  loadConfig(tmpDir);
}

let tmpDir: string;

beforeEach(() => {
  _resetConfigForTesting();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-correction-'));
});

afterEach(() => {
  _setSpawnFnForTesting(null);
  _setProfilesDirForTesting(null);
  _resetConfigForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1. shouldTriggerRetro: on_correction consumption ─────────

describe('shouldTriggerRetro: comms correction trigger', () => {
  it('triggers when comms_outcome is corrected (on_correction default true)', () => {
    writeConfig(tmpDir, ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true']);
    assert.equal(shouldTriggerRetro(makeTask({ comms_outcome: 'corrected' })), true);
  });

  it('triggers when comms_outcome is redirected', () => {
    writeConfig(tmpDir, ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true']);
    assert.equal(shouldTriggerRetro(makeTask({ comms_outcome: 'redirected' })), true);
  });

  it('does not trigger when comms_outcome is accepted', () => {
    writeConfig(tmpDir, ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true']);
    assert.equal(shouldTriggerRetro(makeTask({ comms_outcome: 'accepted' })), false);
  });

  it('does not trigger on corrected when on_correction is disabled', () => {
    writeConfig(tmpDir, [
      'self_improvement:',
      '  enabled: true',
      '  retro:',
      '    enabled: true',
      '    triggers:',
      '      on_correction: false',
    ]);
    assert.equal(shouldTriggerRetro(makeTask({ comms_outcome: 'corrected' })), false);
  });

  it('does not trigger when comms_outcome is unset and no other signal exists', () => {
    writeConfig(tmpDir, ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true']);
    assert.equal(shouldTriggerRetro(makeTask()), false);
  });
});

// ── 2. spawnRetro: delta wiring in prompt ────────────────────

describe('spawnRetro: extract-from-delta signal in prompt', () => {
  let capturedPrompt: string | undefined;

  beforeEach(() => {
    const profilesDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(profilesDir);
    fs.writeFileSync(path.join(profilesDir, 'retro.md'), RETRO_PROFILE_MD);
    writeConfig(tmpDir, ['self_improvement:', '  enabled: true', '  retro:', '    enabled: true']);
    _setProfilesDirForTesting(profilesDir);

    capturedPrompt = undefined;
    _setSpawnFnForTesting((req) => {
      capturedPrompt = req.prompt;
      return Promise.resolve({ jobId: 'mock-retro-job', status: 'running' as const });
    });
  });

  it('embeds a HIGH delta signal when orch completed but comms corrected', async () => {
    await spawnRetro(makeTask({
      comms_outcome: 'corrected',
      comms_corrections: '{"note":"numbers were wrong"}',
    }));

    assert.ok(capturedPrompt, 'spawn was called');
    assert.ok(capturedPrompt!.includes('Outcome delta:'), 'prompt has delta line');
    assert.ok(capturedPrompt!.includes('[Delta signal: HIGH]'), 'delta marked HIGH');
    assert.ok(
      capturedPrompt!.includes('numbers were wrong'),
      'delta includes correction detail',
    );
  });

  it('reports no delta when comms_outcome is unset', async () => {
    await spawnRetro(makeTask());

    assert.ok(capturedPrompt, 'spawn was called');
    assert.ok(
      capturedPrompt!.includes('Outcome delta: (none detected)'),
      'prompt reports no delta',
    );
  });
});
