#!/usr/bin/env node
// CI failure-delta gate (todo #1873): compares the HEAD ref's failing-test
// name set against the BASE ref's failing-test name set and fails (exit 1)
// iff HEAD introduces a failure that did not already exist on BASE.
//
// This is what makes the CI badge tell the truth: pre-existing failures are
// tolerated (and printed, never masked) so the gate doesn't block on the
// ~39-62 known-broken tests tracked separately (todo #2238), but any BRAND
// NEW failure fails the job.
//
// Usage: node diff-test-failures.mjs <head-failures-file> <base-failures-file>
// Input files: one "<label>::<file>::<test-name>" identifier per line, as
// produced by list-test-failures.mjs. Missing files are treated as empty.

import { readFileSync } from 'node:fs';

function loadSet(path) {
  try {
    return new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

const [headPath, basePath] = process.argv.slice(2);
if (!headPath || !basePath) {
  console.error('Usage: diff-test-failures.mjs <head-failures-file> <base-failures-file>');
  process.exit(2);
}

const head = loadSet(headPath);
const base = loadSet(basePath);

const newFailures = [...head].filter((t) => !base.has(t)).sort();
const tolerated = [...head].filter((t) => base.has(t)).sort();
const fixed = [...base].filter((t) => !head.has(t)).sort();

console.log('=== CI failure-delta gate (todo #1873) ===');
console.log(`Base (pre-existing) failing tests: ${base.size}`);
console.log(`Head failing tests: ${head.size}`);
console.log(`Tolerated pre-existing failures (still failing, also failing on base): ${tolerated.length}`);
for (const t of tolerated) console.log(`  [tolerated] ${t}`);

if (fixed.length) {
  console.log(`Pre-existing failures fixed on this branch: ${fixed.length}`);
  for (const t of fixed) console.log(`  [fixed] ${t}`);
}

if (newFailures.length) {
  console.log(`NEW failures introduced vs base: ${newFailures.length}`);
  for (const t of newFailures) console.log(`  [NEW FAILURE] ${t}`);
  console.error('');
  console.error(`FAIL: ${newFailures.length} new test failure(s) introduced vs base ref. See [NEW FAILURE] lines above.`);
  process.exit(1);
}

console.log('');
console.log(`PASS: no new test failures vs base ref (${tolerated.length} pre-existing failure(s) tolerated).`);
