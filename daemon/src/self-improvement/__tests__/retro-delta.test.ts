/**
 * Retro pipeline delta detection test (Q2).
 *
 * Verifies that:
 *   1. detectDelta returns null when comms_outcome is not set.
 *   2. 'corrected' comms_outcome → HIGH signal delta when result is present.
 *   3. 'redirected' comms_outcome → HIGH signal delta when result present, MEDIUM when absent.
 *   4. 'cancelled' comms_outcome → MEDIUM signal when result present, LOW when absent.
 *   5. 'accepted' with no corrections → signal='none', no lesson surfaced.
 *   6. 'accepted' with corrections → LOW signal lesson.
 *   7. extractDeltaLesson returns null for 'none' signal, string for meaningful deltas.
 *
 * Tests for shouldTriggerRetro and spawnRetro live in retro-evaluator.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelta, extractDeltaLesson } from '../retro/extract-from-delta.js';

// ── detectDelta tests ─────────────────────────────────────────

describe('detectDelta — delta detection between orch result and comms outcome', () => {
  it('1. returns null when comms_outcome is null (not yet acknowledged)', () => {
    const result = detectDelta({ result: 'done', comms_outcome: null, comms_corrections: null });
    assert.equal(result, null);
  });

  it('2. corrected + result → HIGH signal, diverged=true', () => {
    const result = detectDelta({
      result: 'I completed the task',
      comms_outcome: 'corrected',
      comms_corrections: '{"field":"corrected value"}',
    });
    assert.ok(result, 'Should return a delta lesson');
    assert.equal(result?.signal, 'high');
    assert.equal(result?.diverged, true);
    assert.ok(result?.description.includes('corrected'));
  });

  it('3. redirected + result → HIGH signal, diverged=true', () => {
    const result = detectDelta({
      result: 'done',
      comms_outcome: 'redirected',
      comms_corrections: null,
    });
    assert.ok(result);
    assert.equal(result?.signal, 'high');
    assert.equal(result?.diverged, true);
    assert.ok(result?.description.includes('redirected'));
  });

  it('3b. redirected + null result → MEDIUM signal, diverged=false', () => {
    const result = detectDelta({
      result: null,
      comms_outcome: 'redirected',
      comms_corrections: null,
    });
    assert.ok(result);
    assert.equal(result?.signal, 'medium');
    assert.equal(result?.diverged, false);
  });

  it('4a. cancelled + result present → MEDIUM signal, diverged=true', () => {
    const result = detectDelta({ result: 'some work', comms_outcome: 'cancelled', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'medium');
    assert.equal(result?.diverged, true);
  });

  it('4b. cancelled + no result → LOW signal, diverged=false', () => {
    const result = detectDelta({ result: null, comms_outcome: 'cancelled', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'low');
    assert.equal(result?.diverged, false);
  });

  it('5. accepted + no corrections → signal=none, diverged=false', () => {
    const result = detectDelta({ result: 'done', comms_outcome: 'accepted', comms_corrections: null });
    assert.ok(result);
    assert.equal(result?.signal, 'none');
    assert.equal(result?.diverged, false);
  });

  it('6. accepted + corrections → LOW signal', () => {
    const result = detectDelta({
      result: 'done',
      comms_outcome: 'accepted',
      comms_corrections: '{"minor":"fix"}',
    });
    assert.ok(result);
    assert.equal(result?.signal, 'low');
  });
});

// ── extractDeltaLesson tests ──────────────────────────────────

describe('extractDeltaLesson — convenience wrapper for retro prompt inclusion', () => {
  it('7a. returns null for signal=none', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'accepted', comms_corrections: null });
    assert.equal(lesson, null);
  });

  it('7b. returns null when comms_outcome is null', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: null, comms_corrections: null });
    assert.equal(lesson, null);
  });

  it('7c. returns a non-null string for HIGH signal', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'corrected', comms_corrections: null });
    assert.ok(typeof lesson === 'string', 'Should return a string');
    assert.ok(lesson.includes('[Delta signal: HIGH]'), `Expected HIGH prefix in: ${lesson}`);
  });

  it('7d. returned string contains description', () => {
    const lesson = extractDeltaLesson({ result: 'done', comms_outcome: 'redirected', comms_corrections: null });
    assert.ok(lesson?.includes('redirected'), 'Lesson should describe the redirection');
  });
});
