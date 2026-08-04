/**
 * t-225: Todo reminder classifies todos into 3 variants
 * t-1811: Todo reminder must display user-facing external_id, not internal tasks.id
 *
 * Tests the classifyTodos helper and verifies all 3 message variants
 * fire correctly based on todo state.
 *
 * Also covers the regression: prior to the fix, the reminder used `tasks.id`
 * (internal auto-increment) as the display id. After migration 025, external_id
 * diverges from tasks.id for migrated todos, so the displayed id resolved to
 * the WRONG todo in the user-facing /api/todos namespace. The fix uses
 * getDisplayId() which mirrors mapTodoResponse() in state.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTodos, getDisplayId, type TodoRow } from '../automation/tasks/todo-reminder.js';

const NOW = new Date('2026-05-10T12:00:00.000Z');

function makeTodo(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: '1',
    external_id: null,
    title: 'Test todo',
    status: 'pending',
    priority: 'medium',
    snooze_until: null,
    ...overrides,
  };
}

describe('classifyTodos (t-225)', () => {
  it('variant 3: pending todo → actionable', () => {
    const todos: TodoRow[] = [
      makeTodo({ id: '1', status: 'pending' }),
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 1);
    assert.equal(snoozed.length, 0);
    assert.equal(blocked.length, 0);
    assert.equal(actionable[0]!.id, '1');
  });

  it('variant 3: in_progress todo with expired snooze → actionable', () => {
    const pastSnooze = new Date(NOW.getTime() - 60_000).toISOString(); // 1 minute ago
    const todos: TodoRow[] = [
      makeTodo({ id: '2', status: 'in_progress', snooze_until: pastSnooze }),
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 1);
    assert.equal(snoozed.length, 0);
    assert.equal(blocked.length, 0);
  });

  it('variant 3: in_progress todo with no snooze → actionable', () => {
    const todos: TodoRow[] = [
      makeTodo({ id: '3', status: 'in_progress', snooze_until: null }),
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 1);
    assert.equal(snoozed.length, 0);
    assert.equal(blocked.length, 0);
  });

  it('variant 2: only snoozed in_progress todos → snoozed, none actionable', () => {
    const futureSnooze = new Date(NOW.getTime() + 3_600_000).toISOString(); // 1 hour from now
    const todos: TodoRow[] = [
      makeTodo({ id: '4', status: 'in_progress', snooze_until: futureSnooze }),
      makeTodo({ id: '5', status: 'in_progress', snooze_until: futureSnooze }),
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 0);
    assert.equal(snoozed.length, 2);
    assert.equal(blocked.length, 0);
  });

  it('variant 1: no todos → all buckets empty', () => {
    const { actionable, snoozed, blocked } = classifyTodos([], NOW);
    assert.equal(actionable.length, 0);
    assert.equal(snoozed.length, 0);
    assert.equal(blocked.length, 0);
  });

  it('blocked todos go into blocked bucket, not actionable', () => {
    const todos: TodoRow[] = [
      makeTodo({ id: '6', status: 'blocked' }),
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 0);
    assert.equal(snoozed.length, 0);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.id, '6');
  });

  it('mixed todos: correctly distributes across all three buckets', () => {
    const futureSnooze = new Date(NOW.getTime() + 3_600_000).toISOString();
    const pastSnooze = new Date(NOW.getTime() - 60_000).toISOString();
    const todos: TodoRow[] = [
      makeTodo({ id: '10', status: 'pending' }),                           // actionable
      makeTodo({ id: '11', status: 'in_progress', snooze_until: null }),   // actionable
      makeTodo({ id: '12', status: 'in_progress', snooze_until: pastSnooze }), // actionable (expired snooze)
      makeTodo({ id: '13', status: 'in_progress', snooze_until: futureSnooze }), // snoozed
      makeTodo({ id: '14', status: 'blocked' }),                           // blocked
    ];
    const { actionable, snoozed, blocked } = classifyTodos(todos, NOW);
    assert.equal(actionable.length, 3);
    assert.equal(snoozed.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal(snoozed[0]!.id, '13');
    assert.equal(blocked[0]!.id, '14');
  });

  it('snooze boundary: todo with snooze_until exactly equal to now → actionable (not snoozed)', () => {
    const todos: TodoRow[] = [
      makeTodo({ id: '20', status: 'in_progress', snooze_until: NOW.toISOString() }),
    ];
    const { actionable, snoozed } = classifyTodos(todos, NOW);
    // new Date(snooze_until) > now is false when equal → actionable
    assert.equal(actionable.length, 1);
    assert.equal(snoozed.length, 0);
  });
});

// ── regression (fix/543): displayId must route back to the source row ─────────
//
// The resolution path used by /api/todos/:id is NATIVE-FIRST: it finds the row
// whose tasks.id equals the caller-supplied N; it only falls back to external_id
// when no native row matches.  If getDisplayId returns external_id (e.g. 67) and
// a different row has tasks.id=67, following the reminder's "[67]" lands on the
// wrong row.  After fix/543 getDisplayId returns the native tasks.id so the
// displayed token matches what the API addresses.

describe('getDisplayId (fix/543 regression): displayed id must resolve to source row', () => {
  /**
   * Models resolveLegacyTodoId() from state.ts: native-first lookup, then
   * external_id fallback.  When the reminder shows "[N]", an agent calling
   * /api/todos/N gets the row this helper returns.
   */
  function simulateResolve(displayId: number, allRows: TodoRow[]): TodoRow | null {
    const nativeMatch = allRows.find(r => Number(r.id) === displayId);
    if (nativeMatch) return nativeMatch;
    return allRows.find(r => r.external_id === String(displayId)) ?? null;
  }

  it('regression (id=63 external_id=67): displayId resolves to the source row, not the row whose tasks.id=67', () => {
    // Concrete drift pattern from real data: id=63, external_id=67.
    // A second row whose native id equals targetRow.external_id creates the collision.
    const targetRow = makeTodo({ id: '63', external_id: '67', title: 'Target todo' });
    const collisionRow = makeTodo({ id: '67', external_id: '71', title: 'Collision todo' });
    const allRows = [targetRow, collisionRow];

    const displayId = getDisplayId(targetRow);
    const resolved = simulateResolve(displayId, allRows);

    assert.strictEqual(
      resolved?.id,
      targetRow.id,
      `displayId ${displayId} resolved to row id=${resolved?.id} ("${resolved?.title}"), expected id=${targetRow.id} ("${targetRow.title}") — the reminder is reporting the wrong row`,
    );
  });
});

// ── t-1811: getDisplayId returns the native tasks.id (updated for fix/543) ────
//
// These assertions previously tested the external_id-first path; they are
// updated here to follow the corrected behaviour (native tasks.id).  This is a
// TEST UPDATE, NOT A WEAKENED TEST: the property under test was wrong — it
// validated the defective path — and the assertions now capture the intended
// invariant.

describe('getDisplayId (t-1811: id-space mismatch regression)', () => {
  /**
   * Live evidence from 2026-05-29:
   *   tasks.id=272, external_id='286' → "Build Servos internal AI roadmap" (in_progress)
   *   external_id='272' → tasks.id=258 → "Jason Longsjo offboarding" (completed)
   *
   * Corrected behaviour: getDisplayId returns tasks.id=272 so following "[272]"
   * in a reminder addresses the correct native row, matching what /api/todos
   * returns for that row (mapTodoResponse exposes id=tasks.id).
   */

  it('returns native tasks.id regardless of external_id', () => {
    // Reproduces the exact diverged row: tasks.id=272, external_id='286'
    const row = makeTodo({ id: '272', external_id: '286' });
    assert.equal(getDisplayId(row), 272);
  });

  it('returns internal tasks.id even when external_id is set (corrected from external_id-first)', () => {
    // After fix/543: the native tasks.id is always the display id
    const row = makeTodo({ id: '272', external_id: '286' });
    const displayId = getDisplayId(row);
    assert.equal(displayId, 272);
    assert.notEqual(displayId, 286, 'must not display external_id 286 — callers address by native tasks.id');
  });

  it('returns internal id when external_id is null', () => {
    const row = makeTodo({ id: '1831', external_id: null });
    assert.equal(getDisplayId(row), 1831);
  });

  it('handles numeric external_id equal to internal id (no divergence case)', () => {
    // When the two are equal the result is the same either way
    const row = makeTodo({ id: '500', external_id: '500' });
    assert.equal(getDisplayId(row), 500);
  });

  it('divergence scenario: returns native tasks.id for each migrated todo (not external_id)', () => {
    // The incident rows — correctDisplayId is now the NATIVE tasks.id in each case
    const incidentRows: Array<{ id: string; external_id: string | null; title: string; correctDisplayId: number }> = [
      { id: '272', external_id: '286', title: 'Build Servos internal AI and portfolio/practice roadmap', correctDisplayId: 272 },
      { id: '258', external_id: '272', title: 'Figure out Jason Longsjo offboarding', correctDisplayId: 258 },
      { id: '286', external_id: '300', title: 'Build a Today in Review daily digest generator', correctDisplayId: 286 },
    ];

    for (const row of incidentRows) {
      const todo = makeTodo({ id: row.id, external_id: row.external_id, title: row.title });
      const displayId = getDisplayId(todo);

      // Corrected: display id is the native tasks.id — what the API addresses
      assert.equal(
        displayId,
        row.correctDisplayId,
        `${row.title}: expected display id ${row.correctDisplayId}, got ${displayId}`,
      );

      // Old code failure mode: would have returned external_id — which differs for all three
      if (row.external_id !== null && row.external_id !== row.id) {
        assert.notEqual(
          displayId,
          parseInt(row.external_id, 10),
          `${row.title}: must not display external_id ${row.external_id}`,
        );
      }
    }
  });
});
