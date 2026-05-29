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

// ── t-1811 regression: getDisplayId must return external_id-based id ──────────

describe('getDisplayId (t-1811: id-space mismatch regression)', () => {
  /**
   * Live evidence from 2026-05-29:
   *   tasks.id=272, external_id='286' → "Build Servos internal AI roadmap" (in_progress)
   *   external_id='272' → tasks.id=258 → "Jason Longsjo offboarding" (completed)
   *
   * Old code: displayed `[272]` (internal id) → user looked up id 272 in
   *   /api/todos → saw "Jason Longsjo offboarding" (wrong, different, completed todo).
   * Fixed code: displays `[286]` (from external_id) → matches /api/todos response.
   */

  it('returns external_id integer when external_id is set (primary case)', () => {
    // Reproduces the exact diverged row: tasks.id=272, external_id='286'
    const row = makeTodo({ id: '272', external_id: '286' });
    assert.equal(getDisplayId(row), 286);
  });

  it('does NOT return internal tasks.id when external_id is set (old-code failure mode)', () => {
    // This assertion would have FAILED with the old code (which returned Number(top.id) = 272)
    const row = makeTodo({ id: '272', external_id: '286' });
    const displayId = getDisplayId(row);
    assert.notEqual(displayId, 272, 'must not display internal tasks.id 272 — that resolves to a different todo');
    assert.equal(displayId, 286);
  });

  it('falls back to internal id when external_id is null (new todos created post-migration)', () => {
    // New todos get external_id = String(tasks.id) immediately on create, but
    // during the brief window before the UPDATE, external_id may be null.
    // Also covers any edge case where external_id is absent.
    const row = makeTodo({ id: '1831', external_id: null });
    assert.equal(getDisplayId(row), 1831);
  });

  it('handles numeric external_id equal to internal id (no divergence case)', () => {
    // New todos eventually get external_id = tasks.id — should be consistent either way
    const row = makeTodo({ id: '500', external_id: '500' });
    assert.equal(getDisplayId(row), 500);
  });

  it('divergence scenario: proves old code would show wrong id for migrated todo', () => {
    // Simulate the real incident data for the three affected todos
    const incidentRows: Array<{ id: string; external_id: string | null; title: string; correctDisplayId: number }> = [
      { id: '272', external_id: '286', title: 'Build Servos internal AI and portfolio/practice roadmap', correctDisplayId: 286 },
      { id: '258', external_id: '272', title: 'Figure out Jason Longsjo offboarding', correctDisplayId: 272 },
      { id: '286', external_id: '300', title: 'Build a Today in Review daily digest generator', correctDisplayId: 300 },
    ];

    for (const row of incidentRows) {
      const todo = makeTodo({ id: row.id, external_id: row.external_id, title: row.title });
      const displayId = getDisplayId(todo);

      // Fixed: display id matches the external_id-based user-facing id
      assert.equal(
        displayId,
        row.correctDisplayId,
        `${row.title}: expected display id ${row.correctDisplayId}, got ${displayId}`,
      );

      // Old code failure mode: would have returned Number(row.id) — which differs for all three
      if (row.external_id !== null && row.external_id !== row.id) {
        assert.notEqual(
          displayId,
          Number(row.id),
          `${row.title}: must not display internal id ${row.id}`,
        );
      }
    }
  });
});
