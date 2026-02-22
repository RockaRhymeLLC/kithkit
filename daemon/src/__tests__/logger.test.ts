/**
 * t-117: Logger writes structured logs with rotation
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initLogger, createLogger, _resetLoggerForTesting } from '../core/logger.js';

describe('Logger (t-117)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-logger-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates log file with structured JSON lines', () => {
    initLogger({ logDir: tmpDir, minLevel: 'info' });
    const log = createLogger('test-module');

    log.info('Hello world', { key: 'value' });
    log.warn('A warning');

    const logFile = path.join(tmpDir, 'daemon.log');
    assert.ok(fs.existsSync(logFile), 'Log file should exist');

    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const entry1 = JSON.parse(lines[0]!);
    assert.equal(entry1.level, 'info');
    assert.equal(entry1.module, 'test-module');
    assert.equal(entry1.msg, 'Hello world');
    assert.equal(entry1.data.key, 'value');
    assert.ok(entry1.ts, 'Should have timestamp');

    const entry2 = JSON.parse(lines[1]!);
    assert.equal(entry2.level, 'warn');
    assert.equal(entry2.msg, 'A warning');
  });

  it('respects minimum log level', () => {
    initLogger({ logDir: tmpDir, minLevel: 'warn' });
    const log = createLogger('test');

    log.debug('debug msg');
    log.info('info msg');
    log.warn('warn msg');
    log.error('error msg');

    const logFile = path.join(tmpDir, 'daemon.log');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const levels = lines.map(l => JSON.parse(l).level);
    assert.deepEqual(levels, ['warn', 'error']);
  });

  it('rotates log when it exceeds max size', () => {
    // Set tiny max size for testing
    _resetLoggerForTesting({ logDir: tmpDir, maxSizeMB: 0.001, maxFiles: 3 });
    const log = createLogger('rotation-test');

    // Write enough to trigger rotation (>1KB)
    for (let i = 0; i < 50; i++) {
      log.info(`Log entry ${i} with some padding to increase size ${'x'.repeat(100)}`);
    }

    const logFile = path.join(tmpDir, 'daemon.log');
    const rotatedFile = path.join(tmpDir, 'daemon.log.1');

    assert.ok(fs.existsSync(logFile), 'Current log should exist');
    assert.ok(fs.existsSync(rotatedFile), 'Rotated log should exist');
  });

  it('limits number of rotated files', () => {
    _resetLoggerForTesting({ logDir: tmpDir, maxSizeMB: 0.0005, maxFiles: 2 });
    const log = createLogger('max-files-test');

    // Write a lot to force multiple rotations
    for (let i = 0; i < 200; i++) {
      log.info(`Entry ${i} ${'x'.repeat(200)}`);
    }

    // Should have daemon.log and daemon.log.1, but NOT daemon.log.2
    assert.ok(fs.existsSync(path.join(tmpDir, 'daemon.log')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'daemon.log.1')));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'daemon.log.2')), 'Should not exceed maxFiles');
  });

  it('log entries have all required fields', () => {
    initLogger({ logDir: tmpDir });
    const log = createLogger('fields-test');
    log.error('Something broke');

    const logFile = path.join(tmpDir, 'daemon.log');
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());

    // Required fields per t-117
    assert.ok(typeof entry.ts === 'string', 'Should have timestamp');
    assert.ok(typeof entry.level === 'string', 'Should have level');
    assert.ok(typeof entry.module === 'string', 'Should have module');
    assert.ok(typeof entry.msg === 'string', 'Should have message');

    // Timestamp should be ISO 8601
    assert.ok(!isNaN(Date.parse(entry.ts)), 'Timestamp should be valid ISO date');
  });
});
