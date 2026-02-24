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
 * All operations accept an optional session name, defaulting to the
 * agent name from config.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, getProjectDir } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('session-bridge');

// ── Test helpers ──────────────────────────────────────────────
/** @internal Exposed for unit testing. */
export const _testHelpers = {
  getTranscriptDir,
};

/** Reset module state for testing. */
export function _resetForTesting(): void {
  _tmuxPath = null;
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
  // Prefer tmux.session (matches shell scripts), fall back to agent name
  const tmux = (config as unknown as Record<string, unknown>).tmux as { session?: string } | undefined;
  return tmux?.session ?? config.agent.name;
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

// ── Public API ──────────────────────────────────────────────

/**
 * Check if a tmux session exists.
 * @param name - Session name (defaults to agent name from config)
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
 * @param name - Session name (defaults to agent name from config)
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
 * @param options.name - Session name (defaults to agent name from config)
 * @param options.pressEnter - Whether to press Enter after (default: true)
 */
export function injectText(
  text: string,
  options?: { name?: string; pressEnter?: boolean },
): boolean {
  const session = validateSessionName(options?.name ?? getDefaultSessionName());
  const pressEnter = options?.pressEnter ?? true;
  const tmux = getTmuxPath();

  if (!sessionExists(session)) {
    log.warn('Cannot inject: no tmux session', { session });
    return false;
  }

  try {
    const stamped = `${estTimestamp()} ${text}`;
    execFileSync(tmux, ['send-keys', '-t', `${session}:`, '-l', stamped], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (pressEnter) {
      execFileSync('/bin/sleep', ['0.3'], { stdio: ['pipe', 'pipe', 'pipe'] });

      const MAX_ENTER_ATTEMPTS = 3;
      const ENTER_DELAYS = [300, 500, 800];
      for (let attempt = 1; attempt <= MAX_ENTER_ATTEMPTS; attempt++) {
        execFileSync(tmux, ['send-keys', '-t', `${session}:`, 'Enter'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const delay = ENTER_DELAYS[attempt - 1] ?? 800;
        execFileSync('/bin/sleep', [String(delay / 1000)], { stdio: ['pipe', 'pipe', 'pipe'] });

        if (attempt < MAX_ENTER_ATTEMPTS) {
          const pane = capturePane(session);
          const lines = pane.split('\n').filter(l => l.trim().length > 0);
          const lastLines = lines.slice(-5);
          const textStillPending = lastLines.some(l => l.includes(text.slice(0, 40)));
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
 * @param name - Session name (defaults to agent name from config)
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
