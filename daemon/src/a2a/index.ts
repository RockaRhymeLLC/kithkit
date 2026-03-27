/**
 * Unified A2A messaging — re-exports for router, handler, and types.
 */

export { UnifiedA2ARouter } from './router.js';
export type { RouterDeps, PeerConfig, AgentMessage } from './router.js';
export type {
  A2ASendRequest,
  A2ASendResponse,
  A2AGroupSendResponse,
  A2ASendError,
  DeliveryAttempt,
} from './types.js';
export { A2A_ERROR_CODES } from './types.js';
export { handleA2ARoute, setA2ARouter } from './handler.js';
