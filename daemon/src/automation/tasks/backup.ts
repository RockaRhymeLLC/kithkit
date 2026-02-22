/**
 * Backup task — backs up the project directory.
 *
 * Calls scripts/backup.sh which handles:
 * - Zip creation (excluding node_modules, .venv, .git, logs, models, dist)
 * - Integrity verification
 * - Size sanity check
 * - Rotation (keeps last N backups)
 *
 * Results are logged to the daemon log.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getProjectDir } from '../../core/config.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('backup');

async function run(): Promise<void> {
  const scriptPath = path.join(getProjectDir(), 'scripts', 'backup.sh');
  log.info('Starting backup');

  try {
    const output = execFileSync('bash', [scriptPath], {
      encoding: 'utf8',
      timeout: 300_000, // 5 minute timeout for large zips
      cwd: getProjectDir(),
    });

    // Parse output for the summary line
    const sizeLine = output.match(/Backup created: (.+)/);
    if (sizeLine) {
      log.info(`Backup complete: ${sizeLine[1]}`);
    } else {
      log.info('Backup script completed');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Backup failed', { error: msg });
  }
}

/**
 * Register the backup task with the scheduler.
 * Does not require a session (set requires_session: false in config).
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('backup', async () => {
    await run();
  });
}
