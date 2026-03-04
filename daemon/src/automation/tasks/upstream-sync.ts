/**
 * Upstream sync task — checks for new upstream commits and reports divergence.
 *
 * Fetches upstream/main, runs the divergence check script, and logs results.
 * Does NOT auto-merge — all syncs create PRs for agent review via GitHub Actions.
 *
 * Triggered:
 *   - Manually via POST /api/tasks/upstream-sync/run
 *   - Scheduled (configure in kithkit.config.yaml)
 *
 * Example config entry:
 *   scheduler:
 *     tasks:
 *       - name: upstream-sync
 *         enabled: true
 *         cron: "0 8 * * 1"   # Monday 8 AM UTC (matches CI cron)
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('upstream-sync');

interface DivergenceResult {
  timestamp: string;
  upstreamRef: string;
  localRef: string;
  commitsAhead: number;
  commitsBehind: number;
  filesAhead: Array<{ path: string; classification: string }>;
  filesBehind: Array<{ path: string; classification: string }>;
  divergentFiles: Array<{ path: string; classification: string }>;
  summary: {
    totalFrameworkChanges: number;
    totalInstanceChanges: number;
    syncSafe: boolean;
  };
  error?: string;
}

async function run(): Promise<void> {
  const projectDir = getProjectDir();
  const scriptPath = path.join(projectDir, 'scripts', 'divergence-check.sh');

  log.info('Starting upstream sync check');

  // Step 1: Fetch upstream
  try {
    execFileSync('git', ['fetch', 'upstream', 'main', '--no-tags', '--quiet'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 30_000,
    });
    log.info('Fetched upstream/main');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Non-fatal — upstream remote may not be configured in local dev
    log.warn('Could not fetch upstream (remote may not be configured locally)', { error: msg });
  }

  // Step 2: Run divergence check
  let report: DivergenceResult | null = null;
  try {
    const output = execFileSync('bash', [scriptPath, '--json'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60_000,
    });
    report = JSON.parse(output) as DivergenceResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Divergence check failed', { error: msg });
    return;
  }

  if (report.error) {
    log.error('Divergence check reported error', { error: report.error });
    return;
  }

  // Step 3: Log results
  const { commitsAhead, commitsBehind, summary } = report;

  if (commitsBehind === 0) {
    log.info('Already up to date with upstream — no sync needed');
    return;
  }

  log.info('Upstream divergence detected', {
    commitsBehind,
    commitsAhead,
    frameworkChanges: summary.totalFrameworkChanges,
    instanceChanges: summary.totalInstanceChanges,
    syncSafe: summary.syncSafe,
  });

  if (report.divergentFiles.length > 0) {
    const divergentFramework = report.divergentFiles
      .filter(f => f.classification === 'framework')
      .map(f => f.path);

    if (divergentFramework.length > 0) {
      log.warn('Divergent framework files detected — manual merge required', {
        files: divergentFramework,
      });
    }
  }

  // Step 4: Report — trigger GitHub Actions via repository_dispatch if configured
  // The workflow handles PR creation; we just log here for daemon awareness.
  log.info(
    `Sync needed: ${commitsBehind} commits behind upstream. ` +
    `${summary.syncSafe ? 'Safe to sync.' : 'Manual review required.'} ` +
    `Trigger "upstream-sync" repository_dispatch to create a PR.`
  );

  // Log file-level summary
  if (report.filesBehind.length > 0) {
    const frameworkFiles = report.filesBehind
      .filter(f => f.classification === 'framework')
      .map(f => f.path);
    const instanceFiles = report.filesBehind
      .filter(f => f.classification === 'instance')
      .map(f => f.path);

    if (frameworkFiles.length > 0) {
      log.info('Framework files behind upstream', { files: frameworkFiles });
    }
    if (instanceFiles.length > 0) {
      log.info('Instance files behind upstream (may need manual review)', { files: instanceFiles });
    }
  }
}

/**
 * Register the upstream-sync task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('upstream-sync', async () => {
    await run();
  });
}
