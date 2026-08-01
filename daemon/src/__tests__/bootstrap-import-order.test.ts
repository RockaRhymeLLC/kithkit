/**
 * bootstrap.ts must prime loadConfig() with the correct projectDir
 * BEFORE the extension tree is imported, because several modules call
 * loadConfig() bare (no argument) at import time. Static imports hoist —
 * they run before any of the importing module's own top-level code — so if
 * bootstrap.ts imported extensions statically, one of those bare calls would
 * cache the wrong (cwd-based) config before the prime ever ran.
 *
 * There is no existing harness in this suite for spawning the full compiled
 * daemon (dist/bootstrap.js -> dist/main.js) as a subprocess, and building
 * one just for this would be heavy and flaky (real DB, real port, real
 * extension init). Instead this file verifies the invariant two ways:
 *
 *  1. A minimal, honest reproduction of the actual ESM ordering mechanism
 *     bootstrap.ts's fix relies on (static imports hoist, dynamic imports
 *     don't) — proven by executing real fixture modules, not by inspecting
 *     source text.
 *  2. A structural check on the actual shipped dist/bootstrap.js confirming
 *     it uses the dynamic-import shape (prime call before any `await
 *     import`, and no static import of the extension tree) — a guard
 *     against someone "tidying" the dynamic imports back to static, which
 *     would silently reintroduce the bug with nothing failing at runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('bootstrap import-order mechanism', () => {
  it('static imports hoist above the importing module\'s own top-level code (reproduces the bug shape)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-boot-static-'));
    fs.writeFileSync(path.join(dir, 'log.mjs'), 'export const log = [];\n');
    fs.writeFileSync(
      path.join(dir, 'ext.mjs'),
      "import { log } from './log.mjs';\nlog.push('ext-module-top-level-call');\n",
    );
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      "import './ext.mjs';\n" + // simulates: extensions/index.js imported statically
      "import { log } from './log.mjs';\n" +
      "log.push('prime');\n" + // simulates: loadConfig(projectDir) in bootstrap.ts's own body
      'export { log };\n',
    );

    const mod = await import(pathToFileURL(path.join(dir, 'entry.mjs')).href);
    // Bug shape: the extension's bare call ran BEFORE the prime, because the
    // static import of ext.mjs is hoisted above entry.mjs's own top-level code.
    assert.deepEqual(mod.log, ['ext-module-top-level-call', 'prime']);
  });

  it('dynamic import() runs after the importing module\'s own top-level code (this is the fix bootstrap.ts uses)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-boot-dynamic-'));
    fs.writeFileSync(path.join(dir, 'log.mjs'), 'export const log = [];\n');
    fs.writeFileSync(
      path.join(dir, 'ext.mjs'),
      "import { log } from './log.mjs';\nlog.push('ext-module-top-level-call');\n",
    );
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      "import { log } from './log.mjs';\n" +
      "log.push('prime');\n" + // prime runs first, exactly like bootstrap.ts's loadConfig(projectDir)
      "await import('./ext.mjs');\n" + // extension tree imported dynamically, after the prime
      'export { log };\n',
    );

    const mod = await import(pathToFileURL(path.join(dir, 'entry.mjs')).href);
    // Fixed shape: the prime always runs before the extension's bare call.
    assert.deepEqual(mod.log, ['prime', 'ext-module-top-level-call']);
  });
});

describe('bootstrap.ts shipped output structure (regression guard)', () => {
  const distBootstrapPath = path.resolve(__dirname, '../bootstrap.js');

  it('dist/bootstrap.js exists (build ran)', () => {
    assert.ok(fs.existsSync(distBootstrapPath), `expected ${distBootstrapPath} to exist — run npm run build first`);
  });

  it('primes loadConfig(projectDir) before any dynamic import of the extension tree', () => {
    const src = fs.readFileSync(distBootstrapPath, 'utf8');
    const primeIndex = src.search(/loadConfig\(\s*projectDir\s*\)/);
    const firstDynamicImportIndex = src.search(/await\s+import\(/);
    assert.ok(primeIndex !== -1, 'expected a loadConfig(projectDir) prime call in bootstrap.js');
    assert.ok(firstDynamicImportIndex !== -1, 'expected at least one dynamic await import() in bootstrap.js');
    assert.ok(
      primeIndex < firstDynamicImportIndex,
      `loadConfig(projectDir) (index ${primeIndex}) must appear before the first dynamic import (index ${firstDynamicImportIndex})`,
    );
  });

  it('does not statically import the extension tree (which would hoist above the prime)', () => {
    const src = fs.readFileSync(distBootstrapPath, 'utf8');
    // Strip dynamic `await import(...)` occurrences first so they can't be
    // mistaken for static `import ... from '...'` declarations below.
    const withoutDynamicImports = src.replace(/await\s+import\([^)]*\)/g, '');
    const staticImportSpecifiers = [...withoutDynamicImports.matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]);
    for (const specifier of staticImportSpecifiers) {
      assert.ok(
        !specifier.includes('extensions.js') && !specifier.includes('extensions/index.js'),
        `bootstrap.js must not statically import the extension tree (found static import of "${specifier}"), ` +
        'because static imports hoist above the loadConfig(projectDir) prime and would silently reintroduce the bug',
      );
    }
  });
});
