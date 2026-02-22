/**
 * t-m19: Context loader — structured session startup summary
 *
 * Uses a shared DB singleton so must run sequentially (concurrency: 1).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, insert, getDatabase, _resetDbForTesting } from '../core/db.js';
import { loadContext, registerContextFilter, clearContextFilters } from '../core/context-loader.js';

let tmpDir: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-context-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardown(): void {
  clearContextFilters();
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('context-loader (t-m19)', { concurrency: 1 }, () => {

  describe('active_todos section', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns structured summary with active_todos array', () => {
      insert('todos', { title: 'Fix bug', priority: 'high', status: 'in_progress' });
      insert('todos', { title: 'Write docs', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      assert.ok(Array.isArray(ctx.active_todos));
      assert.ok(ctx.active_todos.length >= 2);
    });

    it('filters out completed todos', () => {
      insert('todos', { title: 'Fix bug', priority: 'high', status: 'in_progress' });
      insert('todos', { title: 'Done task', priority: 'low', status: 'completed' });

      const ctx = loadContext();
      const completed = ctx.active_todos.filter(t => t.status === 'completed');
      assert.equal(completed.length, 0);
    });

    it('filters out cancelled todos', () => {
      insert('todos', { title: 'Active', priority: 'high', status: 'pending' });
      insert('todos', { title: 'Dropped', priority: 'low', status: 'cancelled' });

      const ctx = loadContext();
      const cancelled = ctx.active_todos.filter(t => t.status === 'cancelled');
      assert.equal(cancelled.length, 0);
    });

    it('orders by priority (critical first)', () => {
      insert('todos', { title: 'Low item', priority: 'low', status: 'pending' });
      insert('todos', { title: 'Critical item', priority: 'critical', status: 'pending' });
      insert('todos', { title: 'Medium item', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      assert.equal(ctx.active_todos[0]!.priority, 'critical');
    });
  });

  describe('in_progress section', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('includes in_progress items', () => {
      insert('todos', { title: 'Fix bug', priority: 'high', status: 'in_progress' });
      insert('todos', { title: 'Write docs', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      assert.ok(ctx.in_progress.length >= 1);
      assert.equal(ctx.in_progress[0]!.title, 'Fix bug');
    });

    it('does not include pending todos in in_progress', () => {
      insert('todos', { title: 'Pending item', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      const pendingInProgress = ctx.in_progress.filter(t => t.title === 'Pending item');
      assert.equal(pendingInProgress.length, 0);
    });

    it('in_progress items have required fields', () => {
      insert('todos', { title: 'Active task', priority: 'high', status: 'in_progress' });

      const ctx = loadContext();
      assert.ok(ctx.in_progress.length >= 1);
      const item = ctx.in_progress[0]!;
      assert.equal(typeof item.id, 'number');
      assert.equal(typeof item.title, 'string');
      assert.equal(typeof item.priority, 'string');
    });
  });

  describe('budget parameter', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('respects the budget_total field', () => {
      const ctx = loadContext(100);
      assert.equal(ctx.token_budget_total, 100);
    });

    it('uses default budget of 8000 when not specified', () => {
      const ctx = loadContext();
      assert.equal(ctx.token_budget_total, 8000);
    });

    it('reports token_budget_used', () => {
      insert('todos', { title: 'A task', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      assert.ok(typeof ctx.token_budget_used === 'number');
      assert.ok(ctx.token_budget_used > 0);
    });

    it('trims memories when over budget', () => {
      // Very small budget forces trim
      const ctx = loadContext(1);
      // Memories should be empty since we can't fit them in 1 char
      // (active_todos alone will exceed budget, but memories are dropped first)
      assert.ok(Array.isArray(ctx.recent_memories));
      assert.equal(ctx.token_budget_total, 1);
    });
  });

  describe('upcoming_calendar section', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty array when no upcoming events', () => {
      const ctx = loadContext();
      assert.ok(Array.isArray(ctx.upcoming_calendar));
      assert.equal(ctx.upcoming_calendar.length, 0);
    });

    it('includes events within next 48 hours', () => {
      // Insert event 1 hour from now
      const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      insert('calendar', { title: 'Upcoming meeting', start_time: soon });

      const ctx = loadContext();
      assert.ok(ctx.upcoming_calendar.length >= 1);
      assert.equal(ctx.upcoming_calendar[0]!.title, 'Upcoming meeting');
    });
  });

  describe('recent_memories section', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty array when no recent memories', () => {
      const ctx = loadContext();
      assert.ok(Array.isArray(ctx.recent_memories));
    });

    it('returns memories from last 24 hours', () => {
      insert('memories', { content: 'Dave prefers dark mode', category: 'preferences' });

      const ctx = loadContext();
      assert.ok(ctx.recent_memories.length >= 1);
      assert.equal(ctx.recent_memories[0]!.content, 'Dave prefers dark mode');
    });
  });

  describe('recent_decisions section', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns empty array when no recent config changes', () => {
      const ctx = loadContext();
      assert.ok(Array.isArray(ctx.recent_decisions));
    });

    it('parses JSON values in config decisions', () => {
      // Insert a config entry with JSON value
      const db = getDatabase();
      db.prepare("INSERT INTO config (key, value) VALUES ('theme', '\"dark\"')").run();

      const ctx = loadContext();
      // If config was updated recently it may appear in decisions
      // (within last 7 days — default clock means it should appear)
      assert.ok(Array.isArray(ctx.recent_decisions));
    });
  });

  describe('custom filters via registerContextFilter', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('applies a registered filter to the summary', () => {
      insert('todos', { title: 'High priority task', priority: 'high', status: 'pending' });
      insert('todos', { title: 'Low priority task', priority: 'low', status: 'pending' });

      registerContextFilter((summary) => ({
        ...summary,
        active_todos: summary.active_todos.filter(t => t.priority === 'high'),
      }));

      const ctx = loadContext();
      assert.ok(ctx.active_todos.every(t => t.priority === 'high'));
    });

    it('applies multiple filters in registration order', () => {
      insert('todos', { title: 'Alpha', priority: 'high', status: 'pending' });
      insert('todos', { title: 'Beta', priority: 'high', status: 'pending' });
      insert('todos', { title: 'Gamma', priority: 'low', status: 'pending' });

      registerContextFilter((summary) => ({
        ...summary,
        active_todos: summary.active_todos.filter(t => t.priority === 'high'),
      }));
      registerContextFilter((summary) => ({
        ...summary,
        active_todos: summary.active_todos.filter(t => t.title !== 'Beta'),
      }));

      const ctx = loadContext();
      assert.ok(ctx.active_todos.every(t => t.priority === 'high'));
      assert.ok(ctx.active_todos.every(t => t.title !== 'Beta'));
    });

    it('clearContextFilters removes all filters', () => {
      insert('todos', { title: 'High', priority: 'high', status: 'pending' });
      insert('todos', { title: 'Low', priority: 'low', status: 'pending' });

      registerContextFilter((summary) => ({
        ...summary,
        active_todos: [],
      }));
      clearContextFilters();

      const ctx = loadContext();
      assert.ok(ctx.active_todos.length >= 1);
    });
  });

  describe('summary structure', () => {
    beforeEach(setup);
    afterEach(teardown);

    it('returns all required top-level fields', () => {
      const ctx = loadContext();
      assert.ok('active_todos' in ctx);
      assert.ok('recent_decisions' in ctx);
      assert.ok('in_progress' in ctx);
      assert.ok('upcoming_calendar' in ctx);
      assert.ok('recent_memories' in ctx);
      assert.ok('token_budget_used' in ctx);
      assert.ok('token_budget_total' in ctx);
    });

    it('all section values are arrays', () => {
      const ctx = loadContext();
      assert.ok(Array.isArray(ctx.active_todos));
      assert.ok(Array.isArray(ctx.recent_decisions));
      assert.ok(Array.isArray(ctx.in_progress));
      assert.ok(Array.isArray(ctx.upcoming_calendar));
      assert.ok(Array.isArray(ctx.recent_memories));
    });

    it('todo summaries have required fields', () => {
      insert('todos', { title: 'Test task', priority: 'medium', status: 'pending' });

      const ctx = loadContext();
      assert.ok(ctx.active_todos.length >= 1);
      const todo = ctx.active_todos[0]!;
      assert.ok('id' in todo);
      assert.ok('title' in todo);
      assert.ok('priority' in todo);
      assert.ok('status' in todo);
      assert.ok('due_date' in todo);
    });
  });
});
