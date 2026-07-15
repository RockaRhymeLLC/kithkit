/**
 * Session Bridge — multi-session tmux interaction.
 *
 * Handles:
 * - Named session management (multiple concurrent sessions)
 * - Session existence checks
 * - Text injection into tmux panes
 * - Pane capture for reading screen content
 * - Transcript file discovery
 *
 * All operations accept an optional session name, defaulting to
 * tmux.session from config (falling back to agent.name).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, getProjectDir } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('session-bridge');

// ── Test-runner guard ────────────────────────────────────────

/**
 * Returns true when the current process is running under any test runner.
 *
 * This guard CANNOT be defeated by deleting KITHKIT_SUPPRESS_NOTIFICATIONS
 * because it relies on env markers set by the test runner itself — not by test
 * code. It is the defense-in-depth choke point that prevents real tmux
 * send-keys from firing against live sessions during CI or local test runs.
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

// ── Test helpers ──────────────────────────────────────────────
/** @internal Exposed for unit testing. */
export const _testHelpers = {
  getTranscriptDir,
};

/** Reset module state for testing. */
export function _resetForTesting(): void {
  _tmuxPath = null;
  _commsSessionExistsOverride = null;
  _sbDeps = null;
}

// ── injectText seam (mirrors tmux.ts TmuxTestDeps.sendKeys / capturePane) ──
//
// Injectable dependencies for injectText() send-keys calls.
// Mirroring the seam shape introduced for injectMessage() in #440 (34c9ed84)
// so mutation-kill tests can assert the standalone Enter submit keystroke fires.
//
interface SbTestDeps {
  /**
   * Intercept tmux send-keys calls inside injectText for mutation-kill testing.
   * Called instead of the real execFileSync for every send-keys invocation —
   * both the text payload (-l) and the separate Enter submit keystroke.
   *
   * Presence of this seam also suppresses sleeps and capturePane polling inside
   * injectText so tests complete without real delays.
   *
   * Mutation-kill usage: record all calls; assert a standalone ['Enter'] call
   * was recorded. Folding Enter into the text payload removes this call → RED.
   */
  sendKeys?: (session: string, args: string[]) => void;
  /**
   * Override sessionExists() for testing. When set, bypasses real tmux check.
   */
  sessionExists?: (name: string) => boolean;
  /**
   * Override capturePane() return value for the submit-verify retry loop.
   * When set, the retry loop treats any return value as "text no longer pending"
   * (fast path: break immediately) and suppresses sleep delays.
   */
  capturePane?: (session: string) => string;
  /**
   * Intercept the load-buffer + paste-buffer pair used to deliver the text
   * payload via bracketed paste (replaces literal '-l' send-keys so
   * '@'-prefixed inbound text from external channels can't trigger the
   * receiving TUI's file-autocomplete popup). Called with the exact
   * (session, text) that would otherwise be piped through `tmux load-buffer -`
   * and inserted with `paste-buffer -d -p`.
   */
  pasteBuffer?: (session: string, text: string) => void;
}

let _sbDeps: SbTestDeps | null = null;

/**
 * Set injectable dependencies for injectText() — for mutation-kill tests only.
 * Pass null to restore production behaviour.
 * @internal
 */
export function _setSbDepsForTesting(deps: SbTestDeps | null): void {
  _sbDeps = deps;
}

/**
 * Execute a tmux send-keys call for injectText, routing through the test seam
 * when available so mutation-kill tests can assert each send-keys call
 * independently without performing real tmux I/O.
 *
 * Mirrors execSendKeys() in tmux.ts (added in #440 / 34c9ed84).
 */
function execSbSendKeys(tmux: string, session: string, args: string[]): void {
  if (_sbDeps?.sendKeys) {
    _sbDeps.sendKeys(session, args);
    return;
  }
  execFileSync(tmux, ['send-keys', '-t', `${session}:`, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Deliver a text payload into a tmux pane via bracketed paste rather than
 * literal keystrokes (sync variant for this module's synchronous
 * injectText()). Writes the payload to a paste buffer via `load-buffer -`
 * (stdin) and inserts it with `paste-buffer -d -p`; the `-p` flag wraps the
 * insert in bracketed-paste escapes so the receiving TUI does not
 * live-interpret '@' or '/' triggers inside the payload. See agents/tmux.ts's
 * execPasteBuffer() for the full root-cause writeup.
 *
 * Routed through the pasteBuffer test seam so unit tests can assert the exact
 * payload bytes handed to load-buffer without any real tmux I/O.
 */
function execPasteBuffer(tmux: string, session: string, text: string): void {
  if (_sbDeps?.pasteBuffer) {
    _sbDeps.pasteBuffer(session, text);
    return;
  }
  execFileSync(tmux, ['load-buffer', '-'], {
    input: text,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  execFileSync(tmux, ['paste-buffer', '-d', '-p', '-t', `${session}:`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Override commsSessionExists() return value for testing.
 * Pass null to restore default behavior (real tmux check).
 * Used by delivery-integrity tests to simulate session-alive vs session-dead
 * without requiring a live tmux session.
 *
 * @internal
 */
let _commsSessionExistsOverride: (() => boolean) | null = null;
export function _setCommsSessionExistsForTesting(fn: (() => boolean) | null): void {
  _commsSessionExistsOverride = fn;
}

// ── tmux resolution ─────────────────────────────────────────

let _tmuxPath: string | null = null;

function getTmuxPath(): string {
  if (_tmuxPath) return _tmuxPath;
  try {
    _tmuxPath = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
  } catch {
    _tmuxPath = 'tmux'; // fallback
  }
  return _tmuxPath;
}

/** Validate session name to prevent injection. */
function validateSessionName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid session name: ${name}`);
  }
  return name;
}

function getDefaultSessionName(): string {
  const config = loadConfig();
  // Fall back to 'comms1' — not agent.name — because the session name is set
  // by start-tmux.sh and must match the canonical COMMS_SESSION constant in
  // tmux.ts. Using agent.name caused mismatches when the agent was named
  // something other than the tmux session (e.g. "BMO" vs "comms1").
  return config.tmux?.session ?? 'comms1';
}

/**
 * Get the Claude Code transcript directory for a project path.
 * Claude Code mangles the path by replacing both `/` and `_` with `-`.
 */
function getTranscriptDir(projectDir: string): string {
  const projectDirMangled = projectDir.replace(/[/_]/g, '-');
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    projectDirMangled,
  );
}

// ── Timestamp helper ────────────────────────────────────────

/**
 * Return a local-time timestamp string in EST, e.g. "[11:30 AM]".
 */
export function estTimestamp(): string {
  return '[' + new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }) + ']';
}

// ── Comms session constant ────────────────────────────────

/**
 * The comms agent tmux session. ALL external/inbound messages
 * (A2A, agent-comms, Telegram, etc.) MUST be injected here.
 * Only the comms agent talks to humans.
 */
export const COMMS_SESSION = 'comms1';

/**
 * Inject text into the comms agent session (comms1).
 * Use this for ALL external/inbound messages to guarantee they
 * always reach comms, regardless of config changes.
 */
export function injectToComms(
  text: string,
  options?: { pressEnter?: boolean; timestamp?: boolean },
): boolean {
  return injectText(text, { ...options, name: COMMS_SESSION });
}

/**
 * Check if the comms agent session exists.
 */
export function commsSessionExists(): boolean {
  if (_commsSessionExistsOverride !== null) return _commsSessionExistsOverride();
  return sessionExists(COMMS_SESSION);
}

// ── Public API ──────────────────────────────────────────────

/**
 * Check if a tmux session exists.
 * @param name - Session name (defaults to tmux.session from config, falling back to agent.name)
 */
export function sessionExists(name?: string): boolean {
  const session = validateSessionName(name ?? getDefaultSessionName());
  try {
    execFileSync(getTmuxPath(), ['has-session', '-t', `=${session}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the current tmux pane content.
 * @param name - Session name (defaults to tmux.session from config, falling back to agent.name)
 */
export function capturePane(name?: string): string {
  const session = validateSessionName(name ?? getDefaultSessionName());
  try {
    return execFileSync(getTmuxPath(), ['capture-pane', '-t', `${session}:`, '-p'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

/**
 * Check if a session is busy (has active processes).
 * Returns true always — tmux and Claude Code handle input buffering natively.
 * The busy/idle distinction caused more problems than it solved.
 * @param _name - Session name (unused — always returns false for busy)
 */
export function isSessionBusy(_name?: string): boolean {
  return false;
}

/**
 * Inject text into a tmux session pane.
 * Sends the text followed by Enter to submit it.
 *
 * @param text - Text to inject (will be escaped for tmux)
 * @param options - Optional settings
 * @param options.name - Session name (defaults to tmux.session from config, falling back to agent.name)
 * @param options.pressEnter - Whether to press Enter after (default: true)
 * @param options.timestamp - Whether to prepend EST timestamp (default: true)
 */
export function injectText(
  text: string,
  options?: { name?: string; pressEnter?: boolean; timestamp?: boolean },
): boolean {
  // Production defense-in-depth: refuse real send-keys when running under any
  // test runner. This guard applies before any session existence check, so it
  // cannot be bypassed by test code deleting KITHKIT_SUPPRESS_NOTIFICATIONS —
  // it relies on env markers set by the test runner process itself.
  //
  // session-bridge.ts is the lowest choke point for injection from automation
  // tasks (approval-audit, context-watchdog, etc.). Guarding here prevents
  // those tasks from flooding live tmux sessions during test runs regardless of
  // which test-level suppression flags are or are not set.
  if (isUnderTestRunner() && process.env.KITHKIT_ALLOW_TEST_INJECT !== '1') {
    return false;
  }

  const session = validateSessionName(options?.name ?? getDefaultSessionName());
  const pressEnter = options?.pressEnter ?? true;
  const addTimestamp = options?.timestamp ?? true;
  const tmux = getTmuxPath();

  const sessionExistsFn = _sbDeps?.sessionExists ?? sessionExists;
  if (!sessionExistsFn(session)) {
    log.warn('Cannot inject: no tmux session', { session });
    return false;
  }

  // Sanitize input before it can reach execPasteBuffer: bracketed paste is
  // only safe if the payload cannot embed the paste terminator ESC[201~ — an
  // embedded ESC[201~ ends paste mode early and subsequent bytes go LIVE to
  // the TUI (including '/'-commands), re-opening the keystroke-injection
  // exploit class this fix was meant to close. Stripping ESC bytes makes the
  // terminator unrepresentable. Mirrors the sanitizer in agents/tmux.ts's
  // injectMessageToSession().
  let safeText = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); // ANSI CSI
  safeText = safeText.replace(/\x1b[^[]/g, '');               // other ESC seqs
  safeText = safeText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // C0 + DEL, keep \n \t

  // @-mention residual: bracketed paste defeats typing-time fuzzy-autocomplete
  // popups, but the receiving TUI separately resolves @-mentions in the
  // SUBMITTED buffer text — a peer-controlled '@'-prefixed path to a real
  // file (relative, absolute, ../traversal, or config-style) still
  // auto-reads that file at submit time. A filesystem-existence-check gate
  // was rejected: TOCTOU (the file may not exist at sanitize-time but
  // resolve at submit-time), cwd divergence between the sanitizer and the
  // harness's resolution, and absolute/traversal/symlink/tilde forms can
  // dodge the probe. Empirically verified fix instead: insert U+200B (ZERO
  // WIDTH SPACE) immediately after any '@' that's immediately followed by a
  // non-whitespace, non-'@' character — this defeats @-mention resolution
  // while rendering identically (invisible), so broad/over-neutralizing
  // matches (e.g. '@8pm', 'user@example.com') are harmless. Mirrors the
  // identical change in agents/tmux.ts injectMessageToSession().
  safeText = safeText.replace(/@(?=[^\s@])/g, '@​');

  if (safeText.length === 0) {
    log.warn('injectText: text empty after sanitization', { session, originalLength: text.length });
    return false;
  }

  const stamped = addTimestamp ? `${estTimestamp()} ${safeText}` : safeText;

  try {
    // Deliver via bracketed paste, NOT literal keystrokes — see
    // agents/tmux.ts execPasteBuffer() doc for the full root-cause writeup:
    // '-l' send-keys types the payload as live keystrokes, so a
    // peer-controlled '@' character can pop the receiving TUI's
    // file-autocomplete and the immediately following submit keystroke then
    // accepts that popup instead of submitting.
    execPasteBuffer(tmux, session, stamped);

    if (pressEnter) {
      // Small delay before submitting. Suppressed in seam test mode (sendKeys set).
      if (!_sbDeps?.sendKeys) {
        execFileSync('/bin/sleep', ['0.3'], { stdio: ['pipe', 'pipe', 'pipe'] });
      }

      const MAX_ENTER_ATTEMPTS = 3;
      const ENTER_DELAYS = [300, 500, 800];
      for (let attempt = 1; attempt <= MAX_ENTER_ATTEMPTS; attempt++) {
        // Send the submit keystroke as a SEPARATE send-keys call.
        // It must NOT be folded into the text payload (the -l literal flag
        // treats 'Enter' as the literal characters E, n, t, e, r — not as
        // a newline). Keeping it separate also means no sanitizer or length
        // cap can accidentally swallow it (cf. injectMessage fix in #440).
        execSbSendKeys(tmux, session, ['Enter']);

        const delay = ENTER_DELAYS[attempt - 1] ?? 800;
        // Suppress sleep delays in seam test mode.
        if (!_sbDeps?.sendKeys) {
          execFileSync('/bin/sleep', [String(delay / 1000)], { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        if (attempt < MAX_ENTER_ATTEMPTS) {
          // Seam test mode: treat capturePane as returning "not pending" to
          // break immediately without real tmux I/O.
          const pane = _sbDeps?.capturePane ? _sbDeps.capturePane(session) : capturePane(session);
          const lines = pane.split('\n').filter(l => l.trim().length > 0);
          const lastLines = lines.slice(-5);
          const textStillPending = lastLines.some(l => l.includes(safeText.slice(0, 40)));
          if (!textStillPending) break;
          log.debug(`Enter attempt ${attempt} pending — retrying (backoff ${delay}ms)`);
        }
      }
    }

    log.debug(`Injected text (${text.length} chars)`, { session });
    return true;
  } catch (err) {
    log.error('Failed to inject text', {
      session,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Get the path to the newest transcript file for this project.
 */
export function getNewestTranscript(): string | null {
  const projectDir = getProjectDir();
  const transcriptDir = getTranscriptDir(projectDir);

  try {
    const files = fs.readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        path: path.join(transcriptDir, f),
        mtime: fs.statSync(path.join(transcriptDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Start a Claude Code tmux session if not running.
 * @param name - Session name (defaults to tmux.session from config, falling back to agent.name)
 */
export function startSession(name?: string): boolean {
  const session = name ?? getDefaultSessionName();
  if (sessionExists(session)) return true;

  const startScript = path.join(getProjectDir(), 'scripts', 'start-tmux.sh');
  if (!fs.existsSync(startScript)) {
    log.error('start-tmux.sh not found');
    return false;
  }

  try {
    execFileSync(startScript, ['--detach'], {
      cwd: getProjectDir(),
      stdio: 'inherit',
    });
    log.info('Started Claude Code session', { session });
    return true;
  } catch (err) {
    log.error('Failed to start session', {
      session,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

