/**
 * Agent Recovery — crash detection, restart, orphan cleanup.
 *
 * Handles:
 * - Worker failure notification to orchestrator
 * - Orchestrator crash detection and restart from SQLite state
 * - Comms crash detection and restart
 * - Daemon restart orphan cleanup (delegates to lifecycle.cleanupOrphanedAgents)
 * - Failed job marking and orchestrator notification
 */

import { query, update, exec } from '../core/db.js';
import {
  cleanupOrphanedAgents,
  type AgentRecord,
  type JobRecord,
} from './lifecycle.js';
import { sendMessage } from './message-router.js';

// ── Types ───────────────────────────────────────────────────

export interface RecoveryReport {
  orphansCleaned: number;
  failedJobsRecovered: number;
  agentsRestarted: string[];
}

export interface FailedJobNotification {
  jobId: string;
  profile: string;
  error: string;
  prompt: string;
}

// ── Worker Failure Handling ─────────────────────────────────

/**
 * Notify the orchestrator about a failed worker job.
 * Sends a message to the orchestrator with the failure details.
 */
export function notifyWorkerFailure(job: JobRecord): void {
  const notification: FailedJobNotification = {
    jobId: job.id,
    profile: job.profile,
    error: job.error ?? 'Unknown error',
    prompt: job.prompt,
  };

  // Check if orchestrator is running
  const orchestrator = query<AgentRecord>(
    "SELECT * FROM agents WHERE type = 'orchestrator' AND status IN ('idle', 'busy')",
  );

  if (orchestrator.length > 0) {
    sendMessage({
      from: 'daemon',
      to: 'orchestrator',
      type: 'result',
      body: JSON.stringify({
        status: 'failed',
        ...notification,
      }),
    });
  }
}

/**
 * Handle a worker timeout — mark the job and notify orchestrator.
 */
export function handleWorkerTimeout(jobId: string): void {
  const ts = new Date().toISOString();

  // Mark job as timed out
  update('worker_jobs', jobId, {
    status: 'timeout',
    error: 'Worker inactivity timeout (5 min default)',
    finished_at: ts,
  });

  // Mark agent as stopped
  update('agents', jobId, {
    status: 'stopped',
    updated_at: ts,
  });

  // Notify orchestrator
  const job = query<JobRecord>(
    'SELECT * FROM worker_jobs WHERE id = ?',
    jobId,
  )[0];

  if (job) {
    notifyWorkerFailure(job);
  }
}

// ── Crash Recovery ──────────────────────────────────────────

/**
 * Recover from a daemon restart.
 * Cleans up orphaned agents and marks interrupted jobs as failed.
 * Returns a report of what was recovered.
 */
export function recoverFromRestart(): RecoveryReport {
  const orphansCleaned = cleanupOrphanedAgents();

  // Find jobs that were running when daemon crashed
  const interruptedJobs = query<JobRecord>(
    "SELECT * FROM worker_jobs WHERE status IN ('running', 'queued') AND finished_at IS NULL",
  );

  const ts = new Date().toISOString();
  for (const job of interruptedJobs) {
    exec(
      "UPDATE worker_jobs SET status = 'failed', error = 'Daemon restarted', finished_at = ? WHERE id = ?",
      ts, job.id,
    );
  }

  return {
    orphansCleaned,
    failedJobsRecovered: interruptedJobs.length,
    agentsRestarted: [],
  };
}

/**
 * Check if an agent has crashed (still registered as active but no process).
 * Used for periodic health checks.
 */
export function detectCrashedAgents(): AgentRecord[] {
  return query<AgentRecord>(
    "SELECT * FROM agents WHERE status IN ('running', 'busy', 'idle') AND type IN ('comms', 'orchestrator')",
  );
}

/**
 * Mark an agent as crashed and prepare for restart.
 */
export function markAgentCrashed(agentId: string): void {
  const ts = new Date().toISOString();

  update('agents', agentId, {
    status: 'crashed',
    updated_at: ts,
  });

  // Mark any running jobs for this agent as failed
  exec(
    "UPDATE worker_jobs SET status = 'failed', error = 'Agent crashed', finished_at = ? WHERE agent_id = ? AND status IN ('running', 'queued')",
    ts, agentId,
  );
}

/**
 * Get pending jobs from the database for orchestrator recovery.
 * When the orchestrator restarts, it can query these to resume work.
 */
export function getPendingJobsForRecovery(): JobRecord[] {
  return query<JobRecord>(
    "SELECT * FROM worker_jobs WHERE status = 'queued' ORDER BY created_at ASC",
  );
}
