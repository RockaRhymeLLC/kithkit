/**
 * calibration-hint — pre-task calibration multiplier injection.
 *
 * When scheduling a new task, the daemon may look up the rolling per-(agent, category)
 * calibration ratio from `task_calibration` and surface it as a hint so workers can
 * adjust their self-reported estimates before starting work.
 *
 * TODO(v2.1): wire calibration-hint to unified tasks table
 * HOLDING for BMO PR #257 (kithkit upstream) merge — do not enable until then.
 *
 * Once PR #257 lands and the `task_calibration` table is available in the shared schema,
 * implement `getCalibrationHint(agentName, category)` to query the calibration table and
 * return the mean_ratio for the matching (agent_name, category) row, or null if absent.
 * Wire the return value into task creation (POST /api/orchestrator/tasks) as a read-only
 * `calibration_hint` field on the response.
 */

// Stub — intentionally empty until BMO PR #257 merges.
export {};
