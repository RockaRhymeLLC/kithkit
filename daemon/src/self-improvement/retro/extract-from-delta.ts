/**
 * extract-from-delta — detect divergence between orch internal result and comms outcome.
 *
 * Q2 (dual-stage closure): the retro pipeline now reads BOTH the orch-internal `result`
 * field AND `comms_outcome` + `comms_corrections`. When these diverge — e.g. the orch
 * believed the task was completed but comms marked it 'corrected' or 'redirected' — that
 * delta is a high-signal retro item indicating the orch's self-assessment was inaccurate.
 *
 * This module is a stub implementation. Full integration (persisting delta lessons as
 * structured memories, feeding them into pre-task injection) is deferred to a follow-up.
 */

import { createLogger } from '../../core/logger.js';

const log = createLogger('extract-from-delta');

export interface DeltaInput {
  /** Orch internal result string (free text). May be null if task ended without a result. */
  result: string | null;
  /** Comms agent's characterisation of how the task resolved from the user's perspective. */
  comms_outcome: string | null;
  /** JSON-encoded structured corrections from comms, if any. */
  comms_corrections: string | null;
}

export interface DeltaLesson {
  /** Signal level: 'high' when orch said completed but comms corrected/redirected. */
  signal: 'high' | 'medium' | 'low' | 'none';
  /** Human-readable description of the delta for inclusion in the retro prompt. */
  description: string;
  /** Whether the orch's internal state and the user-visible outcome diverged. */
  diverged: boolean;
}

/**
 * Detect divergence between the orch's internal result and the comms outcome.
 *
 * Rules:
 *   - If comms_outcome is null (task not yet acknowledged), no delta can be computed.
 *   - 'corrected' or 'redirected' comms_outcome when result is non-null → HIGH signal:
 *     the orch thought it delivered value but the user had to correct or redirect.
 *   - 'cancelled' comms_outcome when result is non-null → MEDIUM signal:
 *     orch did work that ultimately wasn't needed.
 *   - 'accepted' comms_outcome → LOW signal (minor discrepancies in corrections only).
 *   - No result and comms_outcome set → LOW signal (orch didn't self-report).
 *
 * Returns a DeltaLesson, or null if no delta is detectable.
 */
export function detectDelta(input: DeltaInput): DeltaLesson | null {
  const { result, comms_outcome, comms_corrections } = input;

  if (!comms_outcome) {
    return null;
  }

  const hasResult = result !== null && result.trim().length > 0;
  const hasCorrections = comms_corrections !== null && comms_corrections.trim().length > 0;

  if (comms_outcome === 'corrected') {
    const correctionDetail = hasCorrections ? ` Corrections recorded: ${comms_corrections}` : '';
    return {
      signal: 'high',
      diverged: true,
      description: `Orch reported result but comms marked outcome as 'corrected' — orch self-assessment was inaccurate.${correctionDetail}`,
    };
  }

  if (comms_outcome === 'redirected') {
    if (!hasResult) {
      return {
        signal: 'medium',
        diverged: false,
        description: `Task redirected before orch produced a result.`,
      };
    }
    return {
      signal: 'high',
      diverged: true,
      description: `Orch reported result but comms marked outcome as 'redirected' — deliverable did not match user intent.`,
    };
  }

  if (comms_outcome === 'cancelled') {
    return {
      signal: hasResult ? 'medium' : 'low',
      diverged: hasResult,
      description: hasResult
        ? `Orch produced a result but task was subsequently cancelled — work may have been unnecessary.`
        : `Task cancelled before orch produced a result.`,
    };
  }

  if (comms_outcome === 'accepted') {
    if (hasCorrections) {
      return {
        signal: 'low',
        diverged: false,
        description: `Task accepted by user with minor corrections noted.`,
      };
    }
    // Accepted, no corrections — no meaningful delta
    return {
      signal: 'none',
      diverged: false,
      description: 'Task accepted without corrections — no delta.',
    };
  } else {
    log.warn('extract-from-delta: unrecognized comms_outcome', { outcome: comms_outcome });
  }

  return null;
}

/**
 * Convenience wrapper used by retro-evaluator.
 * Returns a human-readable delta description string for embedding in the retro prompt,
 * or null if there is no meaningful delta (comms_outcome not set, or accepted cleanly).
 */
export function extractDeltaLesson(input: DeltaInput): string | null {
  const delta = detectDelta(input);
  if (!delta || delta.signal === 'none') return null;
  return `[Delta signal: ${delta.signal.toUpperCase()}] ${delta.description}`;
}
