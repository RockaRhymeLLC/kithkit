/**
 * Context Watchdog — monitors context usage with escalating actions.
 *
 * Monitors BOTH comms and orchestrator sessions independently.
 *
 * Comms tiers:
 * - 50% used → gentle heads-up ("start wrapping up")
 * - 65% used → auto /restart (which saves state first, then restarts)
 *
 * Orchestrator tiers:
 * - 60% used → heads-up ("save state soon") + notify comms
 * - 70% used → save state and exit ("write orchestrator-state.md and exit") + notify comms
 *
 * The orchestrator gets earlier warnings because:
 * - It has no /restart skill — it must self-manage via state save + exit
 * - The daemon's backstop (orchestrator-idle at 65%) is the hard kill
 * - Graceful save at 70% gives headroom before the 65% backstop
 *
 * Each tier fires once per session (tracked by session_id).
 *
 * The watchdog reads context-usage.json (comms) and context-usage-orch.json
 * (orchestrator), both written by the statusline script on every turn.
 *
 * DEPENDENCY: Requires statusLine in .claude/settings.json to point to
 * scripts/context-monitor-statusline.sh, which writes the JSON state files
 * this watchdog reads. Without this, the watchdog silently no-ops.
 *
 * Wedge detector (fix(2), #2304/#1946/#448):
 * The existing monitors only detect a DEAD orchestrator or log stale tasks.
 * During incident #1946 the orch reported alive=true the ENTIRE wedge —
 * nothing fired for hours. The wedge detector fills this gap:
 *   - Runs in monitorOrchestratorWedge() on every watchdog tick
 *   - Detects ALIVE orch with any of:
 *       (i)  an in_progress task whose MAX(updated_at) has not advanced for N min
 *       (ii) agents.last_activity frozen for N min
 *       (iii) pane shows feedback prompt or garbled literal tool XML
 *   - When wedged → AUTO-RESTART (not nudge): kill + respawn + update started_at
 *   - N is config.wedge_timeout_minutes (default 15)
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { injectText } from '../../core/session-bridge.js';
import {
  injectMessage,
  isOrchestratorAlive as _isOrchestratorAlive,
  killOrchestratorSession as _killOrchestratorSession,
  spawnOrchestratorSession as _spawnOrchestratorSession,
  captureOrchestratorPane as _captureOrchestratorPane,
} from '../../agents/tmux.js';
import { query, update, exec } from '../../core/db.js';
import { sendMessage as _sendMessageImpl } from '../../agents/message-router.js';
import { logActivity } from '../../api/activity.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';
import { _IN_PROGRESS_NO_PROGRESS_BUDGET } from './orchestrator-idle.js';

const log = createLogger('context-watchdog');

// Generous staleness window — the real protection is session_id tracking.
// Only skip if the file is over 1 hour old (session likely dead/restarted).
const STALE_SECONDS = 3600;

interface Tier {
  threshold: number;
  message: (used: number, remaining: number) => string;
}

// ── Comms tiers ──────────────────────────────────────────────

const COMMS_TIERS: Tier[] = [
  {
    threshold: 50,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Start wrapping up your current task.`,
  },
  {
    threshold: 65,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Run /restart now.`,
  },
];

// ── Orchestrator tiers ───────────────────────────────────────

const ORCH_TIERS: Tier[] = [
  {
    threshold: 60,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Start wrapping up — save orchestrator-state.md soon.`,
  },
  {
    threshold: 70,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Save state NOW: write .kithkit/state/orchestrator-state.md with your task, completed steps, in-progress work, next steps, files modified, and key context. Then send a progress summary to comms and exit cleanly.`,
  },
];

// Track which tiers have fired for each session (comms and orchestrator independently)
let commsFiredTiers: Set<number> = new Set();
let commsSessionId: string | null = null;

let orchFiredTiers: Set<number> = new Set();
let orchSessionId: string | null = null;

// Track consecutive misses to warn about persistent missing state files
let commsFileMissCount = 0;
let orchFileMissCount = 0;
const MISS_WARN_THRESHOLD = 3; // Warn after 3 consecutive misses (~9 minutes with 3m interval)

interface ContextData {
  remaining_percentage?: number;
  used_percentage?: number;
  session_id?: string;
}

/**
 * Read and validate a context usage file. Returns null if missing, stale, or invalid.
 */
function readContextFile(filePath: string): ContextData | null {
  if (!fs.existsSync(filePath)) return null;

  const stats = fs.statSync(filePath);
  const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
  if (ageSeconds > STALE_SECONDS) {
    log.debug('Context usage file stale', { file: filePath, ageMinutes: Math.round(ageSeconds / 60) });
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn('Failed to parse context usage file', { file: filePath, error: String(err) });
    return null;
  }
}

/**
 * Monitor comms agent context usage.
 */
function monitorComms(): void {
  const stateFile = resolveProjectPath('.kithkit', 'state', 'context-usage.json');
  const data = readContextFile(stateFile);
  if (!data) {
    commsFileMissCount++;
    if (commsFileMissCount === MISS_WARN_THRESHOLD) {
      log.warn(
        'Context usage file missing for comms agent — watchdog cannot monitor context. ' +
        'Ensure statusLine in .claude/settings.json points to scripts/context-monitor-statusline.sh',
        { file: stateFile, consecutiveMisses: commsFileMissCount },
      );
    }
    return;
  }
  commsFileMissCount = 0; // Reset on successful read

  const remaining = data.remaining_percentage ?? 100;
  const used = data.used_percentage ?? 0;
  const sessionId = data.session_id ?? 'unknown';

  // New session — reset tracking
  if (sessionId !== commsSessionId) {
    if (commsSessionId !== null) {
      log.info('New comms session detected — resetting tier tracking', { oldSession: commsSessionId, newSession: sessionId });
    }
    commsFiredTiers = new Set();
    commsSessionId = sessionId;
  }

  // Process tiers
  for (const tier of COMMS_TIERS) {
    if (used >= tier.threshold && !commsFiredTiers.has(tier.threshold)) {
      log.info(`Comms context ${used}% used — firing tier ${tier.threshold}%`);
      const injected = injectText(tier.message(used, remaining));
      if (injected) {
        commsFiredTiers.add(tier.threshold);
      } else {
        log.warn(`Failed to inject comms tier ${tier.threshold}% message — will retry next tick`);
      }
    }
  }
}

/**
 * Monitor orchestrator context usage.
 * Only runs when the orchestrator is alive. Uses injectMessage() to send
 * warnings to the orchestrator's tmux session (not the comms session).
 */
function monitorOrchestrator(): void {
  if (!_isOrchestratorAlive()) {
    // Reset tracking when orchestrator dies — next spawn is a new session
    if (orchSessionId !== null) {
      orchFiredTiers = new Set();
      orchSessionId = null;
    }
    return;
  }

  const stateFile = resolveProjectPath('.kithkit', 'state', 'context-usage-orch.json');
  const data = readContextFile(stateFile);
  if (!data) {
    orchFileMissCount++;
    if (orchFileMissCount === MISS_WARN_THRESHOLD) {
      log.warn(
        'Context usage file missing for orchestrator — watchdog cannot monitor orchestrator context. ' +
        'Ensure the orchestrator statusLine is configured correctly.',
        { file: stateFile, consecutiveMisses: orchFileMissCount },
      );
    }
    return;
  }
  orchFileMissCount = 0; // Reset on successful read

  const remaining = data.remaining_percentage ?? 100;
  const used = data.used_percentage ?? 0;
  const sessionId = data.session_id ?? 'unknown';

  // New session — reset tracking
  if (sessionId !== orchSessionId) {
    if (orchSessionId !== null) {
      log.info('New orchestrator session detected — resetting tier tracking', { oldSession: orchSessionId, newSession: sessionId });
    }
    orchFiredTiers = new Set();
    orchSessionId = sessionId;
  }

  // Process tiers — inject into orchestrator session AND notify comms
  for (const tier of ORCH_TIERS) {
    if (used >= tier.threshold && !orchFiredTiers.has(tier.threshold)) {
      log.info(`Orchestrator context ${used}% used — firing tier ${tier.threshold}%`);
      const injected = injectMessage('orchestrator', tier.message(used, remaining));
      if (injected) {
        orchFiredTiers.add(tier.threshold);
        // Also notify comms so it has visibility into orchestrator context usage
        const commsNote =
          tier.threshold >= 70
            ? `[orch context: ${used}% — finishing up and exiting]`
            : `[orch context: ${used}% — heads up]`;
        injectText(commsNote);
      } else {
        log.warn(`Failed to inject orchestrator tier ${tier.threshold}% message — will retry next tick`);
      }
    }
  }
}

// ── Wedge Detector (fix(2)) ────────────────────────────────────────────────────
//
// Detects an ALIVE orchestrator that is frozen / stuck:
//   (i)   A task in status in_progress whose MAX(updated_at) is older than N minutes
//   (ii)  agents.last_activity is older than N minutes (while orch process is alive)
//   (iii) Orchestrator tmux pane shows Claude's feedback prompt
//         ("How is Claude doing") OR garbled literal tool XML
//         ("<invoke" / "<parameter" / "</" printed as visible text)
//
// When any signal fires → AUTO-RESTART (kill + respawn). No nudge — nudging
// is what failed during the incident.
//
// Config knob: context-watchdog task config `wedge_timeout_minutes` (default 15).

/** Default N (minutes) before a live orch with no progress is considered wedged. */
export const DEFAULT_WEDGE_TIMEOUT_MINUTES = 15;

// Patterns that indicate the orch pane is showing the feedback prompt (signal iii-a)
const FEEDBACK_PROMPT_PATTERNS = [
  /How is Claude doing this session/i,
  /How is Claude doing/i,
];

// Patterns that indicate garbled literal tool XML in the pane (signal iii-b).
// NOTE: bare </ was intentionally removed — it matches ANY closing HTML/markdown tag
// (</em>, </code>, </li>, etc.) that appears in normal orch output, causing false-positive
// wedge-restarts of a healthy orchestrator. Only <invoke and <parameter are unambiguous
// garbled tool-XML indicators. (fix(2) rework per R2 review.)
const GARBLED_XML_PATTERNS = [
  /<invoke/,
  /<parameter/,
];

/** Test whether the given pane text contains wedge signal (iii). */
function isPaneWedged(paneText: string): boolean {
  if (FEEDBACK_PROMPT_PATTERNS.some(p => p.test(paneText))) return true;
  if (GARBLED_XML_PATTERNS.some(p => p.test(paneText))) return true;
  return false;
}

// ── Injectable deps for wedge detector ───────────────────────────────────────

let isOrchestratorAlive = _isOrchestratorAlive;
let killOrchestratorSession = _killOrchestratorSession;
let spawnOrchestratorSession = _spawnOrchestratorSession;
let captureOrchestratorPane = _captureOrchestratorPane;
let sendMessage = _sendMessageImpl;

/** @internal Override injectable deps for wedge detector unit tests. Pass null to restore originals. */
export function _setWedgeDepsForTesting(deps: {
  isOrchestratorAlive?: () => boolean;
  killOrchestratorSession?: () => boolean;
  spawnOrchestratorSession?: () => string | null;
  captureOrchestratorPane?: () => string | null;
  sendMessage?: typeof _sendMessageImpl;
} | null): void {
  if (deps === null) {
    isOrchestratorAlive = _isOrchestratorAlive;
    killOrchestratorSession = _killOrchestratorSession;
    spawnOrchestratorSession = _spawnOrchestratorSession;
    captureOrchestratorPane = _captureOrchestratorPane;
    sendMessage = _sendMessageImpl;
    return;
  }
  if (deps.isOrchestratorAlive) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.killOrchestratorSession) killOrchestratorSession = deps.killOrchestratorSession;
  if (deps.spawnOrchestratorSession) spawnOrchestratorSession = deps.spawnOrchestratorSession;
  if (deps.captureOrchestratorPane) captureOrchestratorPane = deps.captureOrchestratorPane;
  if (deps.sendMessage) sendMessage = deps.sendMessage;
}

// ── GATE 3: restart-loop cap ──────────────────────────────────────────────────
//
// Signal(i) can re-fire on every tick if the task's MAX(updated_at) never advances
// after a restart (fresh orch immediately re-wedges on the same task).
// This cap bounds the loop: after WEDGE_RESTART_CAP consecutive no-progress
// detections, the frozen task is marked FAILED instead of re-queued.
//
// DESIGN INTENT (coordinated with #448 Check 3b):
// We reuse _IN_PROGRESS_NO_PROGRESS_BUDGET (= 3) as the cap K so both the
// idle-orch bounded-nudge (Check 3b in orchestrator-idle) and the wedge-restart
// loop bound share the same threshold, rather than having a 3rd independent counter.
//
// These two counters are COMPLEMENTARY, not parallel:
//   • orchestrator-idle Check 3b fires when isClaudeProcessRunning=FALSE (Claude at prompt)
//   • context-watchdog GATE 3 fires when isOrchestratorAlive()=TRUE (Claude apparently running)
// They guard distinct failure modes and do NOT double-count the same event.
//
// GATE 1 race safety: Node.js single-threaded scheduler prevents true simultaneous
// execution. GATE 2's task-reset to pending also prevents double-act: once a task
// is reset to pending, Check 3b sees no in_progress task and skips its budget counter.

/**
 * Cap K — maximum consecutive no-progress wedge-restart detections before the frozen
 * task is marked FAILED. Reuses Check 3b's budget constant for shared threshold.
 */
export const WEDGE_RESTART_CAP = _IN_PROGRESS_NO_PROGRESS_BUDGET; // = 3

/** MAX(updated_at) of in_progress task(s) at the time of the most recent signal(i)-driven restart. */
let lastWedgeIpMaxUpdatedAt: string | null = null;
/** Count of consecutive signal(i) detections where updated_at did NOT advance since last restart. */
let wedgeRestartCount = 0;

/**
 * Auto-restart the orchestrator after detecting a wedge condition.
 *
 * CRITICAL — started_at refresh (fix(2)/fix(3) coordination):
 * The stale shutdown-timer guard (fix(3) in orchestrator.ts) captures started_at
 * at timer-arm time. By updating started_at on respawn here, any stale timer
 * that fires after this restart will see a DIFFERENT started_at and correctly
 * skip the kill — sparing the fresh session.
 */
function restartWedgedOrchestrator(reason: string): void {
  log.warn('Wedge detector: auto-restarting orchestrator', { reason });

  killOrchestratorSession();

  // GATE 2: Reset frozen in_progress task(s) to pending so the fresh orch re-picks them up.
  // The fresh orch polls ?status=pending ONLY (per .claude/agents/orchestrator.md:17).
  // Without this reset the task stays in_progress with no owner — orphaned indefinitely
  // (or until orchestrator-idle reaps it as a zombie, which is an uncontrolled race).
  // Resetting to pending also makes signal(i) self-limiting: the fresh orch advances
  // updated_at when it transitions pending→in_progress, which clears signal(i) on the
  // next tick. After WEDGE_RESTART_CAP no-progress cycles, GATE 3 marks the task FAILED
  // instead of re-queuing (see monitorOrchestratorWedge).
  try {
    const gateTs = new Date().toISOString();
    exec(
      `UPDATE tasks SET status = 'pending', error = NULL, updated_at = ?
       WHERE kind = 'orchestrator' AND status = 'in_progress'`,
      gateTs,
    );
    log.info('Wedge detector GATE 2: reset in_progress task(s) to pending for fresh orch pick-up');
  } catch (err) {
    log.warn('Wedge detector GATE 2: failed to reset in_progress task(s) to pending', { error: String(err) });
  }

  const session = spawnOrchestratorSession();
  const ts = new Date().toISOString();

  if (session) {
    // Update agents table with fresh started_at — load-bearing for fix(3) coordination.
    try {
      exec(
        `INSERT INTO agents (id, type, profile, status, tmux_session, started_at, created_at, updated_at)
         VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', ?, ?, ?, ?)`,
        session, ts, ts, ts,
      );
    } catch {
      update('agents', 'orchestrator', {
        status: 'running',
        tmux_session: session,
        started_at: ts,
        updated_at: ts,
      });
    }

    logActivity({
      agent_id: 'orchestrator',
      session_id: session,
      event_type: 'session_start',
      details: `Auto-restarted by wedge detector: ${reason}`,
    });
  }

  try {
    sendMessage({
      from: 'daemon',
      to: 'comms',
      type: 'status',
      body: JSON.stringify({
        alert: 'orchestrator_wedge_restart',
        message: `Orchestrator auto-restarted by wedge detector: ${reason}`,
        session,
      }),
    });
  } catch (err) {
    log.warn('Failed to notify comms of wedge restart', { error: String(err) });
  }
}

/**
 * Monitor a live orchestrator for wedge signals (i), (ii), (iii) and auto-restart
 * if any signal fires. Runs on every watchdog tick when the orch is alive.
 *
 * This is the missing layer identified in incident #1946: the orch was alive the
 * entire wedge, so orchestrator-idle (dead-process detector) and orch-stale-task-recovery
 * (logs only when alive) never triggered. This function triggers an immediate restart.
 */
function monitorOrchestratorWedge(config: Record<string, unknown>): void {
  // Only applies to a live orchestrator
  if (!isOrchestratorAlive()) return;

  const timeoutMinutes = typeof config.wedge_timeout_minutes === 'number'
    ? config.wedge_timeout_minutes
    : DEFAULT_WEDGE_TIMEOUT_MINUTES;
  const cutoffIso = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

  // Signal (i): any in_progress task with MAX(updated_at) older than threshold
  let signalI = false;
  let ipMaxUpdated: string | null = null;
  try {
    const inProgressRows = query<{ count: number; max_updated_at: string | null }>(
      `SELECT COUNT(*) as count, MAX(updated_at) as max_updated_at
       FROM tasks WHERE kind = 'orchestrator' AND status = 'in_progress'`,
    );
    const ipCount = inProgressRows[0]?.count ?? 0;
    ipMaxUpdated = inProgressRows[0]?.max_updated_at ?? null;
    signalI = ipCount > 0 && ipMaxUpdated !== null && ipMaxUpdated < cutoffIso;
  } catch (err) {
    log.debug('Wedge detector: could not query in_progress tasks', { error: String(err) });
  }

  // Signal (ii): agents.last_activity frozen for > threshold (while orch alive)
  //
  // ACTIVE-WORKER EXEMPTION (#462): When the orchestrator is waiting for a long-running
  // worker (runtime > wedge threshold), its last_activity is legitimately frozen — it
  // has no turns of its own while waiting. Restarting it during a healthy worker wait
  // kills the running worker and creates false restart storms.
  //
  // Before signalling, query for active worker_jobs (reusing the same check as the
  // idle-shutdown guard in orchestrator-idle.ts). If workers are running, the orch is
  // healthy-waiting — suppress signal(ii) and skip restart.
  //
  // Signals (i) and (iii) are NOT exempted: a frozen task updated_at or a garbled
  // pane is always a real wedge regardless of whether workers are running.
  let signalII = false;
  let lastActivity: string | null = null;
  try {
    const agentRows = query<{ last_activity: string | null }>(
      "SELECT last_activity FROM agents WHERE id = 'orchestrator'",
    );
    lastActivity = agentRows[0]?.last_activity ?? null;
    if (lastActivity !== null && lastActivity < cutoffIso) {
      const activeWorkerRows = query<{ count: number }>(
        "SELECT COUNT(*) as count FROM worker_jobs WHERE status IN ('queued', 'running')",
      );
      if ((activeWorkerRows[0]?.count ?? 0) > 0) {
        log.debug(
          'Wedge detector: last_activity frozen but active worker(s) running — orch is healthy-waiting, exempting signal(ii) (#462)',
          { lastActivity, activeWorkerCount: activeWorkerRows[0]?.count ?? 0, cutoffIso },
        );
        // signalII stays false — frozen last_activity is expected during long worker wait
      } else {
        signalII = true;
      }
    }
  } catch (err) {
    log.debug('Wedge detector: could not query agents.last_activity', { error: String(err) });
  }

  // Signal (iii): pane text shows feedback prompt or garbled XML
  let signalIII = false;
  try {
    const paneText = captureOrchestratorPane();
    if (paneText !== null) {
      signalIII = isPaneWedged(paneText);
    }
  } catch (err) {
    log.debug('Wedge detector: could not capture orch pane', { error: String(err) });
  }

  if (signalI || signalII || signalIII) {
    const reasons: string[] = [];
    if (signalI) reasons.push(`in_progress task frozen since ${ipMaxUpdated} (>${timeoutMinutes}m, cutoff ${cutoffIso})`);
    if (signalII) reasons.push(`agents.last_activity frozen since ${lastActivity} (>${timeoutMinutes}m)`);
    if (signalIII) reasons.push('pane shows feedback prompt or garbled XML');

    // ── GATE 3: restart-loop bound (signal (i) driven) ─────────────────────
    // Signal(i) can re-fire every tick if the task's updated_at never advances after
    // a GATE 2 reset+restart (e.g., fresh orch immediately re-wedges on the same task).
    // Count consecutive no-progress detections; at WEDGE_RESTART_CAP fail the task
    // instead of re-queuing — breaking the infinite restart storm.
    //
    // GATE 1 coordination with orchestrator-idle Check 3b:
    // Check 3b fires when isClaudeProcessRunning=FALSE (Claude at shell prompt, not working).
    // signal(i) fires when isOrchestratorAlive()=TRUE (orch session alive, Claude apparently
    // processing but task still frozen). These are mutually exclusive in the common path.
    // GATE 2's pending-reset also prevents double-act: after reset, Check 3b sees no
    // in_progress task and skips its budget counter on that tick.
    if (signalI) {
      if (ipMaxUpdated === lastWedgeIpMaxUpdatedAt) {
        // Same frozen value as last restart — no progress was made
        wedgeRestartCount++;
      } else {
        // Either first detection or task advanced since last restart — reset counter
        wedgeRestartCount = 1;
        lastWedgeIpMaxUpdatedAt = ipMaxUpdated;
      }

      if (wedgeRestartCount >= WEDGE_RESTART_CAP) {
        // Cap exhausted — mark frozen task(s) FAILED and alert comms; do NOT restart.
        log.warn('Wedge detector GATE 3: restart cap reached — marking frozen task(s) FAILED', {
          wedgeRestartCount,
          WEDGE_RESTART_CAP,
          ipMaxUpdated,
          reason: reasons.join('; '),
        });
        const capTs = new Date().toISOString();
        try {
          const frozenTasks = query<{ ext_id: string }>(
            `SELECT external_id AS ext_id FROM tasks WHERE kind = 'orchestrator' AND status = 'in_progress'`,
          );
          exec(
            `UPDATE tasks SET status = 'failed', error = 'wedge_restart_cap_exceeded', completed_at = ?, updated_at = ?
             WHERE kind = 'orchestrator' AND status = 'in_progress'`,
            capTs, capTs,
          );
          for (const task of frozenTasks) {
            exec(
              `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
               SELECT id, 'daemon', 'note', 'cleanup', ?, ?
               FROM tasks WHERE kind = 'orchestrator' AND external_id = ?`,
              `Task failed: wedge restart cap (${WEDGE_RESTART_CAP}) exceeded — orchestrator repeatedly re-wedged without progress`,
              capTs, task.ext_id,
            );
          }
          sendMessage({
            from: 'daemon',
            to: 'comms',
            type: 'status',
            body: JSON.stringify({
              alert: 'orchestrator_wedge_cap_exceeded',
              message: `Orchestrator wedge restart cap (${WEDGE_RESTART_CAP}) exceeded — frozen task(s) marked FAILED: ${frozenTasks.map(t => t.ext_id).join(', ')}`,
              taskIds: frozenTasks.map(t => t.ext_id),
            }),
          });
        } catch (err) {
          log.warn('Wedge detector GATE 3: failed to fail task(s) or alert comms', { error: String(err) });
        }
        // Reset state so future in_progress tasks start with a clean counter
        wedgeRestartCount = 0;
        lastWedgeIpMaxUpdatedAt = null;
        return; // DO NOT restart
      }
    }

    log.warn('Orchestrator wedge detected — auto-restarting', {
      signalI,
      signalII,
      signalIII,
      timeoutMinutes,
      wedgeRestartCount: signalI ? wedgeRestartCount : undefined,
    });

    restartWedgedOrchestrator(reasons.join('; '));
    return;
  }

  log.debug('Wedge check: orchestrator healthy', {
    timeoutMinutes,
    ipMaxUpdated,
    lastActivity,
  });
}

async function run(config: Record<string, unknown>): Promise<void> {
  monitorComms();
  monitorOrchestrator();
  monitorOrchestratorWedge(config);
}

/**
 * Register the context-watchdog task with the scheduler.
 * Task config should include `requires_session: true` in kithkit.config.yaml.
 * Optional: `wedge_timeout_minutes` (default 15) to tune the wedge detector threshold.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('context-watchdog', async (ctx) => {
    await run(ctx.config);
  });
}

/**
 * Reset module-level state for testing purposes.
 * @internal
 */
export function _resetForTesting(): void {
  commsFiredTiers = new Set();
  commsSessionId = null;
  orchFiredTiers = new Set();
  orchSessionId = null;
  commsFileMissCount = 0;
  orchFileMissCount = 0;
  // GATE 3 state
  wedgeRestartCount = 0;
  lastWedgeIpMaxUpdatedAt = null;
}

/** @internal Read GATE 3 restart-loop counter state for test assertions. */
export function _getWedgeRestartStateForTesting(): { count: number; lastIpMaxUpdatedAt: string | null } {
  return { count: wedgeRestartCount, lastIpMaxUpdatedAt: lastWedgeIpMaxUpdatedAt };
}

/** @internal Expose run() for direct testing (wedge detector + context tiers). */
export async function _runForTesting(config: Record<string, unknown>): Promise<void> {
  return run(config);
}
