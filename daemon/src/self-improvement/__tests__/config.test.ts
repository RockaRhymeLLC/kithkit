/**
 * Tests for self-improvement config accessor.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { getSelfImprovementConfig } from '../config.js';

describe('getSelfImprovementConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-si-config-'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns enabled=true when no config files exist', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.enabled, true);
  });

  it('returns retro enabled by default, other subsystems disabled', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.retro.enabled, true);
    assert.equal(si.transcript_review.enabled, false);
    assert.equal(si.correction_trigger.enabled, false);
    assert.equal(si.pre_task_injection.enabled, false);
    assert.equal(si.memory_sync.enabled, false);
  });

  it('returns correct default values for retro triggers', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.retro.triggers.on_error, true);
    assert.equal(si.retro.triggers.on_correction, true);
    assert.equal(si.retro.triggers.on_retry, true);
    assert.equal(si.retro.max_learnings_per_retro, 5);
  });

  it('returns correct default values for transcript_review', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.transcript_review.interval_actions, 25);
    assert.equal(si.transcript_review.interval_minutes, 30);
    assert.equal(si.transcript_review.max_learnings_per_review, 3);
  });

  it('returns correct default values for pre_task_injection', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.pre_task_injection.max_memories_injected, 10);
    assert.equal(si.pre_task_injection.min_relevance_score, 0.4);
  });

  it('returns correct default lifecycle values', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.lifecycle.consolidation_threshold, 0.85);
    assert.equal(si.lifecycle.category_cap, 50);
    assert.equal(si.lifecycle.decay['default'], '30d');
    assert.equal(si.lifecycle.decay['short'], '7d');
    assert.equal(si.lifecycle.decay['evergreen'], 'never');
  });

  it('returns empty peers array by default', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.deepEqual(si.memory_sync.peers, []);
  });

  it('user config enabled=false overrides default', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: false\n',
    );
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.enabled, false);
    // Other defaults still present
    assert.equal(si.retro.enabled, true);
  });

  it('user config partial override merges with defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'self_improvement:',
        '  enabled: true',
        '  retro:',
        '    enabled: true',
        '    max_learnings_per_retro: 10',
      ].join('\n') + '\n',
    );
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.enabled, true);
    assert.equal(si.retro.enabled, true);
    assert.equal(si.retro.max_learnings_per_retro, 10);
    // Unchanged defaults preserved
    assert.equal(si.retro.triggers.on_error, true);
    assert.equal(si.transcript_review.enabled, false);  // transcript_review default is still false
    assert.equal(si.pre_task_injection.max_memories_injected, 10);
  });

  it('user config can set peers list', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'self_improvement:',
        '  memory_sync:',
        '    enabled: true',
        '    peers: [bmo, r2]',
      ].join('\n') + '\n',
    );
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.memory_sync.enabled, true);
    assert.deepEqual(si.memory_sync.peers, ['bmo', 'r2']);
  });

  it('missing self_improvement section returns all defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: TestAgent\n',
    );
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    assert.equal(si.enabled, true);
    assert.equal(si.retro.enabled, true);
    assert.equal(si.lifecycle.consolidation_threshold, 0.85);
    assert.equal(si.lifecycle.category_cap, 50);
  });

  it('getSelfImprovementConfig returns a typed object with all required fields', () => {
    loadConfig(tmpDir);
    const si = getSelfImprovementConfig();
    // Verify all top-level fields are present
    assert.ok('enabled' in si);
    assert.ok('retro' in si);
    assert.ok('transcript_review' in si);
    assert.ok('correction_trigger' in si);
    assert.ok('pre_task_injection' in si);
    assert.ok('memory_sync' in si);
    assert.ok('lifecycle' in si);
    // Verify nested fields
    assert.ok('triggers' in si.retro);
    assert.ok('on_error' in si.retro.triggers);
    assert.ok('decay' in si.lifecycle);
  });
});
