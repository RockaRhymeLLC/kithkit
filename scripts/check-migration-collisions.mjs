#!/usr/bin/env node
/**
 * scripts/check-migration-collisions.mjs
 *
 * Scans a migrations directory for files named NNN-description.sql and
 * exits non-zero if any numeric prefix (NNN) maps to more than one file.
 *
 * The migration runner keys applied-state on the parsed version number, so
 * a second file sharing a prefix is silently skipped — its DDL never runs
 * and no error is thrown. This script detects that condition before it can
 * take effect.
 *
 * Usage:
 *   node scripts/check-migration-collisions.mjs [--migrations <dir>]
 *
 * Defaults:
 *   --migrations  daemon/src/core/migrations
 *
 * Exit codes:
 *   0 — no duplicate prefixes found
 *   1 — one or more duplicate prefixes detected (details printed to stderr)
 *   2 — usage error (bad arguments, directory not found)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO_ROOT, 'daemon', 'src', 'core', 'migrations');

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let migrationsDir = DEFAULT_MIGRATIONS_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--migrations' && args[i + 1]) {
      migrationsDir = path.resolve(args[++i]);
    } else if (args[i].startsWith('--migrations=')) {
      migrationsDir = path.resolve(args[i].split('=')[1]);
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      process.exit(2);
    }
  }

  return { migrationsDir };
}

// ── Core logic ──────────────────────────────────────────────────────────────

/**
 * Scan a directory for migration files and return a map of
 * normalised version number → filenames[].
 *
 * Only files matching /^\d+-.*\.sql$/ are considered.
 * Prefixes are normalised via parseInt so that "016", "16", and "0016"
 * all map to the same version (16), matching the runner's keying behaviour.
 */
function groupByPrefix(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`Migrations directory not found: ${dir}`);
    process.exit(2);
  }

  const entries = fs.readdirSync(dir).filter(f => /^\d+-.+\.sql$/.test(f));
  /** @type {Map<number, string[]>} */
  const groups = new Map();

  for (const file of entries) {
    const rawPrefix = file.match(/^(\d+)-/)[1];
    const version = parseInt(rawPrefix, 10);
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(file);
  }

  return groups;
}

/**
 * Check for duplicate prefixes (by normalised version number).
 * Returns an array of { version, files } for every version with >1 file.
 */
function findCollisions(groups) {
  const collisions = [];
  for (const [version, files] of groups) {
    if (files.length > 1) {
      collisions.push({ version, files: files.sort() });
    }
  }
  return collisions.sort((a, b) => a.version - b.version);
}

// ── Entry point ─────────────────────────────────────────────────────────────

const { migrationsDir } = parseArgs(process.argv);
const groups = groupByPrefix(migrationsDir);
const collisions = findCollisions(groups);

if (collisions.length === 0) {
  console.log(`check-migration-collisions: OK (${groups.size} migration(s), no duplicate prefixes)`);
  process.exit(0);
}

console.error('check-migration-collisions: FAIL — duplicate migration prefixes detected');
console.error('');
for (const { version, files } of collisions) {
  console.error(`  Version ${version} (normalised) — ${files.length} files:`);
  for (const f of files) {
    console.error(`    ${f}`);
  }
}
console.error('');
console.error('Each migration prefix must be unique. Assign the new migration');
console.error('the next available number: MAX(existing prefixes) + 1.');
process.exit(1);
