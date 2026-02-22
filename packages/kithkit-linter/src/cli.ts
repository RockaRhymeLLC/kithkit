#!/usr/bin/env node

/**
 * Kithkit Linter CLI
 *
 * Usage:
 *   kithkit-lint <dir>         Human-readable output
 *   kithkit-lint --json <dir>  Machine-parseable JSON output
 */

import { resolve } from 'node:path';
import { lint } from './index.ts';
import type { LintResult, Finding } from './types.ts';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const dirArg = args.find(a => a !== '--json');

if (!dirArg) {
  console.error('Usage: kithkit-lint [--json] <skill-directory>');
  process.exit(1);
}

const skillDir = resolve(dirArg);
const result = lint(skillDir);

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHumanReadable(result);
}

process.exit(result.pass ? 0 : 1);

function printHumanReadable(result: LintResult) {
  const icon = result.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`\n${icon} Kithkit Lint: ${result.pass ? 'PASSED' : 'FAILED'}`);
  console.log(`  ${result.score.errors} error(s), ${result.score.warnings} warning(s), ${result.score.info} info`);
  console.log(`  Duration: ${result.duration_ms}ms\n`);

  const allFindings: Finding[] = [];
  for (const [checkName, check] of Object.entries(result.checks)) {
    for (const f of check.findings) {
      allFindings.push(f);
    }
  }

  if (allFindings.length === 0) {
    console.log('  All checks passed.\n');
    return;
  }

  for (const f of allFindings) {
    const color = f.severity === 'error' ? '\x1b[31m' : f.severity === 'warning' ? '\x1b[33m' : '\x1b[36m';
    const reset = '\x1b[0m';
    const fileInfo = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
    console.log(`  ${color}${f.severity.toUpperCase()}${reset} [${f.check}]${fileInfo}: ${f.message}`);
  }
  console.log('');
}
