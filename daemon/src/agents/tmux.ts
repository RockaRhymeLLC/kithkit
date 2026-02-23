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
import { estTimestamp } from '../core/session-bridge.js';

const log = createLogger('tmux');

// ── Config ──────────────────────────────────────────────────

const TMUX_BIN = '/opt/homebrew/bin/tmux';
const TMUX_SOCKET = `/private/tmp/tmux-${process.getuid?.() ?? 501}/default`;

let commsSession = 'agent'; // Default, overridden by config
let projectDir = process.cwd();

export function configure(opts: { commsSession: string; projectDir: string }): void {
  commsSession = opts.commsSession;
  projectDir = opts.projectDir;
}

// ── Session name mapping ────────────────────────────────────

function resolveSession(agentId: string): string | null {
  if (agentId === 'comms') return commsSession;
  if (agentId === 'orchestrator') return `${commsSession}-orch`;
  return null; // Workers don't have tmux sessions
}

// ── Message injection ───────────────────────────────────────

/**
 * Inject text into a tmux session via send-keys.
 * Returns true if injection succeeded, false if session doesn't exist.
 */
export function injectMessage(agentId: string, text: string): boolean {
  const session = resolveSession(agentId);
  if (!session) return false;

  try {
    // Check if session exists first
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', session], {
      timeout: 5000,
    });
  } catch {
    log.warn('Tmux session not found for message injection', { agentId, session });
    return false;
  }

  try {
    // Prepend EST timestamp and send as keystrokes, then press Enter
    const stamped = `${estTimestamp()} ${text}`;
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'send-keys', '-t', session, '-l', stamped], {
      timeout: 5000,
    });
    // Small delay to let tmux buffer the text before submitting
    execFileSync('/bin/sleep', ['0.15'], { timeout: 2000 });
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'send-keys', '-t', session, 'Enter'], {
      timeout: 5000,
    });
    log.info('Message injected into tmux session', { agentId, session, length: text.length });
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
 * Spawn an orchestrator tmux session running Claude Code.
 * Returns the session name, or null if spawn failed.
 */
export function spawnOrchestratorSession(prompt: string): string | null {
  const session = resolveSession('orchestrator')!;

  // Check if already running
  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', session], {
      timeout: 5000,
    });
    log.warn('Orchestrator session already exists', { session });
    // Session exists — inject the new task prompt
    injectMessage('orchestrator', prompt);
    return session;
  } catch {
    // Session doesn't exist — good, we'll create it
  }

  try {
    // Find claude binary
    const claudeBin = `${process.env.HOME}/.local/bin/claude`;

    // Create a new detached tmux session running Claude Code
    // The orchestrator gets bypassPermissions since it's daemon-managed
    // We use shell-command form so tmux can parse it properly
    execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'new-session',
      '-d',             // detached
      '-s', session,    // session name
      '-c', projectDir, // working directory
      '-x', '200',      // width
      '-y', '50',       // height
      claudeBin, '--dangerously-skip-permissions', '-p', prompt,
    ], {
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      },
    });

    log.info('Orchestrator session spawned', { session, projectDir });
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
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'kill-session', '-t', session], {
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
 * Check if the orchestrator session is alive.
 */
export function isOrchestratorAlive(): boolean {
  const session = resolveSession('orchestrator')!;

  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', session], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
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

// ── Testing ─────────────────────────────────────────────────

export function _getCommsSession(): string { return commsSession; }
export function _getOrchestratorSession(): string { return resolveSession('orchestrator')!; }
