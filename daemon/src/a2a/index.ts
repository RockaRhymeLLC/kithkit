/**
 * Unified A2A Messaging — public API.
 */

export { UnifiedA2ARouter } from './router.js';
export type { RouterDeps } from './router.js';
export type {
  A2ASendRequest,
  A2ASendResponse,
  A2ASendError,
  A2ASendResult,
  DeliveryAttempt,
  ErrorCode,
} from './types.js';
export { handleA2ARoute, setA2ARouter, ERROR_CODE_TO_HTTP } from './handler.js';
