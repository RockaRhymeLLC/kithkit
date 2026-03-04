#!/usr/bin/env node
/**
 * divergence-check.ts — Compare upstream/main with local main.
 *
 * Classifies each changed file as "framework" or "instance" using the
 * .kithkit-private manifest (glob-based). Reports files ahead, behind,
 * and divergent relative to upstream.
 *
 * Usage:
 *   npx tsx scripts/divergence-check.ts [--json]
 *   bash scripts/divergence-check.sh [--json]
 *
 * Flags:
 *   --json    Machine-readable JSON output
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';

// ── Config ──────────────────────────────────────────────────

const PROJECT_DIR = path.resolve(import.meta.dirname, '..');
const PRIVATE_MANIFEST = path.join(PROJECT_DIR, '.kithkit-private');
const UPSTREAM_REMOTE = 'upstream';
const UPSTREAM_BRANCH = 'main';
const LOCAL_BRANCH = 'main';

// ── Types ────────────────────────────────────────────────────

interface FileClassification {
  path: string;
  classification: 'framework' | 'instance';
  reason?: string;
}

interface DivergenceReport {
  timestamp: string;
  upstreamRef: string;
  localRef: string;
  commitsAhead: number;
  commitsBehind: number;
  filesAhead: FileClassification[];    // local has but upstream doesn't
  filesBehind: FileClassification[];   // upstream has but local doesn't
  divergentFiles: FileClassification[]; // both changed (different content)
  instanceOnlyFiles: FileClassification[]; // local-only instance files
  summary: {
    totalFrameworkChanges: number;
    totalInstanceChanges: number;
    syncSafe: boolean;
  };
}

// ── Private manifest ─────────────────────────────────────────

function loadPrivatePatterns(): string[] {
  if (!existsSync(PRIVATE_MANIFEST)) return [];
  return readFileSync(PRIVATE_MANIFEST, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function isInstanceFile(filePath: string, patterns: string[]): boolean {
  return patterns.some(pattern =>
    minimatch(filePath, pattern, { matchBase: false, dot: true }) ||
    // Also check if the file is under a directory pattern (trailing /)
    (pattern.endsWith('/') && filePath.startsWith(pattern))
  );
}

// ── Git helpers ──────────────────────────────────────────────

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
  }).trim();
}

function gitSafe(...args: string[]): string {
  try {
    return git(...args);
  } catch {
    return '';
  }
}

// ── Main ─────────────────────────────────────────────────────

function run(): void {
  const jsonMode = process.argv.includes('--json');

  // Ensure upstream remote exists
  const remotes = gitSafe('remote').split('\n');
  if (!remotes.includes(UPSTREAM_REMOTE)) {
    const msg = `Remote "${UPSTREAM_REMOTE}" not found. Add it with:\n  git remote add upstream <upstream-url>`;
    if (jsonMode) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  // Fetch upstream silently
  try {
    execFileSync('git', ['fetch', UPSTREAM_REMOTE, UPSTREAM_BRANCH, '--no-tags', '--quiet'], {
      cwd: PROJECT_DIR,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    // Continue with cached refs if fetch fails
  }

  const upstreamRef = `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;
  const localRef = LOCAL_BRANCH;

  let upstreamSha: string;
  let localSha: string;

  try {
    upstreamSha = git('rev-parse', upstreamRef);
    localSha = git('rev-parse', localRef);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      console.log(JSON.stringify({ error: `Could not resolve refs: ${msg}` }, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exit(1);
  }

  // Commit counts
  const aheadStr = gitSafe('rev-list', `${upstreamRef}..${localRef}`, '--count');
  const behindStr = gitSafe('rev-list', `${localRef}..${upstreamRef}`, '--count');
  const commitsAhead = parseInt(aheadStr, 10) || 0;
  const commitsBehind = parseInt(behindStr, 10) || 0;

  // Load classification patterns
  const patterns = loadPrivatePatterns();

  // Files changed in upstream not in local (we're behind on)
  const filesBehindRaw = gitSafe('diff', '--name-only', `${localRef}...${upstreamRef}`);
  // Files local has added/changed vs upstream (we're ahead on)
  const filesAheadRaw = gitSafe('diff', '--name-only', `${upstreamRef}...${localRef}`);
  // Divergent: changed on both sides (merge base differs from both)
  const mergeBase = gitSafe('merge-base', localRef, upstreamRef);
  let divergentRaw = '';
  if (mergeBase) {
    // Files changed from merge-base on upstream side
    const upstreamChanged = new Set(
      gitSafe('diff', '--name-only', mergeBase, upstreamRef).split('\n').filter(Boolean)
    );
    // Files changed from merge-base on local side
    const localChanged = new Set(
      gitSafe('diff', '--name-only', mergeBase, localRef).split('\n').filter(Boolean)
    );
    // Intersection = divergent
    divergentRaw = [...upstreamChanged]
      .filter(f => localChanged.has(f))
      .join('\n');
  }

  const classify = (filePath: string): FileClassification => {
    const classification = isInstanceFile(filePath, patterns) ? 'instance' : 'framework';
    return { path: filePath, classification };
  };

  const filesBehind = filesBehindRaw.split('\n').filter(Boolean).map(classify);
  const filesAhead = filesAheadRaw.split('\n').filter(Boolean).map(classify);
  const divergentFiles = divergentRaw.split('\n').filter(Boolean).map(classify);

  // Instance-only: files ahead that are instance-classified
  const instanceOnlyFiles = filesAhead.filter(f => f.classification === 'instance');

  // Summary
  const allChanged = [...filesBehind, ...filesAhead, ...divergentFiles];
  const totalFrameworkChanges = allChanged.filter(f => f.classification === 'framework').length;
  const totalInstanceChanges = allChanged.filter(f => f.classification === 'instance').length;
  // Sync is "safe" if there are no local divergent framework files
  const divergentFramework = divergentFiles.filter(f => f.classification === 'framework');
  const syncSafe = divergentFramework.length === 0;

  const report: DivergenceReport = {
    timestamp: new Date().toISOString(),
    upstreamRef: upstreamSha,
    localRef: localSha,
    commitsAhead,
    commitsBehind,
    filesAhead,
    filesBehind,
    divergentFiles,
    instanceOnlyFiles,
    summary: {
      totalFrameworkChanges,
      totalInstanceChanges,
      syncSafe,
    },
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // Human-readable output
    console.log(`\nDivergence Report — ${report.timestamp}`);
    console.log(`  Local:    ${localSha.slice(0, 12)} (${localRef})`);
    console.log(`  Upstream: ${upstreamSha.slice(0, 12)} (${upstreamRef})`);
    console.log(`  Ahead by: ${commitsAhead} commits`);
    console.log(`  Behind by: ${commitsBehind} commits`);
    console.log();

    const printFiles = (label: string, files: FileClassification[]) => {
      if (files.length === 0) return;
      console.log(`${label} (${files.length}):`);
      for (const f of files) {
        const tag = f.classification === 'instance' ? '[instance]' : '[framework]';
        console.log(`  ${tag.padEnd(12)} ${f.path}`);
      }
      console.log();
    };

    printFiles('Files behind (upstream has, local missing)', filesBehind);
    printFiles('Files ahead (local has, upstream missing)', filesAhead);
    printFiles('Divergent files (changed on both sides)', divergentFiles);

    console.log('Summary:');
    console.log(`  Framework changes: ${totalFrameworkChanges}`);
    console.log(`  Instance changes:  ${totalInstanceChanges}`);
    console.log(`  Sync safe:         ${syncSafe ? 'YES' : 'NO — divergent framework files need review'}`);

    if (!syncSafe) {
      console.log('\nDivergent framework files (require manual merge):');
      for (const f of divergentFramework) {
        console.log(`  ${f.path}`);
      }
    }
    console.log();
  }
}

run();
