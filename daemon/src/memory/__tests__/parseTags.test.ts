/**
 * t-E-parseTags: Mutation-killing tests for Batch E parseTags behavior.
 *
 * E behavior: parseTags() wraps JSON.parse in try/catch so a single malformed
 * tags column value does not throw and break the full result set. It also
 * handles null/undefined/empty gracefully and rejects non-array JSON.
 *
 * RED when reverted: replacing parseTags with bare JSON.parse(raw) causes
 * SyntaxError on every malformed-tags assertion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTags } from '../vector-search.js';

describe('parseTags — E behavior: defensive JSON parse (t-E-parseTags)', { concurrency: 1 }, () => {

  // ── try/catch branch — mutation-killing ─────────────────────

  it('returns [] for malformed JSON (not-valid-json)', () => {
    // MUTATION KILL: remove try/catch → JSON.parse throws SyntaxError → test fails
    assert.deepEqual(parseTags('not-valid-json'), []);
  });

  it('returns [] for brace-invalid JSON ({invalid})', () => {
    assert.deepEqual(parseTags('{invalid}'), []);
  });

  it('returns [] for trailing-comma JSON ([1,2,])', () => {
    assert.deepEqual(parseTags('[1,2,]'), []);
  });

  it('returns [] for bare number string that is not an array', () => {
    // JSON.parse('42') succeeds but !Array.isArray — must return []
    // MUTATION KILL: remove Array.isArray guard → returns 42 instead of []
    assert.deepEqual(parseTags('42'), []);
  });

  it('returns [] for object JSON (not an array)', () => {
    // MUTATION KILL: remove Array.isArray guard → returns {} instead of []
    assert.deepEqual(parseTags('{"key":"value"}'), []);
  });

  it('returns [] for a bare string JSON value', () => {
    assert.deepEqual(parseTags('"just a string"'), []);
  });

  // ── null/undefined/empty guard — mutation-killing ───────────

  it('returns [] for null', () => {
    // MUTATION KILL: remove !raw guard → JSON.parse(null) === null → not array → [] via isArray
    // (or throw if try/catch also removed). Guard is needed for correct short-circuit.
    assert.deepEqual(parseTags(null), []);
  });

  it('returns [] for undefined', () => {
    assert.deepEqual(parseTags(undefined), []);
  });

  it('returns [] for empty string', () => {
    // MUTATION KILL: remove !raw guard → JSON.parse('') throws SyntaxError
    assert.deepEqual(parseTags(''), []);
  });

  // ── happy path — confirms forward behavior unchanged ────────

  it('returns string array for valid JSON array', () => {
    assert.deepEqual(parseTags('["tag-a","tag-b"]'), ['tag-a', 'tag-b']);
  });

  it('returns empty array for valid empty JSON array', () => {
    assert.deepEqual(parseTags('[]'), []);
  });

  it('returns number array elements as-is for mixed JSON array', () => {
    assert.deepEqual(parseTags('[1,2,3]'), [1, 2, 3]);
  });
});
