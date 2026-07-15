/**
 * Agent Lifecycle Manager — spawn, monitor, kill, timeout, orphan cleanup.
 *
 * Manages worker agents via SDK adapter and persistent agents (comms/orchestrator)
 * via tmux sessions. Enforces max concurrent agents with FIFO queuing.
 * Records all jobs in SQLite (worker_jobs table).
 *
 * Status transitions:
 *   Workers:    queued → running → completed/failed/timeout
 *   Persistent: idle ↔ busy, stopped, crashed
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  spawnWorker as sdkSpawn,
  killWorker as sdkKill,
  getWorkerStatus as sdkGetStatus,
  removeWorker as sdkRemove,
} from './sdk-adapter.js';
import type { SpawnOptions as SdkSpawnOptions, WorkerState } from './sdk-adapter.js';
import type { AgentProfile } from './profiles.js';
import { get, update, query, exec, getDatabase } from '../core/db.js';
import { resolveProjectPath } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { injectLearnings } from '../self-improvement/pre-task-injector.js';

const log = createLogger('agents:lifecycle');

// ── Autonomy Mode ────────────────────────────────────────────

/**
 * Read the current autonomy mode from .kithkit/state/autonomy.json.
 * Falls back to 'confident' if the file is missing or unreadable.
 */
function getCurrentAutonomyMode(): string {
  try {
    const stateFile = resolveProjectPath('.kithkit', 'state', 'autonomy.json');
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { mode?: string };
    return data.mode || 'confident';
  } catch {
    return 'confident';
  }
}

// ── Types ────────────────────────────────────────────────────

export type AgentType = 'comms' | 'orchestrator' | 'worker';
export type AgentStatus = 'idle' | 'busy' | 'running' | 'stopped' | 'crashed' | 'queued';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout';

export interface AgentRecord {
  id: string;
  type: AgentType;
  profile: string | null;
  status: string;
  tmux_session: string | null;
  pid: number | null;
  started_at: string | null;
  last_activity: string | null;
  state: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobRecord {
  id: string;
  agent_id: string;
  profile: string;
  prompt: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  spawned_by: string | null;
  spawner_notified_at: string | null;
  /** Model the SDK resolved for the session (migration 038); NULL pre-038. */
  resolved_model?: string | null;
  /** Assistant turns consumed (migration 038); NULL pre-038. */
  turns_used?: number | null;
}

export interface SpawnRequest {
  profile: AgentProfile;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  /** Which persistent agent spawned this worker ('comms' | 'orchestrator'). */
  spawned_by?: string;
}

// ── Callbacks ────────────────────────────────────────────────

const onJobCompleteListeners: ((job: JobRecord) => void)[] = [];

/**
 * Register a callback to be invoked after a job reaches a terminal state.
 * Back-compat shim: replaces the entire listener list with [cb], or clears
 * the list when cb is null. Prefer addOnJobComplete for new code.
 */
export function setOnJobComplete(cb: ((job: JobRecord) => void) | null): void {
  onJobCompleteListeners.length = 0;
  if (cb !== null) onJobCompleteListeners.push(cb);
}

/**
 * Append a listener to be called after every terminal job. Multiple listeners
 * are supported; each runs in a separate try/catch so one throwing does not
 * prevent others from firing.
 */
export function addOnJobComplete(cb: (job: JobRecord) => void): void {
  onJobCompleteListeners.push(cb);
}

// ── State ────────────────────────────────────────────────────

let maxConcurrentAgents = 3;
const jobQueue: string[] = []; // FIFO queue of job IDs waiting to run
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
const queuedRequests = new Map<string, SpawnRequest>(); // Stored for deferred start

// Poll interval for checking SDK worker completion
const POLL_INTERVAL_MS = 500;

// Injectable startWorker (overridable for testing spawn-failure containment).
// Function declarations are hoisted, so referencing startWorker here is safe.
let startWorkerFn: (jobId: string, req: SpawnRequest) => void = startWorker;

// ── Config ───────────────────────────────────────────────────

export function setMaxConcurrentAgents(max: number): void {
  maxConcurrentAgents = max;
}

export function getMaxConcurrentAgents(): number {
  return maxConcurrentAgents;
}

// ── Helpers ──────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function countRunningAgents(): number {
  const rows = query<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE status IN ('running', 'busy', 'idle')",
  );
  return rows[0]?.count ?? 0;
}

// ── Session Directories ─────────────────────────────────────

/**
 * Create a session directory for an agent. Returns the absolute path.
 */
export function createSessionDir(agentId: string): string {
  const dir = resolveProjectPath('.claude', 'sessions', agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Clean up session directories older than maxAgeDays.
 */
export function cleanupSessionDirs(maxAgeDays = 7): number {
  const sessionsRoot = resolveProjectPath('.claude', 'sessions');
  if (!fs.existsSync(sessionsRoot)) return 0;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const entry of fs.readdirSync(sessionsRoot)) {
    const entryPath = resolveProjectPath('.claude', 'sessions', entry);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return cleaned;
}

// ── Worker Lifecycle ─────────────────────────────────────────

/**
 * Spawn a worker job. If at capacity, the job is queued.
 * Returns the job ID and initial status.
 *
 * @remarks Changed to async (was sync) to support pre-task memory injection.
 * All callers within the daemon codebase have been updated to await this function.
 */
export async function spawnWorkerJob(req: SpawnRequest): Promise<{ jobId: string; status: JobStatus }> {
  const jobId = randomUUID();
  const ts = now();

  // Create session directory for artifacts
  const sessionDir = createSessionDir(jobId);
  req.prompt = `Session directory (for artifacts if needed): ${sessionDir}\n\n${req.prompt}`;

  // Pre-task memory injection (self-improvement) — augment prompt with past learnings.
  // Wrapped in try/catch: injection failure must not prevent spawn.
  try {
    req.prompt = await injectLearnings(req.prompt, req.profile, getDatabase());
  } catch {
    // injection failure is non-fatal
  }

  // Insert agent record
  exec(
    `INSERT INTO agents (id, type, profile, status, created_at, updated_at)
     VALUES (?, 'worker', ?, 'queued', ?, ?)`,
    jobId, req.profile.name, ts, ts,
  );

  // Insert job record
  exec(
    `INSERT INTO worker_jobs (id, agent_id, profile, prompt, status, spawned_by, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    jobId, jobId, req.profile.name, req.prompt, req.spawned_by ?? null, ts,
  );

  // Try to start immediately or queue
  if (countRunningAgents() < maxConcurrentAgents) {
    try {
      startWorkerFn(jobId, req);
    } catch (err) {
      // sdkSpawn or the DB updates threw. Without this guard the job row
      // stays 'queued' forever with no queue entry and no poll timer — a
      // phantom job that blocks task reconciliation. Fail it loudly instead.
      const msg = `Worker spawn failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error('spawnWorkerJob: startWorker threw — marking job failed', { jobId, error: String(err) });
      finishJob(jobId, 'failed', null, msg);
      return { jobId, status: 'failed' };
    }
    return { jobId, status: 'running' };
  }

  // Queue it — store request for later execution
  queuedRequests.set(jobId, req);
  jobQueue.push(jobId);
  return { jobId, status: 'queued' };
}

/**
 * Actually start a worker via the SDK adapter.
 */
function startWorker(jobId: string, req: SpawnRequest): void {
  const ts = now();

  // Prepend the current autonomy mode so workers can self-enforce it
  const mode = getCurrentAutonomyMode();
  const modePrefix = `Current autonomy mode: ${mode}. You must self-enforce this mode's constraints independently — even if the orchestrator doesn't mention it.\n\n`;

  // Prepend worker output review directive so every worker structures its output
  // for orchestrator review (standing rule — Dave decision 2026-06-01).
  const reviewDirective =
    'Worker output review: when your task involves code changes, git operations, builds, tests, PRs, issues, or any irreversible/outward-facing action, structure your final output to be REVIEWABLE by the orchestrator:\n' +
    '- Summary of what you did (files changed, commands run)\n' +
    '- Diffs or file paths for any code changes\n' +
    '- Exact build/test results (pass/fail counts, any errors)\n' +
    '- PR/issue URLs if created\n' +
    'If the task instructions indicate a review gate is required before an irreversible step (push, merge, deploy, send), STOP before that step and report to the orchestrator for authorization first.\n\n';

  const promptWithMode = modePrefix + reviewDirective + req.prompt;

  // Build SDK spawn options — profile budget is the default, caller can override
  const sdkOpts: SdkSpawnOptions = {
    prompt: promptWithMode,
    profile: {
      name: req.profile.name,
      description: req.profile.description,
      model: req.profile.model,
      allowedTools: req.profile.tools.length > 0 ? req.profile.tools : undefined,
      disallowedTools: req.profile.disallowedTools.length > 0 ? req.profile.disallowedTools : undefined,
      permissionMode: req.profile.permissionMode,
      maxTurns: req.profile.maxTurns,
      effort: req.profile.effort || undefined,
      body: req.profile.body || undefined,
    },
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    // Exposes the worker's profile name to hooks running inside the spawned
    // session (e.g. transcript-review.sh) so they can exclude review/retro-class
    // workers from re-triggering further reviews — see a respawn-loop incident
    // where transcript-review workers were spawned from daemon-spawned agents'
    // tool calls.
    env: { KITHKIT_AGENT_PROFILE: req.profile.name },
  };

  // SDK adapter assigns its own internal ID
  const sdkWorkerId = sdkSpawn(sdkOpts);

  // Update DB records to running
  update('agents', jobId, {
    status: 'running',
    started_at: ts,
    last_activity: ts,
    state: JSON.stringify({ sdkWorkerId }),
    updated_at: ts,
  });

  update('worker_jobs', jobId, {
    status: 'running',
    started_at: ts,
  });

  // Start polling for completion
  startPolling(jobId, sdkWorkerId);
}

/**
 * Poll the SDK adapter for worker status changes and sync to DB.
 */
function startPolling(jobId: string, sdkWorkerId: string): void {
  const timer = setInterval(() => {
    // A tick can fire after the daemon has begun shutting down (DB closed,
    // etc.) if stopAllPolling() lost the race — wrap the body so a late tick
    // logs instead of throwing an uncaughtException (kithkit#2743 incident:
    // dist lifecycle.js:220 "Database not initialized" after closeDatabase()).
    try {
      const sdkState = sdkGetStatus(sdkWorkerId);
      if (!sdkState) {
        finishJob(jobId, 'failed', null, 'Worker disappeared from SDK tracking');
        stopPolling(jobId);
        return;
      }

      if (sdkState.status === 'running') {
        update('agents', jobId, { last_activity: now(), updated_at: now() });
        return;
      }

      // Terminal state reached
      finishJob(jobId, sdkState.status, sdkState.result, sdkState.error, sdkState);
      sdkRemove(sdkWorkerId);
      stopPolling(jobId);
    } catch (err) {
      log.debug('Poll tick failed (likely a late tick during shutdown)', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, POLL_INTERVAL_MS);

  pollTimers.set(jobId, timer);
}

function stopPolling(jobId: string): void {
  const timer = pollTimers.get(jobId);
  if (timer) {
    clearInterval(timer);
    pollTimers.delete(jobId);
  }
}

/**
 * Clear every outstanding poll timer without touching any other lifecycle
 * state (job queue, listeners, etc.) — intended for daemon shutdown, called
 * BEFORE closeDatabase() so no late tick can run update()/get() against a
 * closed database handle (kithkit#2743 incident).
 */
export function stopAllPolling(): void {
  for (const timer of pollTimers.values()) {
    clearInterval(timer);
  }
  pollTimers.clear();
}

/**
 * Mark a job as finished (completed/failed/timeout) and process queue.
 */
function finishJob(
  jobId: string,
  status: 'completed' | 'failed' | 'timeout',
  result: string | null,
  error: string | null,
  sdkState?: WorkerState,
): void {
  const ts = now();

  // Idempotence guard: a job can reach finishJob twice (kill racing the poll
  // timer, spawn-failure path racing a poll tick, future double-finish bugs).
  // A second finish must not overwrite the original terminal result or
  // re-fire job-complete listeners (duplicate retro ingestion / notifications).
  const existing = get<JobRecord>('worker_jobs', jobId);
  if (existing && (existing.status === 'completed' || existing.status === 'failed' || existing.status === 'timeout')) {
    log.warn('finishJob: job already terminal — ignoring duplicate finish', {
      jobId,
      existingStatus: existing.status,
      attemptedStatus: status,
    });
    return;
  }

  update('agents', jobId, {
    status: 'stopped',
    last_activity: ts,
    updated_at: ts,
  });

  update('worker_jobs', jobId, {
    status,
    result: result ?? null,
    error: error ?? null,
    tokens_in: sdkState?.tokensIn ?? 0,
    tokens_out: sdkState?.tokensOut ?? 0,
    cost_usd: sdkState?.costUsd ?? 0,
    resolved_model: sdkState?.resolvedModel ?? null,
    turns_used: sdkState?.turnsUsed ?? null,
    finished_at: ts,
  });

  // Invoke all job-complete listeners (each isolated so one throw can't break others)
  if (onJobCompleteListeners.length > 0) {
    const job = get<JobRecord>('worker_jobs', jobId);
    if (job) {
      for (const listener of [...onJobCompleteListeners]) {
        try {
          listener(job);
        } catch (err) {
          // Individual listener errors must not break the daemon or other
          // listeners — but silent failures here invisibly break downstream
          // loops (retro triggers, task reconciliation), so log them.
          log.warn('finishJob: job-complete listener threw', { jobId, error: String(err) });
        }
      }
    } else {
      log.warn('finishJob: job row missing after update — listeners not notified', { jobId, status });
    }
  }

  // Process queue
  processQueue();
}

/**
 * Process the job queue — start queued jobs if slots are available.
 */
let processingQueue = false; // re-entrancy guard: finishJob → processQueue can nest

function processQueue(): void {
  // A failed startWorker below calls finishJob, which calls processQueue
  // again — the guard turns that nested call into a no-op so the outer
  // loop keeps draining without unbounded recursion.
  if (processingQueue) return;
  processingQueue = true;
  try {
    while (jobQueue.length > 0 && countRunningAgents() < maxConcurrentAgents) {
      const nextJobId = jobQueue.shift()!;

      // Verify job is still queued in DB
      const job = get<JobRecord>('worker_jobs', nextJobId);
      if (!job || job.status !== 'queued') continue;

      const req = queuedRequests.get(nextJobId);
      if (!req) continue;

      queuedRequests.delete(nextJobId);
      try {
        startWorkerFn(nextJobId, req);
      } catch (err) {
        // A single bad spawn must not break the dequeue loop — previously a
        // throw here abandoned every job behind it in the queue.
        log.error('processQueue: startWorker threw — failing job and continuing', {
          jobId: nextJobId,
          error: String(err),
        });
        finishJob(nextJobId, 'failed', null,
          `Worker spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    processingQueue = false;
  }
}

// ── Query ────────────────────────────────────────────────────

/**
 * Get job status with full details.
 */
export function getJobStatus(jobId: string): JobRecord | null {
  return get<JobRecord>('worker_jobs', jobId) ?? null;
}

/**
 * Get agent status.
 */
export function getAgentStatus(agentId: string): AgentRecord | null {
  return get<AgentRecord>('agents', agentId) ?? null;
}

/**
 * List all agents.
 */
export function listAgents(): AgentRecord[] {
  return query<AgentRecord>('SELECT * FROM agents ORDER BY created_at ASC');
}

/**
 * Kill a running worker.
 */
export function killJob(jobId: string): boolean {
  const agent = get<AgentRecord>('agents', jobId);
  if (!agent) return false;

  // If queued, remove from queue
  const queueIdx = jobQueue.indexOf(jobId);
  if (queueIdx !== -1) {
    jobQueue.splice(queueIdx, 1);
    queuedRequests.delete(jobId);
    finishJob(jobId, 'failed', null, 'Killed while queued');
    return true;
  }

  // If running, kill via SDK
  if (agent.status === 'running' && agent.state) {
    try {
      const state = JSON.parse(agent.state);
      if (state.sdkWorkerId) {
        sdkKill(state.sdkWorkerId);
      }
    } catch {
      // state parse error
    }
    finishJob(jobId, 'failed', null, 'Killed by user');
    stopPolling(jobId);
    return true;
  }

  return false;
}

// ── Orphan Cleanup ───────────────────────────────────────────

/**
 * Clean up orphaned agent records on daemon startup.
 * Any agent with active status but no actual process is marked 'crashed'.
 */
export function cleanupOrphanedAgents(): number {
  const orphans = query<AgentRecord>(
    "SELECT * FROM agents WHERE status IN ('running', 'busy', 'idle', 'queued')",
  );

  let cleaned = 0;
  const ts = now();

  for (const agent of orphans) {
    update('agents', agent.id, {
      status: 'crashed',
      updated_at: ts,
    });

    exec(
      "UPDATE worker_jobs SET status = 'failed', error = 'Daemon restarted (orphan cleanup)', finished_at = ? WHERE agent_id = ? AND status IN ('queued', 'running')",
      ts, agent.id,
    );

    cleaned++;
  }

  queuedRequests.clear();
  jobQueue.length = 0;

  return cleaned;
}

// ── Testing ──────────────────────────────────────────────────

export function _resetForTesting(): void {
  for (const timer of pollTimers.values()) {
    clearInterval(timer);
  }
  pollTimers.clear();
  jobQueue.length = 0;
  queuedRequests.clear();
  maxConcurrentAgents = 3;
  onJobCompleteListeners.length = 0;
  startWorkerFn = startWorker;
  processingQueue = false;
}

export function _getQueueLength(): number {
  return jobQueue.length;
}

export function _getPollTimerCount(): number {
  return pollTimers.size;
}

/**
 * @internal Register a bare timer into the pollTimers map for shutdown-hygiene
 * tests (kithkit#2743) — lets tests exercise stopAllPolling()'s clearing
 * behavior deterministically without spinning up the full spawn/SDK path.
 */
export function _registerPollTimerForTesting(jobId: string, timer: ReturnType<typeof setInterval>): void {
  pollTimers.set(jobId, timer);
}

/** @internal Override startWorker for testing spawn-failure containment. Pass null to restore. */
export function _setStartWorkerFnForTesting(fn: ((jobId: string, req: SpawnRequest) => void) | null): void {
  startWorkerFn = fn ?? startWorker;
}

/** @internal Invoke finishJob directly for testing (idempotence guard, queue draining). */
export function _finishJobForTesting(
  jobId: string,
  status: 'completed' | 'failed' | 'timeout',
  result: string | null,
  error: string | null,
): void {
  finishJob(jobId, status, result, error);
}
