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
 */

import { query as _sdkQuery, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

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
  /** Optional effort level */
  effort?: string;
}

export interface SpawnOptions {
  prompt: string;
  profile: WorkerProfile;
  cwd?: string;
  /** Inactivity timeout in ms (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Max budget in USD */
  maxBudgetUsd?: number;
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

// ── Internal state ───────────────────────────────────────────

interface ActiveWorker {
  id: string;
  controller: AbortController;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  state: WorkerState;
}

const workers = new Map<string, ActiveWorker>();

// Default inactivity timeout: 5 minutes
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────

function resetInactivityTimer(worker: ActiveWorker, timeoutMs: number): void {
  if (worker.inactivityTimer) clearTimeout(worker.inactivityTimer);
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
}

// ── Public API ───────────────────────────────────────────────

/**
 * Spawn a worker using the Agent SDK.
 * Returns the job ID immediately. The worker runs asynchronously.
 */
export function spawnWorker(opts: SpawnOptions): string {
  const id = randomUUID();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  const worker: ActiveWorker = { id, controller, inactivityTimer: null, state };
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
  if (opts.profile.maxTurns) sdkOptions.maxTurns = opts.profile.maxTurns;
  if (opts.profile.effort) sdkOptions.effort = opts.profile.effort;
  if (opts.maxBudgetUsd !== undefined) sdkOptions.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts.cwd) sdkOptions.cwd = opts.cwd;

  if (opts.profile.permissionMode === 'bypassPermissions') {
    sdkOptions.permissionMode = 'bypassPermissions';
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else if (opts.profile.permissionMode) {
    sdkOptions.permissionMode = opts.profile.permissionMode;
  }

  // Start the worker asynchronously
  resetInactivityTimer(worker, timeoutMs);

  runWorker(worker, opts.prompt, sdkOptions, timeoutMs).catch(() => {
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
): Promise<void> {
  try {
    _lastSdkCallArgs = { prompt, options: sdkOptions };
    const q = sdkQueryFn({ prompt, options: sdkOptions });

    for await (const message of q) {
      // Reset inactivity timer on any message
      resetInactivityTimer(worker, timeoutMs);

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

/** Expose internals for testing (allows mocking). */
export const _internals = {
  get workers() { return workers; },
};
