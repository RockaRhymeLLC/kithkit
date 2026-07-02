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
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../core/logger.js';
import { loadConfig } from '../core/config.js';
import { estTimestamp } from '../core/session-bridge.js';

const log = createLogger('tmux');
const execFileAsync = promisify(execFile);

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

// ── Send-keys helpers ───────────────────────────────────────

/**
 * Execute a tmux send-keys call, routing through the test seam when available.
 * Using a helper ensures the sendKeys seam intercepts ALL send-keys calls —
 * both the text payload and the separate C-m submit keystroke — so tests can
 * assert each call independently without performing real tmux I/O.
 *
 * Async (promisified execFile) so injectMessage's per-message tmux I/O never
 * blocks the Node event loop (kithkit#2743 incident — sync execFileSync here
 * stalled /health past the watchdog timeout during injection bursts).
 */
async function execSendKeys(session: string, args: string[]): Promise<void> {
  if (_testingDeps?.sendKeys) {
    _testingDeps.sendKeys(session, args);
    return;
  }
  await execFileAsync(TMUX_BIN, ['-S', TMUX_SOCKET, 'send-keys', '-t', `${session}:`, ...args], {
    timeout: 5000,
  });
}

/**
 * Capture the current visible content of a tmux pane.
 *
 * This is the shared "capture-pane verify" primitive used by:
 *  - verifySubmitLanded() (COMMIT 1) — confirms the C-m submit was received
 *  - injectMessage() return value (COMMIT 4) — upgrades return from syscall to receipt
 *
 * Injectable via _testingDeps.capturePane for unit tests that must avoid real tmux I/O.
 * When the seam is active, sleeps and retry loops inside callers are automatically
 * suppressed (checking !_testingDeps?.capturePane) to keep test execution fast.
 */
function capturePaneContent(session: string): string {
  if (_testingDeps?.capturePane) return _testingDeps.capturePane(session);
  return execFileSync(TMUX_BIN, [
    '-S', TMUX_SOCKET, 'capture-pane', '-t', `${session}:`, '-p', '-J',
  ], { timeout: 5000, encoding: 'utf8' });
}

/**
 * Async twin of capturePaneContent(), used exclusively by injectMessage()'s
 * per-message hot path so capture-pane I/O never blocks the event loop.
 *
 * Kept separate from the sync capturePaneContent() deliberately: that sync
 * version backs the exported captureOrchestratorPane(), which is consumed
 * synchronously by the context-watchdog wedge detector and has ~30 existing
 * unit tests asserting a sync string return. Converting it to async would
 * cascade well beyond this fix's two-fix scope (kithkit#2743). Both variants
 * share the same _testingDeps.capturePane test seam.
 */
async function capturePaneContentAsync(session: string): Promise<string> {
  if (_testingDeps?.capturePane) return _testingDeps.capturePane(session);
  const { stdout } = await execFileAsync(TMUX_BIN, [
    '-S', TMUX_SOCKET, 'capture-pane', '-t', `${session}:`, '-p', '-J',
  ], { timeout: 5000, encoding: 'utf8' });
  return stdout;
}

/**
 * Heuristic: is the pane currently showing Claude Code's input prompt?
 * Claude Code presents `> ` at the start of the input line.
 */
function isInputPromptReady(content: string): boolean {
  return />\s*$/.test(content.trimEnd());
}

const MAX_CM_RETRIES = 2;

/**
 * Verify that the submit keystroke (C-m) was received by checking whether
 * the pane content advanced past the baseline (i.e. Claude started responding).
 *
 * Shared primitive — used by injectMessage (COMMIT 1 guard) and as the basis
 * for the receipt-based return value in COMMIT 4.
 *
 * Returns true if the pane grew (submit confirmed), false if it did not change
 * within MAX_CM_RETRIES + 1 capture attempts.
 *
 * Sleeps between retries are suppressed when _testingDeps.capturePane is active
 * so tests complete without real delay.
 */
export async function verifySubmitLanded(session: string, baselineContent: string): Promise<boolean> {
  const baselineLen = baselineContent.length;
  for (let i = 0; i <= MAX_CM_RETRIES; i++) {
    try {
      const current = await capturePaneContentAsync(session);
      // Pane grew or changed substantially → Claude is processing the input
      if (current.length > baselineLen + 5 || current !== baselineContent) {
        return true;
      }
    } catch {
      return false;
    }
    // No delay between retries when seam is active (fast tests)
    if (i < MAX_CM_RETRIES && !_testingDeps?.capturePane) {
      await sleep(300);
    }
  }
  return false;
}

// ── Per-session serial queue ──────────────────────────────────

/**
 * Chains async work per tmux session so that concurrent injectMessage() calls
 * targeting the SAME session run strictly one-at-a-time in FIFO order — two
 * interleaved send-keys sequences to one pane can corrupt the input. Different
 * sessions are independent and proceed concurrently (kithkit#2743).
 */
const _sessionQueues = new Map<string, Promise<unknown>>();

function enqueueForSession<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const prior = _sessionQueues.get(session) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  // Swallow rejections in the chain link itself so one failed injection never
  // poisons the queue for subsequent injections to the same session; the real
  // rejection/resolution still propagates to the caller via `result`.
  _sessionQueues.set(session, result.catch(() => undefined));
  return result;
}

/** @internal Exposed for unit tests to assert FIFO ordering directly. */
export function _getSessionQueueSizeForTesting(): number {
  return _sessionQueues.size;
}

// ── Message injection ───────────────────────────────────────

/**
 * Inject text into a tmux session via send-keys.
 * Returns true if injection succeeded, false if session doesn't exist.
 *
 * Fully async (promisified execFile + timers/promises setTimeout) so a burst
 * of injections never blocks the Node event loop — the sync execFileSync +
 * execFileSync('/bin/sleep', ...) implementation here previously stalled
 * /health past the watchdog timeout for 3-6s per message (kithkit#2743).
 * Concurrent calls to the same session are serialized via enqueueForSession();
 * different sessions proceed concurrently.
 */
export async function injectMessage(agentId: string, text: string): Promise<boolean> {
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

  return enqueueForSession(session, () => injectMessageToSession(agentId, session, text));
}

/**
 * Core injection logic for a single, already-resolved session. Split out from
 * injectMessage() so the per-session serial queue can wrap just this part —
 * the validation/guard checks above run immediately (unqueued).
 */
async function injectMessageToSession(agentId: string, session: string, text: string): Promise<boolean> {
  // Check if session exists first — use injectable for test isolation
  const sessionFound = _testingDeps?.sessionExists
    ? _testingDeps.sessionExists(session)
    : await (async () => {
        try {
          await execFileAsync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
            timeout: 500,
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

  // Capture baseline pane content; wait for the input prompt to be ready (bounded).
  // This readiness-gate prevents injecting into a pane that is mid-render.
  // Sleeps are suppressed when the capturePane seam is active (test mode).
  let preSendContent = '';
  try {
    preSendContent = await capturePaneContentAsync(session);
    const READY_ATTEMPTS = _testingDeps?.capturePane ? 1 : 3;
    for (let i = 0; i < READY_ATTEMPTS && !isInputPromptReady(preSendContent); i++) {
      if (!_testingDeps?.capturePane) {
        await sleep(200);
      }
      preSendContent = await capturePaneContentAsync(session);
    }
  } catch { /* non-fatal — proceed with send even if capture-pane fails */ }

  try {
    // Send the message text as literal keystrokes (-l prevents key-name expansion)
    const stamped = `${estTimestamp()} ${safeText}`;
    await execSendKeys(session, ['-l', stamped]);

    // Small delay to let tmux buffer the text before the submit keystroke.
    // Suppressed in seam test mode (capturePane set) to keep tests fast.
    if (!_testingDeps?.capturePane) {
      await sleep(150);
    }

    // Send the submit keystroke as a SEPARATE send-keys call.
    // It must NOT be folded into the text payload (the -l literal flag treats
    // 'C-m' as the literal characters C and m, not as Enter). Keeping it separate
    // also means no sanitizer or length cap can accidentally swallow it.
    await execSendKeys(session, ['C-m']);

    // Verify submit landed via capture-pane; retry C-m if the pane hasn't advanced.
    // This catches the race on slower boxes where the submit keystroke arrives before
    // Claude's readline is fully ready (trace 8069cbf0, todo #853/#2297).
    let submitted = await verifySubmitLanded(session, preSendContent);
    if (!submitted) {
      for (let i = 0; i < MAX_CM_RETRIES; i++) {
        await execSendKeys(session, ['C-m']);
        if (await verifySubmitLanded(session, preSendContent)) { submitted = true; break; }
      }
      if (!submitted) {
        log.warn('injectMessage: submit verify failed after retries (send-keys syscall succeeded)', {
          agentId, session,
        });
      }
    }

    // Receipt-based success: return true only when capture-pane confirmed the submit
    // landed (pane advanced). This supersedes #439's syscall-based check IN-PLACE:
    // #439 checked the send-keys exit code (truthy if no exception), which could
    // succeed even if the C-m never reached Claude's readline. Callers that check
    // the return value (e.g. the !nudged warn path in orchestrator.ts) now get a
    // meaningful signal that Claude actually received and queued the input.
    log.info('Message injected into tmux session', { agentId, session, length: safeText.length, verified: submitted });
    return submitted;
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

/** Build the environment object passed to the orchestrator tmux spawn call. */
function buildOrchSpawnEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    CLAUDECODE: '',  // Clear nesting guard — orchestrator is a separate session
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
  };
}

/** @internal Exposed for unit tests only — returns the spawn env for mutation-kill assertions. */
export function _buildOrchSpawnEnvForTesting(): NodeJS.ProcessEnv {
  return buildOrchSpawnEnv();
}

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
    const orchSpawnArgs = [
      '-S', TMUX_SOCKET,
      'new-session',
      '-d',             // detached
      '-s', session,    // session name
      '-c', projectDir, // working directory
      '-x', '200',      // width
      '-y', '50',       // height
      '-e', 'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1', // set pane env explicitly (server-env bypass)
      '-e', 'CLAUDECODE=',                            // clear nesting guard (server-env bypass)
      claudeBin, '--agent', 'orchestrator', '--dangerously-skip-permissions',
    ];
    if (_testingDeps?.newSessionArgs) {
      _testingDeps.newSessionArgs(orchSpawnArgs);
    } else {
      execFileSync(TMUX_BIN, orchSpawnArgs, {
        timeout: 10000,
        env: buildOrchSpawnEnv(),
      });
    }

    log.info('Orchestrator session spawned with profile', { session, projectDir });

    // Inject startup nudge after a short delay for Claude to initialize.
    // The nudge triggers the orchestrator to poll the task queue (per its profile SOP).
    // Fire-and-forget: this callback isn't awaited by any caller, so we chain
    // .catch() rather than await the now-async injectMessage().
    execFile('/bin/sleep', ['5'], () => {
      const port = loadConfig().daemon.port;
      injectMessage('orchestrator', `You have been spawned. Check the task queue for pending work: curl -s 'http://localhost:${port}/api/orchestrator/tasks?status=pending'`)
        .catch(err => {
          log.warn('Failed to inject startup nudge', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
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
 * Zombie session guard (kithkit#796): a tmux session whose NAME still exists but whose
 * pane's child process has exited is a zombie. Such sessions match the name pattern yet
 * are not actually alive. After confirming a session name matches, we compose with
 * getOrchestratorState() — which already performs the pane-PID liveness check
 * introduced in #439 (dead-default) and hardened in #853 (fast-retry) — to ensure the
 * pane process is genuinely running. 'dead' from getOrchestratorState() means zombie.
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

  if (!sessions.some(name => ORCH_SESSION_PATTERN.test(name))) {
    return false;
  }

  // A session name matched — but verify the pane process is actually alive.
  // getOrchestratorState() checks the pane PID and returns 'dead' for zombie sessions
  // (session lingers, pane process gone). 'active' or 'waiting' means genuinely live.
  return getOrchestratorState() !== 'dead';
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

  // has-session check — reuse sessionExists seam for test isolation
  const sessionAlive = _testingDeps?.sessionExists
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
  if (!sessionAlive) return 'dead';

  try {
    // Get the PID of the Claude process that owns the tmux pane.
    // panePid seam allows tests to throw here and exercise the outer catch.
    const panePid = _testingDeps?.panePid
      ? _testingDeps.panePid()
      : execFileSync(TMUX_BIN, [
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

// ── Pane content capture (exported) ────────────────────────

/**
 * Capture the current visible text of the orchestrator's tmux pane.
 * Returns the pane content string, or null if the session is not alive or capture fails.
 * Routed through the _testingDeps.capturePane seam so unit tests can supply fake pane text
 * without real tmux I/O (same seam used by injectMessage's submit-verify path).
 * Used by the context watchdog's wedge detector (signal iii: feedback prompt / garbled XML).
 */
export function captureOrchestratorPane(): string | null {
  const session = resolveSession('orchestrator')!;
  try {
    return capturePaneContent(session);
  } catch {
    return null;
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
  /**
   * Override the tmux display-message call that fetches the pane PID inside
   * getOrchestratorState(). Throw to simulate a display-message failure and
   * exercise the outer catch (which must return 'dead' — see #110 phantom-nudge fix).
   * Return a numeric string (e.g. "12345") to proceed with normal process detection.
   *
   * NOTE: orchProcessState has its own inner catch and does NOT reach this outer catch.
   * Use this seam (with sessionExists: () => true) for a true mutation-killer.
   */
  panePid?: () => string;
  /**
   * Intercept tmux send-keys calls inside injectMessage for mutation-kill testing.
   * Called instead of the real execFileSync for every send-keys invocation — both
   * the text payload (-l) and the separate C-m submit keystroke.
   *
   * Presence of this seam also suppresses sleeps inside injectMessage so tests
   * complete without real delays.
   *
   * Mutation-kill usage: record all calls; assert that a separate ['C-m'] call
   * was recorded. Folding C-m into the text payload removes this call → test RED.
   */
  sendKeys?: (session: string, args: string[]) => void;
  /**
   * Intercept the tmux new-session args inside spawnOrchestratorSession for
   * args-capture unit tests. When set, replaces the real execFileSync call so
   * tests can assert the exact args array without spawning a real tmux session.
   *
   * Mutation-kill usage: record the args array; assert -e flags are present
   * before the claudeBin argument. Removing the -e pairs from tmux.ts → test RED.
   */
  newSessionArgs?: (args: string[]) => void;
  /**
   * Override capture-pane output for submit-verify testing.
   * Called by capturePaneContent() instead of the real tmux capture-pane.
   * When set, retry/sleep delays inside verifySubmitLanded and the readiness
   * gate are suppressed (test mode short-circuit).
   *
   * For COMMIT 4 receipt-based return test: return same content on every call
   * to simulate a failed verify; assert injectMessage returns false.
   */
  capturePane?: (session: string) => string;
}

let _testingDeps: TmuxTestDeps | null = null;

/** @internal Set dependency overrides for unit tests. Pass null to restore production behaviour. */
export function _setTmuxDepsForTesting(deps: TmuxTestDeps | null): void {
  _testingDeps = deps;
}
