/**
 * Selftest API — comprehensive system health check endpoint.
 *
 * This is a standalone diagnostic endpoint, distinct from the health-check
 * registry in extended-status.ts. It runs a fixed battery of checks covering
 * daemon core, dependencies, config, files, and runtime environment.
 *
 * Route:
 *   GET /api/selftest — run all checks and return a structured report
 *
 * Response shape:
 *   { status, timestamp, checks: [...], summary: { total, pass, fail, skip } }
 *
 * Overall status:
 *   "healthy"   — all checks pass or skip
 *   "degraded"  — one or more non-core checks fail
 *   "unhealthy" — the daemon core check itself fails
 */

import type http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { json } from './helpers.js';
import { loadConfig, resolveProjectPath } from '../core/config.js';
import { getDatabase } from '../core/db.js';
import { getExtension, isDegraded } from '../core/extensions.js';
import { listAdapters } from '../comms/channel-router.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'skip';

interface CheckOutcome {
  status: CheckStatus;
  message: string;
}

interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  durationMs: number;
}

interface SelftestReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: CheckResult[];
  summary: { total: number; pass: number; fail: number; skip: number };
}

// ── Check runner ─────────────────────────────────────────────

/**
 * Run a single check function, timing it and catching any thrown errors.
 * A thrown error is treated as a fail — one check never blocks another.
 */
async function runCheck(
  name: string,
  fn: () => Promise<CheckOutcome> | CheckOutcome,
): Promise<CheckResult> {
  const start = performance.now();
  try {
    const outcome = await fn();
    return {
      name,
      ...outcome,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      name,
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - start),
    };
  }
}

// ── Individual checks ─────────────────────────────────────────

/** 1. daemon — always passes (we're running by definition). */
async function checkDaemon(): Promise<CheckOutcome> {
  const config = loadConfig();
  return { status: 'pass', message: `Running on port ${config.daemon.port}` };
}

/** 2. database — verify SQLite connection with SELECT 1. */
async function checkDatabase(): Promise<CheckOutcome> {
  const db = getDatabase();
  db.prepare('SELECT 1').get();
  return { status: 'pass', message: 'Database query OK' };
}

/** 3. extension — verify extension is registered and not degraded. */
async function checkExtension(): Promise<CheckOutcome> {
  const ext = getExtension();
  if (!ext) {
    return { status: 'fail', message: 'No extension registered' };
  }
  if (isDegraded()) {
    return { status: 'fail', message: `Extension "${ext.name}" registered but in degraded mode` };
  }
  return { status: 'pass', message: `Extension "${ext.name}" is healthy` };
}

/** 4. config — validate required fields are present in the loaded config. */
async function checkConfig(): Promise<CheckOutcome> {
  const config = loadConfig();
  const missing: string[] = [];

  if (!config.agent?.name) missing.push('agent.name');
  if (!config.daemon?.port) missing.push('daemon.port');
  if (!config.daemon?.log_dir) missing.push('daemon.log_dir');

  if (missing.length > 0) {
    return { status: 'fail', message: `Missing required fields: ${missing.join(', ')}` };
  }
  return { status: 'pass', message: 'All required config fields present' };
}

/** 5. identity — check that the configured identity file exists on disk. */
async function checkIdentity(): Promise<CheckOutcome> {
  const config = loadConfig();
  const identityFile = config.agent?.identity_file;

  if (!identityFile) {
    return { status: 'skip', message: 'Not configured' };
  }

  const resolved = resolveProjectPath(identityFile);
  if (!fs.existsSync(resolved)) {
    return { status: 'fail', message: `Identity file not found: ${resolved}` };
  }
  return { status: 'pass', message: `Found: ${resolved}` };
}

/** 6. claude-md — check that .claude/CLAUDE.md exists. */
async function checkClaudeMd(): Promise<CheckOutcome> {
  const resolved = resolveProjectPath('.claude', 'CLAUDE.md');
  if (!fs.existsSync(resolved)) {
    return { status: 'fail', message: `Not found: ${resolved}` };
  }
  return { status: 'pass', message: `Found: ${resolved}` };
}

/** 7. tmux — verify tmux is installed and accessible. */
async function checkTmux(): Promise<CheckOutcome> {
  try {
    const { stdout } = await execFileAsync('which', ['tmux'], { timeout: 5000 });
    const path = stdout.trim();
    return { status: 'pass', message: `Found: ${path}` };
  } catch {
    return { status: 'fail', message: 'tmux not found in PATH' };
  }
}

/**
 * 8. comms_session — check that the comms tmux session exists.
 *    Skips if the tmux check failed (passed in as a parameter).
 */
async function checkCommsSession(tmuxPassed: boolean): Promise<CheckOutcome> {
  if (!tmuxPassed) {
    return { status: 'skip', message: 'Skipped (tmux check failed)' };
  }

  const config = loadConfig();
  const sessionName = config.tmux?.session ?? 'commsagent';

  try {
    await execFileAsync('tmux', ['has-session', '-t', sessionName], { timeout: 5000 });
    return { status: 'pass', message: `Session "${sessionName}" exists` };
  } catch {
    return { status: 'fail', message: `Session "${sessionName}" not found` };
  }
}

/** 9. node — check Node.js version. */
async function checkNode(): Promise<CheckOutcome> {
  try {
    const { stdout } = await execFileAsync('node', ['--version'], { timeout: 5000 });
    return { status: 'pass', message: stdout.trim() };
  } catch (err) {
    return { status: 'fail', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 10. git — check git user.name, user.email, and SSH key availability.
 *     All three must be present for a full pass.
 */
async function checkGit(): Promise<CheckOutcome> {
  const issues: string[] = [];

  // Check git user config
  try {
    const { stdout: name } = await execFileAsync('git', ['config', 'user.name'], { timeout: 5000 });
    if (!name.trim()) issues.push('git user.name is empty');
  } catch {
    issues.push('git user.name not configured');
  }

  try {
    const { stdout: email } = await execFileAsync('git', ['config', 'user.email'], { timeout: 5000 });
    if (!email.trim()) issues.push('git user.email is empty');
  } catch {
    issues.push('git user.email not configured');
  }

  // SSH key check — only meaningful when SSH_AUTH_SOCK is set.
  // The daemon process (launchd) does not inherit the user's SSH agent;
  // workers run in tmux sessions that do. Skip when no agent socket is present.
  const sshNote: string[] = [];
  if (process.env.SSH_AUTH_SOCK) {
    try {
      await execFileAsync('ssh-add', ['-l'], { timeout: 5000 });
      // exit code 0 — keys are loaded
    } catch {
      sshNote.push('SSH agent running but no keys loaded (ssh-add -l)');
    }
  }
  // SSH_AUTH_SOCK absent = daemon running without agent (e.g. launchd) — skip silently

  const allIssues = [...issues, ...sshNote];
  if (allIssues.length === 0) {
    return { status: 'pass', message: 'git user config OK' };
  }
  // Only fail if git config is missing; SSH issues are informational
  const hardFails = issues; // git config issues
  if (hardFails.length > 0) {
    return { status: 'fail', message: allIssues.join('; ') };
  }
  return { status: 'pass', message: `git user config OK (note: ${sshNote.join('; ')})` };
}

/** 11. channel_router — list registered channel adapters. */
async function checkChannelRouter(): Promise<CheckOutcome> {
  const adapters = listAdapters();
  if (adapters.length === 0) {
    return { status: 'skip', message: 'No adapters registered' };
  }
  return { status: 'pass', message: `Adapters: ${adapters.join(', ')}` };
}

// ── Route handler ────────────────────────────────────────────

/**
 * Handle GET /api/selftest.
 * Returns true if the route matched and was handled, false otherwise.
 */
export async function handleSelftestRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/selftest' || req.method !== 'GET') return false;

  // Run all independent checks in parallel first
  const [
    daemonResult,
    databaseResult,
    extensionResult,
    configResult,
    identityResult,
    claudeMdResult,
    tmuxResult,
    nodeResult,
    gitResult,
    channelRouterResult,
  ] = await Promise.all([
    runCheck('daemon', checkDaemon),
    runCheck('database', checkDatabase),
    runCheck('extension', checkExtension),
    runCheck('config', checkConfig),
    runCheck('identity', checkIdentity),
    runCheck('claude-md', checkClaudeMd),
    runCheck('tmux', checkTmux),
    runCheck('node', checkNode),
    runCheck('git', checkGit),
    runCheck('channel-router', checkChannelRouter),
  ]);

  // comms_session depends on tmux result
  const commsSessionResult = await runCheck(
    'comms_session',
    () => checkCommsSession(tmuxResult.status === 'pass'),
  );

  const checks: CheckResult[] = [
    daemonResult,
    databaseResult,
    extensionResult,
    configResult,
    identityResult,
    claudeMdResult,
    tmuxResult,
    commsSessionResult,
    nodeResult,
    gitResult,
    channelRouterResult,
  ];

  // Compute summary
  const summary = {
    total: checks.length,
    pass: checks.filter(c => c.status === 'pass').length,
    fail: checks.filter(c => c.status === 'fail').length,
    skip: checks.filter(c => c.status === 'skip').length,
  };

  // Determine overall status
  let status: SelftestReport['status'];
  if (daemonResult.status === 'fail') {
    status = 'unhealthy';
  } else if (summary.fail > 0) {
    status = 'degraded';
  } else {
    status = 'healthy';
  }

  const report: SelftestReport = {
    status,
    timestamp: new Date().toISOString(),
    checks,
    summary,
  };

  json(res, 200, report);
  return true;
}
