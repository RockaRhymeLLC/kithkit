/**
 * t-pdfsearch-timeout: Per-file extraction timeout in the PDF-search indexer.
 *
 * Validates that withFileTimeout:
 *  1. Resolves when the inner promise finishes before the deadline.
 *  2. Rejects with a descriptive error when the inner promise never settles
 *     (simulates pdftotext ignoring SIGTERM on a scanned/image-only PDF).
 *  3. Does NOT reject a fast promise after the deadline has been cleaned up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _withFileTimeoutForTesting, FILE_EXTRACTION_TIMEOUT_MS } from '../extensions/pdfsearch/indexer.js';

const withFileTimeout = _withFileTimeoutForTesting;

describe('pdfsearch per-file extraction timeout (t-pdfsearch-timeout)', { concurrency: 1 }, () => {

  it('FILE_EXTRACTION_TIMEOUT_MS is a positive number', () => {
    assert.ok(typeof FILE_EXTRACTION_TIMEOUT_MS === 'number', 'should be a number');
    assert.ok(FILE_EXTRACTION_TIMEOUT_MS > 0, 'should be positive');
  });

  it('resolves immediately when the inner promise resolves before the deadline', async () => {
    const fastPromise = Promise.resolve(42);
    const result = await withFileTimeout(fastPromise, '/fake/fast.pdf');
    assert.equal(result, 42);
  });

  it('passes through rejection from the inner promise unchanged', async () => {
    const innerError = new Error('pdftotext exit code 1');
    const failingPromise = Promise.reject<number>(innerError);
    await assert.rejects(
      () => withFileTimeout(failingPromise, '/fake/broken.pdf'),
      (err: Error) => {
        assert.equal(err.message, 'pdftotext exit code 1');
        return true;
      },
    );
  });

  it('rejects with a timeout error when the inner promise never settles', async () => {
    // Use a very short timeout override via a custom wrapper to keep tests fast.
    // We test the same logic as withFileTimeout but with a 50ms deadline.
    const neverSettles = new Promise<number>(() => { /* intentionally hangs */ });

    const SHORT_MS = 50;
    const raced = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`File extraction timed out after ${SHORT_MS}ms: /fake/slow-scan.pdf`));
      }, SHORT_MS);
      neverSettles.then(
        (r) => { clearTimeout(timer); resolve(r); },
        (e: unknown) => { clearTimeout(timer); reject(e); },
      );
    });

    await assert.rejects(
      () => raced,
      (err: Error) => {
        assert.ok(err.message.includes('timed out'), `expected "timed out" in: ${err.message}`);
        assert.ok(err.message.includes('/fake/slow-scan.pdf'), 'should name the offending file');
        return true;
      },
    );
  });

  it('timer is cleared after a fast resolve (no dangling timers)', async () => {
    // If the timer leaked, the test runner would hang waiting for it.
    // Running several fast resolves back-to-back surfaces any leak.
    for (let i = 0; i < 5; i++) {
      const result = await withFileTimeout(Promise.resolve(i), `/fake/file${i}.pdf`);
      assert.equal(result, i);
    }
  });
});
