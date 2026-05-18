/**
 * Tests for task-state-machine.ts
 *
 * Covers: VALID_STATUSES, TERMINAL_STATUSES, validateTransition,
 * allowedTransitions, and getTransitionSideEffects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type TaskStatus,
  VALID_STATUSES,
  TERMINAL_STATUSES,
  validateTransition,
  allowedTransitions,
  getTransitionSideEffects,
} from '../core/task-state-machine.js';

// ── VALID_STATUSES ────────────────────────────────────────────────────────────

describe('VALID_STATUSES', () => {
  it('contains exactly 11 statuses', () => {
    assert.equal(VALID_STATUSES.length, 11);
  });

  it('contains every expected status', () => {
    const expected: TaskStatus[] = [
      'proposed', 'pending', 'assigned', 'planning', 'awaiting_approval',
      'in_progress', 'blocked', 'completed', 'failed', 'abandoned', 'cancelled',
    ];
    for (const s of expected) {
      assert.ok(VALID_STATUSES.includes(s), `Missing status: ${s}`);
    }
  });
});

// ── TERMINAL_STATUSES ─────────────────────────────────────────────────────────

describe('TERMINAL_STATUSES', () => {
  it('contains exactly completed, abandoned, cancelled', () => {
    assert.equal(TERMINAL_STATUSES.length, 3);
    assert.ok(TERMINAL_STATUSES.includes('completed'));
    assert.ok(TERMINAL_STATUSES.includes('abandoned'));
    assert.ok(TERMINAL_STATUSES.includes('cancelled'));
  });

  it('does not include in_progress, failed, or pending', () => {
    assert.ok(!TERMINAL_STATUSES.includes('in_progress'));
    assert.ok(!TERMINAL_STATUSES.includes('failed'));
    assert.ok(!TERMINAL_STATUSES.includes('pending'));
  });
});

// ── validateTransition ────────────────────────────────────────────────────────

describe('validateTransition', () => {
  // All permitted transitions from the spec
  const valid: [TaskStatus, TaskStatus][] = [
    ['proposed',          'pending'],
    ['proposed',          'cancelled'],
    ['pending',           'assigned'],
    ['pending',           'cancelled'],
    ['assigned',          'planning'],
    ['assigned',          'in_progress'],
    ['assigned',          'cancelled'],
    ['planning',          'awaiting_approval'],
    ['planning',          'in_progress'],
    ['awaiting_approval', 'in_progress'],
    ['awaiting_approval', 'planning'],
    ['awaiting_approval', 'abandoned'],
    ['in_progress',       'blocked'],
    ['in_progress',       'completed'],
    ['in_progress',       'failed'],
    ['in_progress',       'abandoned'],
    ['blocked',           'in_progress'],
    ['blocked',           'failed'],
    ['blocked',           'abandoned'],
    ['failed',            'pending'],
  ];

  for (const [from, to] of valid) {
    it(`allows ${from} → ${to}`, () => {
      assert.ok(validateTransition(from, to), `Expected ${from} → ${to} to be valid`);
    });
  }

  // A sample of invalid transitions
  const invalid: [TaskStatus, TaskStatus][] = [
    ['proposed',    'in_progress'],   // must go through pending/assigned first
    ['proposed',    'completed'],
    ['pending',     'in_progress'],   // must be assigned first
    ['pending',     'planning'],
    ['completed',   'in_progress'],   // terminal
    ['completed',   'pending'],       // terminal
    ['abandoned',   'in_progress'],   // terminal
    ['cancelled',   'pending'],       // terminal
    ['in_progress', 'pending'],       // no backwards skip
    ['in_progress', 'assigned'],
    ['blocked',     'completed'],     // must go via in_progress
    ['failed',      'assigned'],      // can only retry to pending
    ['failed',      'completed'],
  ];

  for (const [from, to] of invalid) {
    it(`rejects ${from} → ${to}`, () => {
      assert.ok(!validateTransition(from, to), `Expected ${from} → ${to} to be invalid`);
    });
  }
});

// ── allowedTransitions ────────────────────────────────────────────────────────

describe('allowedTransitions', () => {
  it('returns correct targets for proposed', () => {
    const targets = allowedTransitions('proposed');
    assert.deepEqual([...targets].sort(), ['cancelled', 'pending']);
  });

  it('returns correct targets for awaiting_approval', () => {
    const targets = allowedTransitions('awaiting_approval');
    assert.deepEqual([...targets].sort(), ['abandoned', 'in_progress', 'planning']);
  });

  it('returns empty array for completed (terminal)', () => {
    assert.deepEqual([...allowedTransitions('completed')], []);
  });

  it('returns empty array for abandoned (terminal)', () => {
    assert.deepEqual([...allowedTransitions('abandoned')], []);
  });

  it('returns empty array for cancelled (terminal)', () => {
    assert.deepEqual([...allowedTransitions('cancelled')], []);
  });

  it('returns [pending] for failed (retry only)', () => {
    assert.deepEqual([...allowedTransitions('failed')], ['pending']);
  });

  it('returns correct targets for in_progress', () => {
    const targets = allowedTransitions('in_progress');
    assert.deepEqual([...targets].sort(), ['abandoned', 'blocked', 'completed', 'failed']);
  });

  it('is consistent with validateTransition', () => {
    for (const from of VALID_STATUSES) {
      for (const to of VALID_STATUSES) {
        const allowed = allowedTransitions(from).includes(to);
        const valid = validateTransition(from, to);
        assert.equal(
          allowed, valid,
          `allowedTransitions/validateTransition mismatch for ${from} → ${to}`,
        );
      }
    }
  });
});

// ── getTransitionSideEffects ──────────────────────────────────────────────────

describe('getTransitionSideEffects', () => {
  const NOW = '2026-05-18T12:00:00.000Z';

  it('sets assigned_at when transitioning to assigned and it is null', () => {
    const effects = getTransitionSideEffects(
      'pending', 'assigned',
      { assigned_at: null, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.assigned_at, NOW);
    assert.equal(effects.started_at, undefined);
    assert.equal(effects.completed_at, undefined);
  });

  it('does NOT set assigned_at when it is already set', () => {
    const effects = getTransitionSideEffects(
      'pending', 'assigned',
      { assigned_at: '2026-05-10T00:00:00.000Z', started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.assigned_at, undefined);
  });

  it('sets started_at on first transition to in_progress', () => {
    const effects = getTransitionSideEffects(
      'assigned', 'in_progress',
      { assigned_at: NOW, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.started_at, NOW);
  });

  it('does NOT set started_at when it is already set (re-entry from blocked)', () => {
    const effects = getTransitionSideEffects(
      'blocked', 'in_progress',
      { assigned_at: NOW, started_at: '2026-05-17T08:00:00.000Z', completed_at: null },
      NOW,
    );
    assert.equal(effects.started_at, undefined);
  });

  it('sets completed_at when transitioning to completed', () => {
    const effects = getTransitionSideEffects(
      'in_progress', 'completed',
      { assigned_at: NOW, started_at: NOW, completed_at: null },
      NOW,
    );
    assert.equal(effects.completed_at, NOW);
  });

  it('sets completed_at when transitioning to failed', () => {
    const effects = getTransitionSideEffects(
      'in_progress', 'failed',
      { assigned_at: NOW, started_at: NOW, completed_at: null },
      NOW,
    );
    assert.equal(effects.completed_at, NOW);
  });

  it('sets completed_at when transitioning to abandoned', () => {
    const effects = getTransitionSideEffects(
      'in_progress', 'abandoned',
      { assigned_at: NOW, started_at: NOW, completed_at: null },
      NOW,
    );
    assert.equal(effects.completed_at, NOW);
  });

  it('sets completed_at when transitioning to cancelled', () => {
    const effects = getTransitionSideEffects(
      'pending', 'cancelled',
      { assigned_at: null, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.completed_at, NOW);
  });

  it('sets plan_submitted_at on planning → awaiting_approval', () => {
    const effects = getTransitionSideEffects(
      'planning', 'awaiting_approval',
      { assigned_at: NOW, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.plan_submitted_at, NOW);
    assert.equal(effects.plan_approved_at, undefined);
  });

  it('sets plan_approved_at on awaiting_approval → in_progress', () => {
    const effects = getTransitionSideEffects(
      'awaiting_approval', 'in_progress',
      { assigned_at: NOW, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.plan_approved_at, NOW);
    // started_at should also be set (first time in_progress)
    assert.equal(effects.started_at, NOW);
  });

  it('does NOT set plan_approved_at on in_progress re-entry from blocked', () => {
    const effects = getTransitionSideEffects(
      'blocked', 'in_progress',
      { assigned_at: NOW, started_at: NOW, completed_at: null },
      NOW,
    );
    assert.equal(effects.plan_approved_at, undefined);
  });

  it('does NOT set plan_submitted_at on assigned → planning', () => {
    const effects = getTransitionSideEffects(
      'assigned', 'planning',
      { assigned_at: NOW, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.plan_submitted_at, undefined);
  });

  it('returns empty object for non-side-effecting transition (e.g. in_progress → blocked)', () => {
    const effects = getTransitionSideEffects(
      'in_progress', 'blocked',
      { assigned_at: NOW, started_at: NOW, completed_at: null },
      NOW,
    );
    assert.deepEqual(effects, {});
  });

  it('defaults now to current time when not provided', () => {
    const before = new Date().toISOString();
    const effects = getTransitionSideEffects(
      'pending', 'assigned',
      { assigned_at: null, started_at: null, completed_at: null },
    );
    const after = new Date().toISOString();
    assert.ok(effects.assigned_at !== undefined);
    assert.ok(effects.assigned_at! >= before);
    assert.ok(effects.assigned_at! <= after);
  });

  it('handles multiple side effects in one transition (awaiting_approval → in_progress, new task)', () => {
    const effects = getTransitionSideEffects(
      'awaiting_approval', 'in_progress',
      { assigned_at: NOW, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.plan_approved_at, NOW);
    assert.equal(effects.started_at, NOW);
    assert.equal(effects.completed_at, undefined);
    assert.equal(effects.assigned_at, undefined);
    assert.equal(effects.plan_submitted_at, undefined);
  });

  it('proposed → cancelled sets completed_at only', () => {
    const effects = getTransitionSideEffects(
      'proposed', 'cancelled',
      { assigned_at: null, started_at: null, completed_at: null },
      NOW,
    );
    assert.equal(effects.completed_at, NOW);
    assert.equal(effects.assigned_at, undefined);
    assert.equal(effects.started_at, undefined);
    assert.equal(effects.plan_submitted_at, undefined);
    assert.equal(effects.plan_approved_at, undefined);
  });
});
