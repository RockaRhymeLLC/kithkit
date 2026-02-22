/**
 * t-206: Session bridge supports multiple named sessions
 * t-207: Session bridge uses default session from config
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import {
  sessionExists,
  capturePane,
  isSessionBusy,
  injectText,
  getNewestTranscript,
  _testHelpers,
  _resetForTesting,
} from '../core/session-bridge.js';

describe('Session bridge multi-session (t-206)', () => {
  let tmpDir: string;

  afterEach(() => {
    _resetConfigForTesting();
    _resetForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sessionExists returns false for nonexistent session', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    assert.equal(sessionExists('nonexistent-session-xyz'), false);
  });

  it('sessionExists accepts named session parameter', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    // Both named and default calls should work without errors
    assert.equal(sessionExists('some-other-session'), false);
    assert.equal(sessionExists(), false);
  });

  it('capturePane returns empty string for nonexistent session', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    const result = capturePane('nonexistent-session-xyz');
    assert.equal(result, '');
  });

  it('isSessionBusy always returns false', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    assert.equal(isSessionBusy(), false);
    assert.equal(isSessionBusy('any-session'), false);
  });

  it('injectText returns false when session does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-sb-agent\n',
    );
    loadConfig(tmpDir);
    const result = injectText('hello', { name: 'nonexistent-session-xyz' });
    assert.equal(result, false);
  });

  it('getTranscriptDir mangles path correctly', () => {
    const dir = _testHelpers.getTranscriptDir('/Users/someone/my_project');
    const expected = path.join(os.homedir(), '.claude', 'projects', '-Users-someone-my-project');
    assert.equal(dir, expected);
  });
});

describe('Session bridge default session from config (t-207)', () => {
  let tmpDir: string;

  afterEach(() => {
    _resetConfigForTesting();
    _resetForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to agent name from config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    // sessionExists() with no arg should not throw and should use config name
    const result = sessionExists();
    assert.equal(typeof result, 'boolean');
  });

  it('capturePane defaults to agent name from config', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const result = capturePane();
    assert.equal(typeof result, 'string');
  });

  it('getNewestTranscript returns null when no transcripts exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const result = getNewestTranscript();
    assert.equal(result, null);
  });

  it('operations complete within 500ms', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sb-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: my-test-agent\n',
    );
    loadConfig(tmpDir);

    const start = Date.now();
    sessionExists();
    capturePane();
    isSessionBusy();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Operations took ${elapsed}ms, expected < 500ms`);
  });
});
