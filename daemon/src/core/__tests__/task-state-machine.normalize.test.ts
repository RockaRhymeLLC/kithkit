/**
 * Unit tests for normalizeStatusAlias (#211).
 *
 * Pure function — no HTTP server, no DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStatusAlias } from '../task-state-machine.js';

describe('normalizeStatusAlias', { concurrency: 1 }, () => {
  it("'done' → 'completed'", () => {
    assert.equal(normalizeStatusAlias('done'), 'completed');
  });

  it("'DONE' → 'completed' (case-insensitive)", () => {
    assert.equal(normalizeStatusAlias('DONE'), 'completed');
  });

  it("'Done' → 'completed' (mixed case)", () => {
    assert.equal(normalizeStatusAlias('Done'), 'completed');
  });

  it("'wip' → 'in_progress'", () => {
    assert.equal(normalizeStatusAlias('wip'), 'in_progress');
  });

  it("'WIP' → 'in_progress' (case-insensitive)", () => {
    assert.equal(normalizeStatusAlias('WIP'), 'in_progress');
  });

  it("'Wip' → 'in_progress' (mixed case)", () => {
    assert.equal(normalizeStatusAlias('Wip'), 'in_progress');
  });

  it("'completed' passes through unchanged (already canonical)", () => {
    assert.equal(normalizeStatusAlias('completed'), 'completed');
  });

  it("'in_progress' passes through unchanged (already canonical)", () => {
    assert.equal(normalizeStatusAlias('in_progress'), 'in_progress');
  });

  it("'bogus' passes through unchanged (let validator reject it)", () => {
    assert.equal(normalizeStatusAlias('bogus'), 'bogus');
  });

  it('non-string input passes through unchanged (number)', () => {
    assert.equal(normalizeStatusAlias(42), 42);
  });

  it('non-string input passes through unchanged (null)', () => {
    assert.equal(normalizeStatusAlias(null), null);
  });

  it('non-string input passes through unchanged (undefined)', () => {
    assert.equal(normalizeStatusAlias(undefined), undefined);
  });
});
