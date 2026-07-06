// SCRATCH: deliberately failing test used to prove the CI delta-gate
// (todo #1873, PR #502) correctly detects and names a NEW failure that
// does not exist on the base ref. This file is removed before the
// scratch branch is deleted — it must never land on a real branch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ci-delta-gate-planted-proof: deliberately fails to prove the delta gate', () => {
  assert.strictEqual(1, 2, 'planted failure for CI delta-gate acceptance proof');
});
