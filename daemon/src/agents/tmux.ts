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

/** Maximum characters allowed in a single tmux send-keys injection. */
const MAX_INJECT_LENGTH = 4000;

let projectDir = process.cwd();

export function configure(opts: { projectDir: string }): void {
  projectDir = opts.projectDir;
}

// ── Session name mapping ────────────────────────────────────

export function resolveSession(agentId: string): string | null {
  if (agentId === 'comms') return COMMS_SESSION;
  if (agentId === 'orchestrator') return ORCH_SESSION;
  return null; // Workers don't have tmux sessions
}

// ── Message injection ───────────────────────────────────────

/**
 * Inject text into a tmux session via send-keys.
 * Returns true if injection succeeded, false if session doesn't exist.
 */
export function injectMessage(agentId: string, text: string): boolean {
  const session = resolveSession(agentId);
  if (!session) {
    log.warn('No tmux session mapping for agent', { agentId });
    return false;
  }

  try {
    // Check if session exists first
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
      timeout: 5000,
    });
  } catch {
    log.warn('Tmux session not found for message injection', { agentId, session });
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

  // Check if already running
  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
      timeout: 5000,
    });
    log.warn('Orchestrator session already exists', { session });
    return session;
  } catch {
    // Session doesn't exist — good, we'll create it
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
 * Check if the orchestrator session exists (alive = session running).
 * This returns true even when the wrapper is idle-waiting between tasks.
 */
export function isOrchestratorAlive(): boolean {
  const session = resolveSession('orchestrator')!;

  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${session}`], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
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
    log.warn('getOrchestratorState: failed to determine process state, assuming waiting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'waiting';
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
