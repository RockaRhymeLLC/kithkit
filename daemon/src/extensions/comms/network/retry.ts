/**
 * Cancellable registration retry loop.
 *
 * Extracted into its own module so tests can exercise the loop directly
 * without importing the full agent-extension dependency graph.
 */

import { createLogger } from '../../../core/logger.js';
import type { AgentConfig } from '../../config.js';
import type { RegistrationResult } from './registration.js';
import { recordRetrying } from './network-state.js';

const log = createLogger('network:retry');

/**
 * Sleep for `ms` milliseconds, but resolve immediately if `signal` fires.
 */
export function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Retry `registerFn` up to MAX_RETRIES times with exponential backoff.
 * Calls `onSuccess` if registration succeeds. Cancels immediately when
 * `signal` is aborted (checked before each attempt and during sleep).
 */
export async function runRegistrationRetryLoop(
  config: AgentConfig,
  signal: AbortSignal,
  registerFn: (c: AgentConfig) => Promise<RegistrationResult>,
  onSuccess: (c: AgentConfig) => Promise<void>,
): Promise<void> {
  const MAX_RETRIES = 10;
  const INITIAL_DELAY_MS = 5_000;        // 5s
  const MAX_DELAY_MS = 5 * 60 * 1_000;  // 5min cap
  let attempt = 0;
  let delay = INITIAL_DELAY_MS;

  while (attempt < MAX_RETRIES) {
    if (signal.aborted) {
      log.info('Network registration cancelled (shutdown)');
      return;
    }

    const result = await registerFn(config);
    if (result.ok) {
      log.info('Network registration succeeded', { attempt: attempt + 1 });
      await onSuccess(config);
      return;
    }

    attempt++;
    if (attempt >= MAX_RETRIES) {
      log.warn('Network registration giving up after retries', { attempts: attempt, lastError: result.error });
      return;
    }

    for (const c of config.network?.communities ?? []) recordRetrying(c.name);
    log.warn('Network registration failed, retrying', { attempt, nextDelayMs: delay, error: result.error });

    await sleepCancellable(delay, signal);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
}
