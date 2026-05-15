/**
 * Per-community relay registration state.
 *
 * Persists actual registration outcomes so the /api/network/status endpoint
 * can report truth rather than config-intent. This solves the zombie-state
 * problem where registration fails silently at startup but the status endpoint
 * keeps returning 'active' because the SDK module loaded.
 *
 * State lives in-memory (module-level). Resets on daemon restart, which is
 * fine — the retry loop in extensions/index.ts repopulates it.
 */

export interface NetworkRegistrationState {
  registration_status: 'success' | 'failed' | 'retrying' | 'pending';
  last_successful_registration_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  retry_count: number;
  /** Best-effort SDK introspection. TODO: wire to community:status events for live accuracy. */
  current_relay_session_state: 'connected' | 'disconnected' | 'unknown';
}

const _states = new Map<string, NetworkRegistrationState>();

function getOrCreate(communityName: string): NetworkRegistrationState {
  let state = _states.get(communityName);
  if (!state) {
    state = {
      registration_status: 'pending',
      last_successful_registration_at: null,
      last_attempt_at: null,
      last_error: null,
      retry_count: 0,
      current_relay_session_state: 'unknown',
    };
    _states.set(communityName, state);
  }
  return state;
}

/** Mark that a registration attempt is starting for this community. */
export function recordRegistrationAttempt(communityName: string): void {
  const state = getOrCreate(communityName);
  state.last_attempt_at = new Date().toISOString();
  state.registration_status = 'pending';
}

/** Record a successful registration for this community. Clears error and resets retry_count. */
export function recordRegistrationSuccess(communityName: string): void {
  const state = getOrCreate(communityName);
  state.registration_status = 'success';
  state.last_successful_registration_at = new Date().toISOString();
  state.last_error = null;
  state.retry_count = 0;
}

/** Record a failed registration attempt. Increments retry_count. */
export function recordRegistrationFailure(communityName: string, error: string): void {
  const state = getOrCreate(communityName);
  state.registration_status = 'failed';
  state.last_error = error;
  state.retry_count += 1;
}

/** Mark community as waiting in backoff before next retry attempt. */
export function recordRetrying(communityName: string): void {
  const state = getOrCreate(communityName);
  state.registration_status = 'retrying';
}

/** Get registration state for a single community, or null if never tracked. */
export function getRegistrationState(communityName: string): NetworkRegistrationState | null {
  return _states.get(communityName) ?? null;
}

/** Get registration state for all tracked communities. */
export function getAllRegistrationStates(): Record<string, NetworkRegistrationState> {
  const result: Record<string, NetworkRegistrationState> = {};
  for (const [name, state] of _states) {
    result[name] = state;
  }
  return result;
}

/** Update the SDK-level session state for a community (best-effort). */
export function updateRelaySessionState(
  communityName: string,
  state: 'connected' | 'disconnected' | 'unknown',
): void {
  getOrCreate(communityName).current_relay_session_state = state;
}

/** Reset all state — for testing only. */
export function _resetForTesting(): void {
  _states.clear();
}
