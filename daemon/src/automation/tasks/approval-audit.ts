/**
 * Approval Audit — periodic review of 3rd-party sender approvals.
 *
 * Reviews access control state and notifies the primary user with
 * a summary of safe senders and blocked senders for review.
 *
 * Uses the access-control engine's API rather than reading state files directly.
 */

import { getSafeSenders, getBlockedSenders } from '../../core/access-control.js';
import { injectText } from '../../core/session-bridge.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('approval-audit');

async function run(): Promise<void> {
  const safeSenders = getSafeSenders();
  const blockedSenders = getBlockedSenders();

  if (safeSenders.length === 0 && blockedSenders.length === 0) {
    log.debug('No senders to audit');
    return;
  }

  // Build summary
  const lines: string[] = ['[System] Access Control Audit Summary:'];

  if (safeSenders.length > 0) {
    lines.push(`\nSafe senders (${safeSenders.length}):`);
    for (const s of safeSenders) {
      lines.push(`  - ${s}`);
    }
  }

  if (blockedSenders.length > 0) {
    lines.push(`\nBlocked senders (${blockedSenders.length}):`);
    for (const b of blockedSenders) {
      lines.push(`  - ${b}`);
    }
  }

  lines.push('\nPlease review and let me know if any changes are needed.');

  const summary = lines.join('\n');
  injectText(summary);

  log.info(`Audit complete: ${safeSenders.length} safe, ${blockedSenders.length} blocked`);
}

/**
 * Register the approval-audit task with the scheduler.
 * Task config should include `requires_session: true` in kithkit.config.yaml.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('approval-audit', async () => {
    await run();
  });
}
