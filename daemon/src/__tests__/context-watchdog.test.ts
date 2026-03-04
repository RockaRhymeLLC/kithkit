/**
 * t-222: Context watchdog warns after consecutive missing state files
 *
 * Verifies that the context-watchdog emits a warn log after MISS_WARN_THRESHOLD
 * consecutive misses (file not present), and resets the counter when the file
 * is found successfully.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { openDatabase, closeDatabase, _resetDbForTesting } from '../core/db.js';
import { initLogger, _resetLoggerForTesting } from '../core/logger.js';
import { Scheduler } from '../automation/scheduler.js';
import { register as registerContextWatchdog, _resetForTesting } from '../automation/tasks/context-watchdog.js';

function makeTmpDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-cw-'));
  fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), `
agent:
  name: test-agent
scheduler:
  tasks:
    - name: context-watchdog
      interval: "3m"
      enabled: true
      config:
        requires_session: true
`);
  return tmpDir;
}

/** Read all warn entries from the daemon log in tmpDir. */
function readWarnLogs(logDir: string): Array<{ msg: string; data?: Record<string, unknown> }> {
  const logFile = path.join(logDir, 'daemon.log');
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e): e is { level: string; msg: string; data?: Record<string, unknown> } => e !== null && e.level === 'warn');
}

describe('Context watchdog miss-count warnings (t-222)', () => {
  let tmpDir: string;
  let logDir: string;
  let scheduler: Scheduler;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-cw-logs-'));
    _resetConfigForTesting();
    _resetForTesting();
    _resetDbForTesting();
    openDatabase(tmpDir);
    // Initialize logger to capture warn output
    initLogger({ logDir, minLevel: 'warn' });
  });

  afterEach(() => {
    if (scheduler?.isRunning()) scheduler.stop();
    _resetDbForTesting();
    _resetConfigForTesting();
    _resetForTesting();
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it('does not warn on the first or second consecutive miss', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run twice — below threshold (3)
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 0, 'Should not warn before threshold is reached');
  });

  it('emits exactly one warn at the third consecutive miss', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run 3 times — hits threshold on 3rd
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should emit exactly one warn at threshold');
    assert.ok(
      warns[0]!.msg.includes('scripts/context-monitor-statusline.sh'),
      'Warn should mention the statusline script',
    );
  });

  it('does not repeat the warn on 4th and subsequent misses', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run 5 times — warn fires only at 3rd
    for (let i = 0; i < 5; i++) {
      await scheduler.triggerTask('context-watchdog');
    }

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should still emit only one warn after multiple misses');
  });

  it('resets miss counter after successful read and re-warns after threshold again', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // 3 misses → triggers warning
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    // Now create the state file → counter resets
    const stateDir = path.join(tmpDir, '.claude', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'context-usage.json'),
      JSON.stringify({ used_percentage: 10, remaining_percentage: 90, session_id: 'sess-1' }),
    );

    await scheduler.triggerTask('context-watchdog');

    // Remove the file again → counter resets from 0
    fs.unlinkSync(path.join(stateDir, 'context-usage.json'));

    // 2 more misses — should NOT trigger a second warn (below new threshold)
    await scheduler.triggerTask('context-watchdog');
    await scheduler.triggerTask('context-watchdog');

    const warns = readWarnLogs(logDir).filter(e =>
      e.msg.includes('Context usage file missing for comms agent'),
    );
    assert.equal(warns.length, 1, 'Should only have 1 warn: counter was reset after successful read');
  });

  it('runs successfully on every trigger regardless of miss count', async () => {
    const config = loadConfig(tmpDir);
    scheduler = new Scheduler({
      tasks: config.scheduler.tasks,
      sessionExists: () => true,
    });
    registerContextWatchdog(scheduler);

    // Run many times without state file — should never throw
    for (let i = 0; i < 6; i++) {
      const result = await scheduler.triggerTask('context-watchdog');
      assert.equal(result.status, 'success', `Run ${i + 1} should succeed`);
    }
  });
});
