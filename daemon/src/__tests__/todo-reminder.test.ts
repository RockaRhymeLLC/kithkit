/**
 * t-225: Todo reminder classifies todos into 3 variants
 *
 * Tests the classifyTodos helper and verifies all 3 message variants
 * fire correctly based on todo state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTodos, type TodoRow } from '../automation/tasks/todo-reminder.js';

const NOW = new Date('2026-05-10T12:00:00.000Z');

function makeTodo(overrides: Partial<TodoRow> = {}): TodoRow {
  return {
    id: '1',
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
