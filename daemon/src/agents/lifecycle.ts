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
import { get, update, query, exec } from '../core/db.js';
import { resolveProjectPath } from '../core/config.js';

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
}

export interface SpawnRequest {
  profile: AgentProfile;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  /** Which persistent agent spawned this worker ('comms' | 'orchestrator'). */
  spawned_by?: string;
}

// ── State ────────────────────────────────────────────────────

let maxConcurrentAgents = 3;
const jobQueue: string[] = []; // FIFO queue of job IDs waiting to run
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
const queuedRequests = new Map<string, SpawnRequest>(); // Stored for deferred start

// Poll interval for checking SDK worker completion
const POLL_INTERVAL_MS = 500;

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
 */
export function spawnWorkerJob(req: SpawnRequest): { jobId: string; status: JobStatus } {
  const jobId = randomUUID();
  const ts = now();

  // Create session directory for artifacts
  const sessionDir = createSessionDir(jobId);
  req.prompt = `Session directory (for artifacts if needed): ${sessionDir}\n\n${req.prompt}`;

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
    startWorker(jobId, req);
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

  // Build SDK spawn options — profile budget is the default, caller can override
  const sdkOpts: SdkSpawnOptions = {
    prompt: req.prompt,
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
    maxBudgetUsd: req.maxBudgetUsd ?? req.profile.maxBudgetUsd ?? undefined,
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
    finished_at: ts,
  });

  // Process queue
  processQueue();
}

/**
 * Process the job queue — start queued jobs if slots are available.
 */
function processQueue(): void {
  while (jobQueue.length > 0 && countRunningAgents() < maxConcurrentAgents) {
    const nextJobId = jobQueue.shift()!;

    // Verify job is still queued in DB
    const job = get<JobRecord>('worker_jobs', nextJobId);
    if (!job || job.status !== 'queued') continue;

    const req = queuedRequests.get(nextJobId);
    if (!req) continue;

    queuedRequests.delete(nextJobId);
    startWorker(nextJobId, req);
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
}

export function _getQueueLength(): number {
  return jobQueue.length;
}

export function _getPollTimerCount(): number {
  return pollTimers.size;
}
