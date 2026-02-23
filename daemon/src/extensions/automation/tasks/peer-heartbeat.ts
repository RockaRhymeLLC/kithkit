/**
 * Peer Heartbeat — sends periodic status messages to all configured peers.
 *
 * Every 5 minutes (configurable), sends a `status` type message to each peer
 * via `sendAgentMessage`. Updates peer state based on responses.
 *
 * Uses message type `status` (not `ping` — valid types are:
 * text, status, coordination, pr-review).
 */

import { createLogger } from '../../../core/logger.js';
import { loadConfig } from '../../../core/config.js';
import { asBmoConfig } from '../../config.js';
import { sendAgentMessage, updatePeerState } from '../../comms/agent-comms.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('peer-heartbeat');

async function run(): Promise<void> {
  const config = asBmoConfig(loadConfig());
  const agentComms = config['agent-comms'];

  if (!agentComms?.enabled) {
    log.debug('Agent comms disabled, skipping heartbeat');
    return;
  }

  const peers = agentComms.peers || [];
  if (peers.length === 0) {
    log.debug('No peers configured, skipping heartbeat');
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const peer of peers) {
    try {
      const result = await sendAgentMessage(peer.name, 'status', undefined, {
        status: 'idle',
      });

      if (result.ok) {
        updatePeerState(peer.name, {
          status: 'idle',
          updatedAt: Date.now(),
        });
        sent++;
        log.debug(`Heartbeat sent to ${peer.name}`, { queued: result.queued });
      } else {
        updatePeerState(peer.name, {
          status: 'unknown',
          updatedAt: Date.now(),
        });
        failed++;
        log.debug(`Heartbeat failed for ${peer.name}`, { error: result.error });
      }
    } catch (err) {
      updatePeerState(peer.name, {
        status: 'unknown',
        updatedAt: Date.now(),
      });
      failed++;
      log.warn(`Heartbeat error for ${peer.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sent > 0 || failed > 0) {
    log.info('Heartbeat cycle complete', { sent, failed, total: peers.length });
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('peer-heartbeat', run);
}
