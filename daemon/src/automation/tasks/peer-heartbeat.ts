/**
 * Peer Heartbeat — sends periodic status messages to all configured peers.
 *
 * Every 5 minutes (configurable), sends a `status` type message to each peer
 * via `sendAgentMessage`. Updates peer state based on responses.
 *
 * Uses dynamic imports for agent-comms so the task skips gracefully when
 * the agent-comms extension is not loaded.
 *
 * Uses message type `status` (not `ping` — valid types are:
 * text, status, coordination, pr-review).
 */

import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('peer-heartbeat');

interface PeerConfig {
  name: string;
  host: string;
  port: number;
}

interface AgentCommsConfig {
  enabled: boolean;
  peers?: PeerConfig[];
}

async function run(): Promise<void> {
  const config = loadConfig();
  const agentComms = (config as unknown as Record<string, unknown>)['agent-comms'] as AgentCommsConfig | undefined;

  if (!agentComms?.enabled) {
    log.debug('Agent comms disabled, skipping heartbeat');
    return;
  }

  const peers = agentComms.peers || [];
  if (peers.length === 0) {
    log.debug('No peers configured, skipping heartbeat');
    return;
  }

  // Dynamic import — agent-comms module may not exist if the extension isn't installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let comms: any;
  try {
    comms = await import('../../extensions/comms/agent-comms.js');
  } catch {
    log.debug('Agent-comms module not available, skipping heartbeat');
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const peer of peers) {
    try {
      const result = await comms.sendAgentMessage(peer.name, 'status', undefined, {
        status: 'idle',
      });

      if (result.ok) {
        comms.updatePeerState(peer.name, {
          status: 'idle',
          updatedAt: Date.now(),
        });
        sent++;
        log.debug(`Heartbeat sent to ${peer.name}`, { queued: result.queued });
      } else {
        comms.updatePeerState(peer.name, {
          status: 'unknown',
          updatedAt: Date.now(),
        });
        failed++;
        log.debug(`Heartbeat failed for ${peer.name}`, { error: result.error });
      }
    } catch (err) {
      comms.updatePeerState(peer.name, {
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
