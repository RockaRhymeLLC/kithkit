/**
 * Tmux session management — spawn, inject messages, teardown.
 *
 * Handles orchestrator and comms agent tmux sessions.
 * The daemon uses this to:
 * - Inject messages into persistent agent sessions (comms/orchestrator)
 * - Spawn on-demand orchestrator sessions
 * - Tear down orchestrator sessions when work is done
 */

import { execFileSync, execFile } from 'node:child_process';
import { createLogger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { estTimestamp } from '../core/session-bridge.js';

const log = createLogger('tmux');

// ── Config ──────────────────────────────────────────────────

export const TMUX_BIN = loadConfig().tools?.tmux_path ?? '/opt/homebrew/bin/tmux';
// macOS uses /private/tmp; Linux uses /tmp — detect at startup.
const _tmuxTmpDir = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
export const TMUX_SOCKET = `${_tmuxTmpDir}/tmux-${process.getuid?.() ?? 501}/default`;

const COMMS_SESSION = 'comms1';
const ORCH_SESSION = 'orch1';

/**
 * Pattern that matches any orchestrator session name.
 * Used by isOrchestratorAlive() for independent detection — NOT keyed to ORCH_SESSION.
 * Matches: 'orch', 'orch1', 'orch2', 'orch123', etc.
 */
export const ORCH_SESSION_PATTERN = /^orch\d*$/;

/** Maximum characters allowed in a single tmux send-keys injection. */
const MAX_INJECT_LENGTH = 4000;

let projectDir = process.cwd();

export function configure(opts: { projectDir: string }): void {
  projectDir = opts.projectDir;
}

// ── Session name mapping ────────────────────────────────────

export function resolveSession(agentId: string): string | null {
  if (_testingDeps?.resolveSession) return _testingDeps.resolveSession(agentId);
  if (agentId === 'comms') return COMMS_SESSION;
  if (agentId === 'orchestrator') return ORCH_SESSION;
  return null; // Workers don't have tmux sessions
}

// ── Test-isolation hooks ─────────────────────────────────────

/**
 * Counts how many times injectMessage was called past the env-var suppression
 * guard. Used in tests to verify the guard fires (or doesn't).
 */
let _injectionAttempts = 0;
export function _getInjectionAttempts(): number { return _injectionAttempts; }
export function _resetInjectionAttempts(): void { _injectionAttempts = 0; }

/**
 * Returns true when the current process is running under any test runner.
 *
 * This check is CANNOT be defeated by deleting KITHKIT_SUPPRESS_NOTIFICATIONS
 * because it relies on env markers set by the test runner itself — not by test
 * code. It is used as a defense-in-depth guard to prevent real tmux send-keys
 * from firing against live sessions during CI or local test runs.
 *
 * Supported runners:
 *  - Node.js built-in test runner (node --test): sets NODE_TEST_CONTEXT=child
 *  - Jest: sets JEST_WORKER_ID
 *  - Vitest: sets VITEST and/or VITEST_WORKER_ID
 *  - Generic: NODE_ENV=test
 */
function isUnderTestRunner(): boolean {
  return (
    process.env.NODE_TEST_CONTEXT !== undefined ||  // node --test child process
    process.env.JEST_WORKER_ID !== undefined ||      // Jest
    process.env.VITEST !== undefined ||              // Vitest
    process.env.VITEST_WORKER_ID !== undefined ||   // Vitest worker
    process.env.NODE_ENV === 'test'                  // Generic test env
  );
}

// ── Message injection ───────────────────────────────────────

/**
 * Inject text into a tmux session via send-keys.
 * Returns true if injection succeeded, false if session doesn't exist.
 */
export function injectMessage(agentId: string, text: string): boolean {
  if (process.env.KITHKIT_SUPPRESS_NOTIFICATIONS === '1') {
    return false; // test-isolation: suppress all live-session tmux injections
  }
  _injectionAttempts++;

  // Production defense-in-depth: refuse real send-keys when running under any
  // test runner. This guard CANNOT be bypassed by deleting
  // KITHKIT_SUPPRESS_NOTIFICATIONS — it relies on env markers set by the test
  // runner itself. _injectionAttempts is incremented above so tests asserting
  // the attempt counter still pass without any real I/O.
  //
  // The only explicit opt-in is KITHKIT_ALLOW_TEST_INJECT=1, which is intended
  // exclusively for tests that specifically need to assert real-inject behavior
  // and MUST be paired with a mocked execFileSync to prevent actual tmux I/O.
  if (isUnderTestRunner() && process.env.KITHKIT_ALLOW_TEST_INJECT !== '1') {
    return false;
  }

  const session = resolveSession(agentId);
  if (!session) {
    log.warn('No tmux session mapping for agent', { agentId });
    return false;
  }

  // Check if session exists first — use injectable for test isolation
  const sessionFound = _testingDeps?.sessionExists
    ? _testingDeps.sessionExists(session)
    : (() => {
        try {
          execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      })();

  if (!sessionFound) {
    // R2 guard: only downgrade to debug when the orchestrator is confirmed gone.
    // If the orch IS alive but session lookup failed (e.g. name-mismatch, todo #82),
    // that's a real delivery failure — keep it visible.
    if (agentId === 'orchestrator' && !isOrchestratorAlive()) {
      log.debug('Tmux session not found — orchestrator has exited (expected)', { agentId, session });
    } else {
      log.warn('Tmux session not found for message injection', { agentId, session });
    }
    return false;
  }

  // Sanitize input: cap length and strip control/escape sequences
  if (text.length > MAX_INJECT_LENGTH) {
    log.warn('injectMessage: text truncated', {
      agentId, originalLength: text.length, maxLength: MAX_INJECT_LENGTH,
    });
  }
  let safeText = text.slice(0, MAX_INJECT_LENGTH);
  // Strip ANSI escape sequences (ESC [ ... and ESC O ...)
  safeText = safeText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  safeText = safeText.replace(/\x1b[^[]/g, '');
  // Strip raw escape bytes and other C0 control chars except newline and tab
  safeText = safeText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  if (safeText.length === 0) {
    log.warn('injectMessage: text empty after sanitization', {
      agentId, originalLength: text.length,
    });
    return false;
  }

  try {
    // Prepend EST timestamp and send as keystrokes, then press Enter
    const stamped = `${estTimestamp()} ${safeText}`;
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'send-keys', '-t', `${session}:`, '-l', stamped], {
      timeout: 5000,
    });
    // Small delay to let tmux buffer the text before submitting
    execFileSync('/bin/sleep', ['0.15'], { timeout: 2000 });
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'send-keys', '-t', `${session}:`, 'Enter'], {
      timeout: 5000,
    });
    log.info('Message injected into tmux session', { agentId, session, length: safeText.length });
    return true;
  } catch (err) {
    log.error('Failed to inject message into tmux', {
      agentId,
      session,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Orchestrator session lifecycle ──────────────────────────

/**
 * Spawn an orchestrator tmux session running Claude Code with the orchestrator profile.
 * Returns the session name, or null if spawn failed.
 *
 * The orchestrator uses --agent to load its instructions from .claude/agents/orchestrator.md.
 * On startup, it polls the task queue for pending work. The daemon injects nudges via
 * send-keys when new tasks arrive or when shutdown is needed.
 */
export function spawnOrchestratorSession(): string | null {
  const session = resolveSession('orchestrator')!;

  // Check if already running — use injectable for test isolation (same pattern as injectMessage)
  const alreadyRunning = _testingDeps?.sessionExists
    ? _testingDeps.sessionExists(session)
    : (() => {
        try {
          execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      })();

  if (alreadyRunning) {
    log.warn('Orchestrator session already exists', { session });
    return session;
  }

  try {
    // Resolve the Claude binary: check common install locations before falling
    // back to bare 'claude' (relies on PATH at spawn time).
    const claudeBin = (() => {
      const candidates = [
        `${process.env.HOME}/.local/bin/claude`,
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
      for (const p of candidates) {
        try {
          execFileSync('/bin/test', ['-x', p], { timeout: 2000 });
          return p;
        } catch {
          // not found at this path
        }
      }
      return 'claude'; // rely on PATH
    })();

    // Create a new detached tmux session running Claude with the orchestrator profile
    execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'new-session',
      '-d',             // detached
      '-s', session,    // session name
      '-c', projectDir, // working directory
      '-x', '200',      // width
      '-y', '50',       // height
      claudeBin, '--agent', 'orchestrator', '--dangerously-skip-permissions',
    ], {
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        CLAUDECODE: '',  // Clear nesting guard — orchestrator is a separate session
      },
    });

    log.info('Orchestrator session spawned with profile', { session, projectDir });

    // Inject startup nudge after a short delay for Claude to initialize.
    // The nudge triggers the orchestrator to poll the task queue (per its profile SOP).
    execFile('/bin/sleep', ['5'], () => {
      try {
        const port = loadConfig().daemon.port;
        injectMessage('orchestrator', `You have been spawned. Check the task queue for pending work: curl -s 'http://localhost:${port}/api/orchestrator/tasks?status=pending'`);
      } catch (err) {
        log.warn('Failed to inject startup nudge', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return session;
  } catch (err) {
    log.error('Failed to spawn orchestrator session', {
      session,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Kill the orchestrator tmux session.
 * Returns true if killed, false if session didn't exist.
 */
export function killOrchestratorSession(): boolean {
  const session = resolveSession('orchestrator')!;

  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'kill-session', '-t', `=${session}`], {
      timeout: 5000,
    });
    log.info('Orchestrator session killed', { session });
    return true;
  } catch {
    log.warn('Orchestrator session not found for kill', { session });
    return false;
  }
}

/**
 * Check if an orchestrator session is alive — independently of the ORCH_SESSION constant.
 *
 * The old implementation checked `has-session -t =orch1`, which hardcoded equality to
 * ORCH_SESSION. If the real orchestrator session was named anything else (e.g. 'orch2'),
 * it would silently return the wrong answer (fix for kithkit#752, fast-follow to #255).
 *
 * This implementation scans ALL sessions on the project socket and matches against
 * ORCH_SESSION_PATTERN. A session-name mismatch is now DETECTABLE — not silently
 * mis-reported as "dead" when the orchestrator is actually alive.
 *
 * The true/false contract is preserved; _testingDeps.isOrchAlive override is unchanged.
 */
export function isOrchestratorAlive(): boolean {
  if (_testingDeps?.isOrchAlive !== undefined) return _testingDeps.isOrchAlive();

  // Independent detection: list ALL sessions on this socket and match against
  // the orchestrator pattern. listSessions() handles tmux not running (returns []).
  const sessions = _testingDeps?.listSessions
    ? _testingDeps.listSessions()
    : listSessions();

  return sessions.some(name => ORCH_SESSION_PATTERN.test(name));
}

/**
 * Check if the orchestrator is actively running Claude (not just idle at prompt).
 *
 * With --agent, Claude IS the tmux pane process. To distinguish "actively processing"
 * from "idle at the input prompt," we check whether Claude has child processes
 * (tool execution spawns children like bash, node, etc.).
 *
 * Returns:
 *  - 'active'  — session exists and Claude has child processes (actively working)
 *  - 'waiting' — session exists but Claude has no children (idle at prompt)
 *  - 'dead'    — no session or pane process has exited
 */
export function getOrchestratorState(): 'active' | 'waiting' | 'dead' {
  const session = resolveSession('orchestrator')!;

  // Test seam: when orchProcessState is set, bypass real tmux entirely.
  // Returns the specified state ('active'|'waiting'), or throws to exercise the
  // outer-catch path (which should return 'dead' — see #110 phantom-nudge fix).
  if (_testingDeps?.orchProcessState !== undefined) {
    try {
      const result = _testingDeps.orchProcessState();
      if (result === null) {
        throw new Error('simulated process-state detection error (test injection)');
      }
      return result;
    } catch (err) {
      log.warn('getOrchestratorState: failed to determine process state, treating as dead', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 'dead';
    }
  }

  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
      timeout: 5000,
    });
  } catch {
    return 'dead';
  }

  try {
    // Get the PID of the Claude process that owns the tmux pane
    const panePid = execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'display-message',
      '-t', `${session}:`,
      '-p', '#{pane_pid}',
    ], { timeout: 5000, encoding: 'utf8' }).trim();

    if (!panePid || !/^\d+$/.test(panePid)) {
      return 'dead';
    }

    // Verify the pane process is still alive
    try {
      process.kill(parseInt(panePid, 10), 0);
    } catch {
      return 'dead';
    }

    // Check if Claude has child processes (tools running = actively working)
    try {
      execFileSync('/usr/bin/pgrep', ['-P', panePid], {
        timeout: 5000,
      });
      return 'active'; // Has children → actively processing
    } catch {
      return 'waiting'; // No children → idle at input prompt
    }
  } catch (err) {
    // Conservative fallback: if we cannot determine process state, treat the session
    // as dead. This prevents phantom new-task nudges being fired to an unknown-state
    // session. The escalate endpoint will spawn a fresh orchestrator instead.
    // (Previously this returned 'waiting', which caused phantom nudges — see #110.)
    log.warn('getOrchestratorState: failed to determine process state, treating as dead', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'dead';
  }
}

/**
 * List all tmux sessions managed by the daemon.
 */
export function listSessions(): string[] {
  try {
    const output = execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'list-sessions',
      '-F', '#{session_name}',
    ], { timeout: 5000 }).toString().trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

// ── Session liveness check ──────────────────────────────────

/**
 * Check whether the tmux session for a given agent ID is currently alive.
 * Returns true if the session exists, false otherwise.
 */
export function isSessionAlive(agentId: string): boolean {
  const session = resolveSession(agentId);
  if (!session) return false;

  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Testing ─────────────────────────────────────────────────

export function _getCommsSession(): string { return COMMS_SESSION; }
export function _getOrchestratorSession(): string { return ORCH_SESSION; }

/**
 * Dependency overrides for unit testing.
 * - resolveSession: override agentId → tmux session name mapping used by resolveSession(),
 *   spawnOrchestratorSession(), and injectMessage(). Inject a sentinel name to verify that
 *   both the spawn and deliver paths route through the same resolution function (todo #81).
 * - sessionExists: override the tmux has-session check used in spawnOrchestratorSession()
 *   and injectMessage()
 * - isOrchAlive: override isOrchestratorAlive() return value
 * - listSessions: override the session list used by isOrchestratorAlive() independent detection
 *
 * Both sessionExists and isOrchAlive must be set together to fully isolate a test:
 * sessionExists controls whether injectMessage reaches the "not found" branch; isOrchAlive
 * controls whether the R2 guard treats that as an expected (orch gone) or unexpected
 * (orch alive) failure.
 *
 * listSessions is used to test isOrchestratorAlive() directly (without bypassing it via
 * isOrchAlive) — e.g. to verify that a session named 'orch2' is correctly detected.
 */
interface TmuxTestDeps {
  resolveSession?: (agentId: string) => string | null;
  sessionExists?: (session: string) => boolean;
  isOrchAlive?: () => boolean;
  listSessions?: () => string[];
  /**
   * Override process-state detection inside getOrchestratorState() for unit tests.
   * Return 'active' | 'waiting' to specify the desired state, or null to simulate
   * an unexpected error that triggers the outer catch (should return 'dead').
   */
  orchProcessState?: () => 'active' | 'waiting' | null;
}

let _testingDeps: TmuxTestDeps | null = null;

/** @internal Set dependency overrides for unit tests. Pass null to restore production behaviour. */
export function _setTmuxDepsForTesting(deps: TmuxTestDeps | null): void {
  _testingDeps = deps;
}
