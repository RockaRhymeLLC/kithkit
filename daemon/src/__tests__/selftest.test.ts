/**
 * Tests for GET /api/selftest endpoint.
 *
 * Covers response structure, per-check field validation, and specific
 * check behaviors (daemon, database, config, identity, CLAUDE.md,
 * channel-router) that don't require external tooling to be present.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { openDatabase, _resetDbForTesting } from '../core/db.js';
import { _resetConfigForTesting, loadConfig } from '../core/config.js';
import { initLogger } from '../core/logger.js';
import { handleSelftestRoute, _setLaunchctlExecForTesting } from '../api/selftest.js';

// ── Mock HTTP helpers ────────────────────────────────────────────────────────

function createMockReq(method: string, url: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  return req;
}

type MockRes = ServerResponse & { _body: string; _status: number };

function createMockRes(): MockRes {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req) as MockRes;
  res._body = '';
  res._status = 0;

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode: number, ...args: unknown[]) {
    res._status = statusCode;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origWriteHead as any)(statusCode, ...args);
  } as typeof res.writeHead;

  const origEnd = res.end.bind(res);
  res.end = function (chunk?: unknown, ...args: unknown[]) {
    if (chunk != null) {
      res._body = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origEnd as any)(chunk, ...args);
  } as typeof res.end;

  return res;
}

// ── Shared setup ─────────────────────────────────────────────────────────────

describe('Selftest route handler', { concurrency: 1 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-selftest-'));
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n',
    );
    loadConfig(tmpDir);
    initLogger({ logDir: path.join(tmpDir, 'logs'), minLevel: 'error' });
    openDatabase(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Routing ──────────────────────────────────────────────────────────────

  it('returns false for non-matching paths', async () => {
    const req = createMockReq('GET', '/api/foo');
    const res = createMockRes();
    const handled = await handleSelftestRoute(req, res, '/api/foo');
    assert.equal(handled, false);
    assert.equal(res._status, 0, 'writeHead should not have been called');
    assert.equal(res._body, '', 'body should be empty');
  });

  it('returns false for non-GET methods on /api/selftest', async () => {
    const req = createMockReq('POST', '/api/selftest');
    const res = createMockRes();
    const handled = await handleSelftestRoute(req, res, '/api/selftest');
    assert.equal(handled, false);
    assert.equal(res._status, 0, 'writeHead should not have been called for wrong method');
  });

  // ── Response structure ────────────────────────────────────────────────────

  it('returns 200 with a valid selftest response structure', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    const handled = await handleSelftestRoute(req, res, '/api/selftest');
    assert.equal(handled, true);
    assert.equal(res._status, 200);

    const body = JSON.parse(res._body);

    // status
    assert.ok(
      typeof body.status === 'string',
      'status should be a string',
    );
    assert.ok(
      ['healthy', 'degraded', 'unhealthy'].includes(body.status),
      `status "${body.status}" should be one of healthy/degraded/unhealthy`,
    );

    // timestamp
    assert.ok(typeof body.timestamp === 'string', 'timestamp should be a string');
    assert.ok(!isNaN(Date.parse(body.timestamp)), 'timestamp should be a valid ISO date');

    // checks
    assert.ok(Array.isArray(body.checks), 'checks should be an array');

    // summary
    assert.ok(body.summary, 'summary should be present');
    assert.equal(typeof body.summary.total, 'number');
    assert.equal(typeof body.summary.pass, 'number');
    assert.equal(typeof body.summary.fail, 'number');
    assert.equal(typeof body.summary.skip, 'number');

    // summary.total === checks.length
    assert.equal(body.summary.total, body.checks.length, 'summary.total should equal checks.length');

    // pass + fail + skip === total
    assert.equal(
      body.summary.pass + body.summary.fail + body.summary.skip,
      body.summary.total,
      'pass + fail + skip should equal total',
    );
  });

  // ── Per-check field validation ────────────────────────────────────────────

  it('every check has required fields with correct types', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    assert.ok(body.checks.length > 0, 'should have at least one check');

    for (const check of body.checks) {
      assert.ok(typeof check.name === 'string' && check.name.length > 0, `check.name should be a non-empty string (got ${JSON.stringify(check.name)})`);
      assert.ok(
        ['pass', 'fail', 'skip'].includes(check.status),
        `check "${check.name}" status "${check.status}" should be pass/fail/skip`,
      );
      assert.ok(typeof check.message === 'string', `check "${check.name}" message should be a string`);
      assert.ok(
        typeof check.durationMs === 'number' && check.durationMs >= 0,
        `check "${check.name}" durationMs should be a non-negative number`,
      );
    }
  });

  // ── Specific check behaviors ──────────────────────────────────────────────

  it('daemon check always passes', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const daemonCheck = body.checks.find((c: { name: string }) => c.name === 'daemon');
    assert.ok(daemonCheck, 'daemon check should be present');
    assert.equal(daemonCheck.status, 'pass', 'daemon check should always pass');
  });

  it('database check passes with a valid open database', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const dbCheck = body.checks.find((c: { name: string }) => c.name === 'database');
    assert.ok(dbCheck, 'database check should be present');
    assert.equal(dbCheck.status, 'pass', 'database check should pass when DB is open and healthy');
  });

  it('config check passes when a valid config is loaded', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const configCheck = body.checks.find((c: { name: string }) => c.name === 'config');
    assert.ok(configCheck, 'config check should be present');
    assert.equal(configCheck.status, 'pass', 'config check should pass with a loaded config');
  });

  it('identity check skips when identity_file is not configured', async () => {
    // beforeEach writes a config WITHOUT identity_file — skip is the expected outcome
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const identityCheck = body.checks.find((c: { name: string }) => c.name === 'identity');
    assert.ok(identityCheck, 'identity check should be present');
    assert.equal(identityCheck.status, 'skip', 'identity check should skip when identity_file is not configured');
  });

  it('identity check passes when identity_file is configured and file exists', async () => {
    // Write a config that references an identity file
    _resetConfigForTesting();
    const identityFilename = 'identity.md';
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      `agent:\n  name: test-agent\n  identity_file: ${identityFilename}\ndaemon:\n  log_dir: logs\n`,
    );
    fs.writeFileSync(path.join(tmpDir, identityFilename), '# Identity\nI am a test agent.\n');
    loadConfig(tmpDir);

    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const identityCheck = body.checks.find((c: { name: string }) => c.name === 'identity');
    assert.ok(identityCheck, 'identity check should be present');
    assert.equal(identityCheck.status, 'pass', 'identity check should pass when file exists');
  });

  it('CLAUDE.md check passes when .kithkit/CLAUDE.md exists in project dir', async () => {
    // Create the .kithkit directory and CLAUDE.md
    const kithkitDir = path.join(tmpDir, '.kithkit');
    fs.mkdirSync(kithkitDir, { recursive: true });
    fs.writeFileSync(path.join(kithkitDir, 'CLAUDE.md'), '# CLAUDE\nProject instructions.\n');

    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const claudeCheck = body.checks.find((c: { name: string }) => c.name === 'claude-md');
    assert.ok(claudeCheck, 'claude-md check should be present');
    assert.equal(claudeCheck.status, 'pass', 'claude-md check should pass when .kithkit/CLAUDE.md exists');
  });

  it('CLAUDE.md check fails or skips when .claude/CLAUDE.md does not exist', async () => {
    // tmpDir has no .claude/CLAUDE.md in this test
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const claudeCheck = body.checks.find((c: { name: string }) => c.name === 'claude-md');
    assert.ok(claudeCheck, 'claude-md check should be present');
    assert.ok(
      claudeCheck.status === 'fail' || claudeCheck.status === 'skip',
      `claude-md check should be fail or skip when file is absent (got "${claudeCheck.status}")`,
    );
  });

  it('channel router check skips when no adapters are registered in test environment', async () => {
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const routerCheck = body.checks.find((c: { name: string }) => c.name === 'channel-router');
    assert.ok(routerCheck, 'channel-router check should be present');
    assert.equal(routerCheck.status, 'skip', 'channel-router check should skip when no adapters are registered');
  });

  // ── launchd_agent check — regression tests for #345 ──────────────────────
  //
  // These tests PIN the domain-aware behavior introduced in #345.
  // They MUST go RED if the check is reverted to a domain-blind probe such as:
  //   - bare `launchctl list | grep <label>`
  //   - fs.accessSync on ~/Library/LaunchAgents/<label>.plist
  //
  // Mutation-killing assertion: the mock asserts that the command issued to
  // child_process targets `gui/<uid>/<label>`. Any domain-blind revert will
  // either not call execFile at all (file-existence path) or will call it with
  // wrong arguments (launchctl list path) — both cause the test to fail.
  //
  // On non-macOS the check skips unconditionally; assertions are skipped there too.

  it('launchd_agent check skips when daemon.launchd_label is not configured', async () => {
    // beforeEach writes config WITHOUT launchd_label — skip is the expected outcome
    const req = createMockReq('GET', '/api/selftest');
    const res = createMockRes();
    await handleSelftestRoute(req, res, '/api/selftest');

    const body = JSON.parse(res._body);
    const launchdCheck = body.checks.find((c: { name: string }) => c.name === 'launchd_agent');
    assert.ok(launchdCheck, 'launchd_agent check should be present in every selftest response');
    assert.equal(
      launchdCheck.status,
      'skip',
      'launchd_agent check should skip when daemon.launchd_label is not configured',
    );
  });

  it('launchd_agent check issues domain-aware launchctl print command and passes on zero exit', async () => {
    // Configure daemon.launchd_label so the check runs
    const TEST_LABEL = 'com.test.daemon';
    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      `agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n  launchd_label: ${TEST_LABEL}\n`,
    );
    loadConfig(tmpDir);

    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;

    _setLaunchctlExecForTesting(async (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = [...args];
      return { stdout: '', stderr: '' }; // exit 0 = agent is registered
    });

    try {
      const req = createMockReq('GET', '/api/selftest');
      const res = createMockRes();
      await handleSelftestRoute(req, res, '/api/selftest');

      const body = JSON.parse(res._body);
      const launchdCheck = body.checks.find((c: { name: string }) => c.name === 'launchd_agent');
      assert.ok(launchdCheck, 'launchd_agent check should be present');

      if (process.platform === 'darwin') {
        // Mutation-killing: must call launchctl with `print gui/<uid>/<label>`
        assert.ok(
          capturedCmd !== undefined,
          'launchctl exec must have been called (revert to file-existence probe would break this)',
        );
        assert.equal(capturedCmd, 'launchctl', 'must invoke launchctl binary');
        assert.ok(
          Array.isArray(capturedArgs) && capturedArgs.includes('print'),
          `must use launchctl print (not list); args: ${JSON.stringify(capturedArgs)}`,
        );
        assert.ok(
          Array.isArray(capturedArgs) && capturedArgs.some(a => a.startsWith(`gui/${uid}/`)),
          `must target gui/${uid}/... user GUI domain; args: ${JSON.stringify(capturedArgs)}`,
        );
        assert.ok(
          Array.isArray(capturedArgs) && capturedArgs.includes(`gui/${uid}/${TEST_LABEL}`),
          `must target gui/${uid}/${TEST_LABEL} exactly; args: ${JSON.stringify(capturedArgs)}`,
        );
        assert.equal(
          launchdCheck.status,
          'pass',
          'check should pass when launchctl print exits zero',
        );
      } else {
        // Non-macOS: check must skip regardless
        assert.equal(launchdCheck.status, 'skip', 'launchd_agent check should skip on non-macOS');
      }
    } finally {
      _setLaunchctlExecForTesting(null); // always restore
    }
  });

  it('launchd_agent check reports fail when launchctl print exits non-zero (agent absent)', async () => {
    // Only meaningful on macOS where the check actually executes
    if (process.platform !== 'darwin') return;

    const TEST_LABEL = 'com.test.daemon';
    _resetConfigForTesting();
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      `agent:\n  name: test-agent\ndaemon:\n  log_dir: logs\n  launchd_label: ${TEST_LABEL}\n`,
    );
    loadConfig(tmpDir);

    _setLaunchctlExecForTesting(async () => {
      // Simulate launchctl print exiting non-zero (agent not in GUI domain)
      const err = new Error('launchctl: Could not find service "com.test.daemon" in domain for port gui/501');
      (err as NodeJS.ErrnoException).code = 'ERR_CHILD_PROCESS';
      throw err;
    });

    try {
      const req = createMockReq('GET', '/api/selftest');
      const res = createMockRes();
      await handleSelftestRoute(req, res, '/api/selftest');

      const body = JSON.parse(res._body);
      const launchdCheck = body.checks.find((c: { name: string }) => c.name === 'launchd_agent');
      assert.ok(launchdCheck, 'launchd_agent check should be present');
      assert.equal(
        launchdCheck.status,
        'fail',
        // This assertion catches the #345 regression: a domain-blind probe
        // (file-existence or bare launchctl list) would return pass/skip here,
        // not fail, even though the agent is absent from the GUI domain.
        'check must report fail when launchctl print exits non-zero — domain-blind revert would break this assertion',
      );
    } finally {
      _setLaunchctlExecForTesting(null); // always restore
    }
  });
});
