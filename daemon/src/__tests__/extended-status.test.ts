/**
 * t-211: Extended status aggregates ops data
 * t-212: Extension health checks register and execute
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { initLogger } from '../core/logger.js';
import {
  registerCheck,
  getRegisteredChecks,
  getExtendedHealth,
  getExtendedStatus,
  formatHealthText,
  _resetForTesting,
} from '../core/extended-status.js';

const VERSION = '0.1.0';

describe('Extended status aggregates ops data (t-211)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-es-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n',
    );
    loadConfig(tmpDir);
    initLogger({ logDir: path.join(tmpDir, 'logs'), minLevel: 'error' });
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns extended status with all sections', async () => {
    const status = await getExtendedStatus(VERSION);

    // daemon section
    assert.ok(status.daemon);
    assert.equal(typeof status.daemon.uptime, 'number');
    assert.equal(status.daemon.version, VERSION);
    assert.equal(typeof status.daemon.pid, 'number');
    assert.equal(typeof status.daemon.memoryMB, 'number');

    // db section
    assert.ok(status.db);
    assert.equal(status.db.ok, true);
    assert.equal(typeof status.db.tables, 'number');
    assert.ok(status.db.tables > 0, 'Should have tables from migrations');

    // scheduler section
    assert.ok(status.scheduler);
    assert.ok(Array.isArray(status.scheduler.recentResults));

    // checks section
    assert.ok(status.checks);
    assert.ok(status.checks['daemon']);
    assert.ok(status.checks['database']);

    // timestamp
    assert.ok(status.timestamp);
    assert.ok(!isNaN(Date.parse(status.timestamp)));
  });

  it('db section includes todo and memory counts', async () => {
    const status = await getExtendedStatus(VERSION);
    assert.equal(typeof status.db.todoCount, 'number');
    assert.equal(typeof status.db.memoryCount, 'number');
  });

  it('extended health includes base checks', async () => {
    const health = await getExtendedHealth(VERSION);
    assert.ok(health.checks['daemon']);
    assert.equal(health.checks['daemon'].ok, true);
    assert.ok(health.checks['database']);
    assert.equal(health.checks['database'].ok, true);
    assert.equal(health.status, 'ok');
  });
});

describe('Extension health checks register and execute (t-212)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-es-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n',
    );
    loadConfig(tmpDir);
    initLogger({ logDir: path.join(tmpDir, 'logs'), minLevel: 'error' });
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetForTesting();
    _resetDbForTesting();
    _resetConfigForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registerCheck adds custom health check', () => {
    registerCheck('test-service', async () => ({ ok: true }));
    const checks = getRegisteredChecks();
    assert.ok(checks.includes('test-service'));
  });

  it('custom check appears in extended health', async () => {
    registerCheck('test-service', async () => ({
      ok: true,
      message: 'Service is healthy',
    }));

    const health = await getExtendedHealth(VERSION);
    assert.ok(health.checks['test-service']);
    assert.equal(health.checks['test-service'].ok, true);
    assert.equal(health.checks['test-service'].message, 'Service is healthy');
  });

  it('failing custom check sets status to degraded', async () => {
    registerCheck('broken-service', async () => ({
      ok: false,
      message: 'Connection refused',
    }));

    const health = await getExtendedHealth(VERSION);
    assert.equal(health.status, 'degraded');
    assert.equal(health.checks['broken-service'].ok, false);
  });

  it('check that throws is caught and reported', async () => {
    registerCheck('crash-service', async () => {
      throw new Error('Unexpected crash');
    });

    const health = await getExtendedHealth(VERSION);
    assert.equal(health.checks['crash-service'].ok, false);
    assert.ok(health.checks['crash-service'].message?.includes('Unexpected crash'));
  });

  it('formatHealthText produces readable output', async () => {
    registerCheck('test-service', async () => ({
      ok: true,
      message: 'All good',
    }));

    const health = await getExtendedHealth(VERSION);
    const text = formatHealthText(health);

    assert.ok(text.includes('Status: OK'));
    assert.ok(text.includes('Uptime:'));
    assert.ok(text.includes('Version: 0.1.0'));
    assert.ok(text.includes('[OK] daemon'));
    assert.ok(text.includes('[OK] test-service'));
    assert.ok(text.includes('Timestamp:'));
  });

  it('formatHealthText shows FAIL for failing checks', async () => {
    registerCheck('broken-svc', async () => ({
      ok: false,
      message: 'Down',
    }));

    const health = await getExtendedHealth(VERSION);
    const text = formatHealthText(health);

    assert.ok(text.includes('Status: DEGRADED'));
    assert.ok(text.includes('[FAIL] broken-svc'));
  });

  it('multiple checks all execute', async () => {
    registerCheck('svc-a', () => ({ ok: true }));
    registerCheck('svc-b', () => ({ ok: true, message: 'B is fine' }));
    registerCheck('svc-c', () => ({ ok: false, message: 'C is broken' }));

    const health = await getExtendedHealth(VERSION);
    assert.ok(health.checks['svc-a']);
    assert.ok(health.checks['svc-b']);
    assert.ok(health.checks['svc-c']);
    assert.equal(health.status, 'degraded'); // because svc-c failed
  });
});
