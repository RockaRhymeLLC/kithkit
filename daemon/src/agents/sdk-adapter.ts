/**
 * SDK Adapter — thin wrapper around @anthropic-ai/claude-agent-sdk.
 *
 * Single file that isolates all Agent SDK interactions.
 * Exposes: spawnWorker(), killWorker(), getWorkerStatus().
 *
 * Handles:
 * - AbortController lifecycle
 * - Token usage capture from SDK result messages
 * - Cost tracking
 * - Inactivity timeout (kills workers with no output for N minutes)
 * - Profile options → SDK options mapping
 * - Cap-approaching warning injection (Worker B 2026-05-12)
 */

import { query as _sdkQuery, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { getCaps } from '../core/config.js';

export { AbortError };

// Injectable SDK query function (for testing)
type QueryFn = (args: { prompt: string; options?: unknown }) => AsyncGenerator<SDKMessage, void>;
let sdkQueryFn: QueryFn = _sdkQuery as unknown as QueryFn;

// ── Types ────────────────────────────────────────────────────

export interface WorkerProfile {
  name: string;
  description?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  maxTurns?: number;
  /** Controls how much effort Claude puts into responses */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Profile body text appended to system prompt */
  body?: string;
}

export interface SpawnOptions {
  prompt: string;
  profile: WorkerProfile;
  cwd?: string;
  /** Inactivity timeout in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
}

export type WorkerStatus = 'running' | 'completed' | 'failed' | 'timeout';

export interface WorkerState {
  id: string;
  profile: string;
  prompt: string;
  status: WorkerStatus;
  result: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

// ── Cap warning state ─────────────────────────────────────────

/**
 * Cap-approaching warning mechanic (Worker B 2026-05-12):
 * - turns_used increments on each 'assistant' message; cap = caps.profiles[name]?.max_turns ?? frontmatter maxTurns
 * - When turns_used/cap >= warning_threshold_pct/100 AND turn_warning_fired=false → inject system-reminder, mark fired
 * - Inactivity warning fires at threshold%*timeoutMs via a parallel setTimeout; resets with inactivity timer
 * - Injection uses Query.streamInput() (SDK control API); no-op if streamInput unavailable (test mocks, old SDK)
 * - Per-job state { turn_warning_fired, inactivity_warning_fired, turns_used } lives on the ActiveWorker struct
 */
interface CapWarningState {
  turn_warning_fired: boolean;
  inactivity_warning_fired: boolean;
  turns_used: number;
}

function buildCapWarningText(
  kind: 'turns' | 'seconds of inactivity',
  used: number,
  cap: number,
  ratio: number,
): string {
  const P = Math.round(ratio * 100);
  return (
    `[Cap warning] You have used ${used}/${cap} ${kind} (${P}%). ` +
    `The cap is a firewall, not a target — wrap up gracefully now: ` +
    `commit any work in progress, push, and report results to your spawner before the cap is hit.`
  );
}

/**
 * Inject a system-reminder into the SDK conversation via Query.streamInput().
 * No-op if the query object does not expose streamInput (e.g. test mocks, older SDK).
 * Fire-and-forget — never throws; errors are silently swallowed.
 */
function injectCapWarning(
  q: AsyncGenerator<SDKMessage, void>,
  text: string,
): void {
  // Cast to SDK Query interface — streamInput is only present on the real SDK Query,
  // not on plain AsyncGenerator mocks used in tests.
  const queryObj = q as unknown as {
    streamInput?: (stream: AsyncIterable<unknown>) => Promise<void>;
  };
  if (typeof queryObj.streamInput !== 'function') return;

  async function* warningStream() {
    yield {
      type: 'user' as const,
      message: {
        role: 'user' as const,
        content: `<system-reminder>\n${text}\n</system-reminder>`,
      },
      parent_tool_use_id: null,
      isSynthetic: true,
      // shouldQuery: false → appended to transcript, merged into next user turn
      // without forcing an immediate extra assistant response.
      shouldQuery: false,
    };
  }

  // Fire-and-forget; injection is best-effort and must not block the message loop.
  queryObj.streamInput(warningStream()).catch(() => {});
}

// ── Internal state ───────────────────────────────────────────

interface ActiveWorker {
  id: string;
  controller: AbortController;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  /** Parallel timer that fires at warning_threshold_pct% of inactivity_timeout_ms. */
  inactivityWarningTimer: ReturnType<typeof setTimeout> | null;
  state: WorkerState;
  /** Per-job cap warning tracking. */
  capState: CapWarningState;
  /** Reference to the live SDK query — set in runWorker, used for warning injection. */
  query: AsyncGenerator<SDKMessage, void> | null;
}

const workers = new Map<string, ActiveWorker>();

// Inactivity timeout is now read from caps config (caps.inactivity_timeout_ms).
// Hardcoded fallback removed — use getCaps() at call site.

// ── Helpers ──────────────────────────────────────────────────

function resetInactivityTimer(worker: ActiveWorker, timeoutMs: number): void {
  if (worker.inactivityTimer) clearTimeout(worker.inactivityTimer);
  if (worker.inactivityWarningTimer) clearTimeout(worker.inactivityWarningTimer);

  const caps = getCaps();
  const warningMs = Math.floor(timeoutMs * caps.warning_threshold_pct / 100);

  // Warning timer: fires at threshold% of inactivity budget.
  worker.inactivityWarningTimer = setTimeout(() => {
    if (!worker.capState.inactivity_warning_fired && worker.query) {
      const usedSec = Math.round(warningMs / 1000);
      const capSec = Math.round(timeoutMs / 1000);
      const text = buildCapWarningText(
        'seconds of inactivity',
        usedSec,
        capSec,
        caps.warning_threshold_pct / 100,
      );
      worker.capState.inactivity_warning_fired = true;
      injectCapWarning(worker.query, text);
    }
  }, warningMs);

  // Kill timer: fires at 100% of inactivity budget.
  worker.inactivityTimer = setTimeout(() => {
    worker.state.status = 'timeout';
    worker.state.error = `Inactivity timeout after ${timeoutMs}ms`;
    worker.state.finishedAt = new Date().toISOString();
    worker.controller.abort();
  }, timeoutMs);
}

function clearInactivityTimer(worker: ActiveWorker): void {
  if (worker.inactivityTimer) {
    clearTimeout(worker.inactivityTimer);
    worker.inactivityTimer = null;
  }
  if (worker.inactivityWarningTimer) {
    clearTimeout(worker.inactivityWarningTimer);
    worker.inactivityWarningTimer = null;
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Spawn a worker using the Agent SDK.
 * Returns the job ID immediately. The worker runs asynchronously.
 */
export function spawnWorker(opts: SpawnOptions): string {
  const id = randomUUID();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? getCaps().inactivity_timeout_ms;

  const state: WorkerState = {
    id,
    profile: opts.profile.name,
    prompt: opts.prompt,
    status: 'running',
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  const worker: ActiveWorker = {
    id,
    controller,
    inactivityTimer: null,
    inactivityWarningTimer: null,
    state,
    capState: { turn_warning_fired: false, inactivity_warning_fired: false, turns_used: 0 },
    query: null,
  };
  workers.set(id, worker);

  // Build SDK options from profile
  const sdkOptions: Record<string, unknown> = {
    abortController: controller,
    systemPrompt: {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      ...(opts.profile.body ? { append: opts.profile.body } : {}),
    },
    settingSources: ['project' as const],
  };

  if (opts.profile.model) sdkOptions.model = opts.profile.model;
  if (opts.profile.allowedTools) sdkOptions.allowedTools = opts.profile.allowedTools;
  if (opts.profile.disallowedTools) sdkOptions.disallowedTools = opts.profile.disallowedTools;
  // Config-driven cap takes precedence over profile frontmatter (back-compat fallback).
  const caps = getCaps();
  const effectiveMaxTurns = caps.profiles[opts.profile.name]?.max_turns ?? opts.profile.maxTurns;
  if (effectiveMaxTurns) sdkOptions.maxTurns = effectiveMaxTurns;
  if (opts.profile.effort) sdkOptions.effort = opts.profile.effort;
  if (opts.cwd) sdkOptions.cwd = opts.cwd;

  if (opts.profile.permissionMode === 'bypassPermissions') {
    sdkOptions.permissionMode = 'bypassPermissions';
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else if (opts.profile.permissionMode) {
    sdkOptions.permissionMode = opts.profile.permissionMode;
  }

  // Start the worker asynchronously
  resetInactivityTimer(worker, timeoutMs);

  runWorker(worker, opts.prompt, sdkOptions, timeoutMs, effectiveMaxTurns).catch(() => {
    // Errors already captured in worker state
  });

  return id;
}

/**
 * Run the SDK query and capture results.
 * This is fire-and-forget — errors are captured in worker state.
 */
async function runWorker(
  worker: ActiveWorker,
  prompt: string,
  sdkOptions: Record<string, unknown>,
  timeoutMs: number,
  effectiveMaxTurns: number | undefined,
): Promise<void> {
  try {
    _lastSdkCallArgs = { prompt, options: sdkOptions };
    const q = sdkQueryFn({ prompt, options: sdkOptions });
    worker.query = q;

    const caps = getCaps();
    const warningThreshold = caps.warning_threshold_pct / 100;

    for await (const message of q) {
      // Reset inactivity timers on any message
      resetInactivityTimer(worker, timeoutMs);

      // Count assistant turns and check turn-based cap warning.
      if (message.type === 'assistant') {
        worker.capState.turns_used++;

        if (
          effectiveMaxTurns !== undefined &&
          !worker.capState.turn_warning_fired &&
          worker.capState.turns_used / effectiveMaxTurns >= warningThreshold
        ) {
          const ratio = worker.capState.turns_used / effectiveMaxTurns;
          const text = buildCapWarningText('turns', worker.capState.turns_used, effectiveMaxTurns, ratio);
          worker.capState.turn_warning_fired = true;
          injectCapWarning(q, text);
        }
      }

      // Capture result message
      if (message.type === 'result') {
        const resultMsg = message as SDKMessage & {
          subtype?: string;
          result?: string;
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        worker.state.tokensIn = resultMsg.usage?.input_tokens ?? 0;
        worker.state.tokensOut = resultMsg.usage?.output_tokens ?? 0;
        worker.state.costUsd = resultMsg.total_cost_usd ?? 0;

        if (resultMsg.subtype === 'success') {
          worker.state.status = 'completed';
          worker.state.result = resultMsg.result ?? '';
        } else {
          worker.state.status = 'failed';
          worker.state.error = resultMsg.result ?? `SDK error: ${resultMsg.subtype}`;
        }
      }
    }

    // If no result message was received, mark as completed
    if (worker.state.status === 'running') {
      worker.state.status = 'completed';
    }
  } catch (err) {
    // Don't overwrite timeout status
    if (worker.state.status === 'timeout') return;

    worker.state.status = 'failed';
    if (err instanceof AbortError) {
      worker.state.error = 'Aborted';
    } else {
      worker.state.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearInactivityTimer(worker);
    worker.query = null;
    worker.state.finishedAt ??= new Date().toISOString();
  }
}

/**
 * Kill a running worker by aborting its AbortController.
 */
export function killWorker(id: string): boolean {
  const worker = workers.get(id);
  if (!worker) return false;
  if (worker.state.status !== 'running') return false;

  clearInactivityTimer(worker);
  worker.state.status = 'failed';
  worker.state.error = 'Aborted';
  worker.state.finishedAt = new Date().toISOString();
  worker.controller.abort();
  return true;
}

/**
 * Get the current status of a worker.
 */
export function getWorkerStatus(id: string): WorkerState | null {
  const worker = workers.get(id);
  return worker?.state ?? null;
}

/**
 * List all workers (active and completed).
 */
export function listWorkers(): WorkerState[] {
  return Array.from(workers.values()).map(w => w.state);
}

/**
 * Remove a completed/failed worker from tracking.
 */
export function removeWorker(id: string): boolean {
  const worker = workers.get(id);
  if (!worker) return false;
  if (worker.state.status === 'running') return false;
  workers.delete(id);
  return true;
}

/** Reset for testing. */
export function _resetWorkersForTesting(): void {
  for (const worker of workers.values()) {
    clearInactivityTimer(worker);
    if (worker.state.status === 'running') {
      worker.controller.abort();
    }
  }
  workers.clear();
}

/** Replace the SDK query function (for testing). */
export function _setQueryFnForTesting(fn: QueryFn | null): void {
  sdkQueryFn = fn ?? (_sdkQuery as unknown as QueryFn);
}

// Captured SDK call args for test verification
let _lastSdkCallArgs: { prompt: string; options: unknown } | null = null;

/** Get the last SDK call args (for testing). */
export function _getLastSdkCallArgs(): { prompt: string; options: unknown } | null {
  return _lastSdkCallArgs;
}

/** Get the cap warning state for a worker (for testing). */
export function _getCapWarningStateForTesting(id: string): CapWarningState | null {
  return workers.get(id)?.capState ?? null;
}

/** Expose internals for testing (allows mocking). */
export const _internals = {
  get workers() { return workers; },
};
