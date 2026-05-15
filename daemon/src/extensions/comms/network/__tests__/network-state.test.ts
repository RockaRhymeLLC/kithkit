/**
 * Unit tests for network-state.ts
 *
 * Verifies that registration state is correctly recorded and retrieved
 * per community, and that communities are tracked independently.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordRegistrationAttempt,
  recordRegistrationSuccess,
  recordRegistrationFailure,
  recordRetrying,
  getRegistrationState,
  getAllRegistrationStates,
  updateRelaySessionState,
  _resetForTesting,
} from '../network-state.js';

beforeEach(() => {
  _resetForTesting();
});

describe('network-state — recordRegistrationAttempt', () => {
  it('creates entry with pending status on first call', () => {
    recordRegistrationAttempt('home');
    const state = getRegistrationState('home');
    assert.ok(state, 'state should exist after attempt');
    assert.equal(state.registration_status, 'pending');
    assert.ok(state.last_attempt_at, 'last_attempt_at should be set');
    assert.equal(state.last_successful_registration_at, null);
    assert.equal(state.last_error, null);
    assert.equal(state.retry_count, 0);
    assert.equal(state.current_relay_session_state, 'unknown');
  });

  it('resets status to pending on re-attempt after retrying', () => {
    recordRegistrationAttempt('home');
    recordRetrying('home');
    assert.equal(getRegistrationState('home')!.registration_status, 'retrying');
    recordRegistrationAttempt('home');
    assert.equal(getRegistrationState('home')!.registration_status, 'pending');
  });
});

describe('network-state — recordRegistrationSuccess', () => {
  it('sets status to success and clears error', () => {
    recordRegistrationAttempt('home');
    recordRegistrationFailure('home', 'timeout');
    recordRegistrationAttempt('home');
    recordRegistrationSuccess('home');
    const state = getRegistrationState('home')!;
    assert.equal(state.registration_status, 'success');
    assert.ok(state.last_successful_registration_at, 'timestamp should be set');
    assert.equal(state.last_error, null);
    assert.equal(state.retry_count, 0);
  });

  it('sets last_successful_registration_at to a valid ISO timestamp', () => {
    recordRegistrationAttempt('home');
    recordRegistrationSuccess('home');
    const ts = getRegistrationState('home')!.last_successful_registration_at;
    assert.ok(ts, 'timestamp should exist');
    assert.ok(!isNaN(Date.parse(ts)), 'timestamp should be valid ISO');
  });

  it('resets retry_count to 0 after multiple failures', () => {
    for (let i = 0; i < 3; i++) {
      recordRegistrationAttempt('home');
      recordRegistrationFailure('home', 'err');
    }
    assert.equal(getRegistrationState('home')!.retry_count, 3);
    recordRegistrationAttempt('home');
    recordRegistrationSuccess('home');
    assert.equal(getRegistrationState('home')!.retry_count, 0);
  });
});

describe('network-state — recordRegistrationFailure', () => {
  it('sets status to failed and stores error message', () => {
    recordRegistrationAttempt('home');
    recordRegistrationFailure('home', 'connection refused');
    const state = getRegistrationState('home')!;
    assert.equal(state.registration_status, 'failed');
    assert.equal(state.last_error, 'connection refused');
    assert.equal(state.retry_count, 1);
  });

  it('increments retry_count on each consecutive failure', () => {
    for (let i = 1; i <= 5; i++) {
      recordRegistrationAttempt('home');
      recordRegistrationFailure('home', 'err');
      assert.equal(getRegistrationState('home')!.retry_count, i);
    }
  });

  it('overwrites last_error with the most recent error', () => {
    recordRegistrationAttempt('home');
    recordRegistrationFailure('home', 'first error');
    recordRegistrationAttempt('home');
    recordRegistrationFailure('home', 'second error');
    assert.equal(getRegistrationState('home')!.last_error, 'second error');
  });
});

describe('network-state — recordRetrying', () => {
  it('sets status to retrying', () => {
    recordRegistrationAttempt('home');
    recordRegistrationFailure('home', 'err');
    recordRetrying('home');
    assert.equal(getRegistrationState('home')!.registration_status, 'retrying');
  });
});

describe('network-state — multiple communities are tracked independently', () => {
  it('tracks state separately per community name', () => {
    recordRegistrationAttempt('home');
    recordRegistrationSuccess('home');

    recordRegistrationAttempt('work');
    recordRegistrationFailure('work', 'dns failure');

    const home = getRegistrationState('home')!;
    const work = getRegistrationState('work')!;

    assert.equal(home.registration_status, 'success');
    assert.equal(home.last_error, null);

    assert.equal(work.registration_status, 'failed');
    assert.equal(work.last_error, 'dns failure');
    assert.equal(work.retry_count, 1);
  });

  it('getAllRegistrationStates returns all communities', () => {
    recordRegistrationAttempt('alpha');
    recordRegistrationAttempt('beta');
    recordRegistrationSuccess('alpha');
    recordRegistrationFailure('beta', 'unreachable');

    const all = getAllRegistrationStates();
    assert.ok('alpha' in all, 'alpha should be present');
    assert.ok('beta' in all, 'beta should be present');
    assert.equal(all.alpha.registration_status, 'success');
    assert.equal(all.beta.registration_status, 'failed');
  });

  it('getRegistrationState returns null for unknown community', () => {
    assert.equal(getRegistrationState('nonexistent'), null);
  });
});

describe('network-state — updateRelaySessionState', () => {
  it('updates current_relay_session_state', () => {
    recordRegistrationAttempt('home');
    updateRelaySessionState('home', 'connected');
    assert.equal(getRegistrationState('home')!.current_relay_session_state, 'connected');
  });

  it('creates the entry if it does not exist yet', () => {
    updateRelaySessionState('new-community', 'disconnected');
    const state = getRegistrationState('new-community');
    assert.ok(state, 'state should be created');
    assert.equal(state.current_relay_session_state, 'disconnected');
  });
});
