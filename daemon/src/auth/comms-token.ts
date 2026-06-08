/**
 * Comms token bootstrap — mints and validates the long-lived comms-agent token.
 *
 * The comms agent authenticates /api/send calls using a token stored at
 * .kithkit/.comms-token (mode 0600). This module provides:
 *   - bootstrapCommsToken: idempotently provisions the token file on daemon start
 *   - assertCommsTokenReady: fail-loud guard that aborts startup if provisioning failed
 *
 * Extracted from daemon/src/main.ts startup sequence for testability.
 * Re-added in fix/kkit388 after the minter was silently dropped in the #1991 merge (4564d7dc).
 *
 * History: bootstrapCommsToken() was introduced in commit c1c26b26 alongside the
 * /api/send comms-token auth gate. The gate was kept in the #1991 rewrite but the
 * minter was lost, leaving fresh installs and DB-wiped deployments unable to send
 * via /api/send (401 with no indication at startup).
 */

import fs from 'node:fs';
import path from 'node:path';
import { issueToken, verifyToken } from './agent-tokens.js';

// ── Test environment detection ────────────────────────────────────────────────
// Local copy — same pattern as agents/tmux.ts and core/session-bridge.ts.

function isUnderTestRunner(): boolean {
  return (
    process.env.NODE_TEST_CONTEXT !== undefined ||  // node --test child process
    process.env.JEST_WORKER_ID !== undefined ||      // Jest
    process.env.VITEST !== undefined ||              // Vitest
    process.env.VITEST_WORKER_ID !== undefined ||   // Vitest worker
    process.env.NODE_ENV === 'test'                  // Generic test env
  );
}

// ── Logger shape (minimal — matches createLogger() return type) ───────────────

interface MinimalLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Idempotently provision the comms-role token file at .kithkit/.comms-token.
 *
 * - If the file already exists and its token passes verifyToken(), returns early (no re-mint).
 * - Otherwise: mints a fresh comms token, writes it atomically via a .tmp rename, chmods 0600.
 * - Errors are caught and logged as warnings; the hard stop on failure is delegated to
 *   assertCommsTokenReady(), which should be called immediately after this function.
 *
 * The token is used by the comms agent to authenticate calls to POST /api/send.
 * Workers and orchestrators cannot use /api/send — they must escalate via /api/messages.
 */
export function bootstrapCommsToken(projectDir: string, log: MinimalLogger): void {
  const tokenPath = path.join(projectDir, '.kithkit', '.comms-token');
  const tokenDir = path.dirname(tokenPath);
  try {
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    if (fs.existsSync(tokenPath)) {
      try {
        const existingToken = fs.readFileSync(tokenPath, 'utf8').trim();
        if (existingToken && verifyToken(existingToken)) {
          return; // Token already valid — nothing to do
        }
      } catch {
        // Unreadable or invalid — fall through to regenerate
      }
    }
    const newToken = issueToken('comms');
    const tmpPath = tokenPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, newToken, { mode: 0o600 });
    fs.renameSync(tmpPath, tokenPath);
    fs.chmodSync(tokenPath, 0o600);
    log.info('Comms token initialized', { path: tokenPath });
  } catch (err) {
    log.warn('Failed to bootstrap comms token', {
      path: tokenPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fail-loud invariant: asserts the comms token is ready after bootstrapCommsToken().
 *
 * In production (non-test runtime): logs error and calls process.exit(1) if the token
 * file is absent or its contents do not pass verifyToken(). This ensures a broken
 * provision is impossible to miss at startup — the daemon will not start silently broken.
 *
 * In test runner: throws an Error instead of exiting so tests can exercise this path
 * without killing the test process. All standard test runners (node --test, Jest, Vitest)
 * set environment markers that isUnderTestRunner() detects.
 *
 * Placement in main.ts: immediately after bootstrapCommsToken(), before server init.
 */
export function assertCommsTokenReady(tokenPath: string, log: MinimalLogger): void {
  let checkError: Error | null = null;
  try {
    if (!fs.existsSync(tokenPath)) {
      checkError = new Error(`Token file absent: ${tokenPath}`);
    } else {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (!token || !verifyToken(token)) {
        checkError = new Error(`Token at ${tokenPath} is empty or did not pass verifyToken`);
      }
    }
  } catch (err) {
    checkError = err instanceof Error ? err : new Error(String(err));
  }

  if (checkError !== null) {
    log.error('FATAL: comms token not ready after bootstrap', {
      path: tokenPath,
      error: checkError.message,
    });
    if (isUnderTestRunner()) {
      throw new Error(`FATAL: comms token not ready after bootstrap: ${checkError.message}`);
    }
    process.exit(1);
  }
}
