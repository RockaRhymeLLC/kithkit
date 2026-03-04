/**
 * Unified A2A messaging types — request/response shapes and error codes.
 */

export interface A2ASendRequest {
  to?: string;       // Peer name or qualified name
  group?: string;    // Group UUID
  payload: {
    type: string;
    text?: string;         // Canonical field for message content
    message?: unknown;     // Accepted alias — normalized to 'text' by router
    [key: string]: unknown;
  };
  route?: 'auto' | 'lan' | 'relay';
}

export interface DeliveryAttempt {
  route: 'lan' | 'relay';
  status: 'success' | 'failed';
  error?: string;
  latencyMs: number;
  relayStatus?: 'delivered' | 'queued';
}

export interface A2ASendResponse {
  ok: true;
  messageId: string;
  target: string;
  targetType: 'dm' | 'group';
  route: 'lan' | 'relay';
  status: 'delivered' | 'queued';
  attempts: DeliveryAttempt[];
  timestamp: string;
}

export interface A2AGroupSendResponse extends A2ASendResponse {
  targetType: 'group';
  delivered: string[];
  queued: string[];
  failed: string[];
}

export interface A2ASendError {
  ok: false;
  error: string;
  code: string;
  attempts?: DeliveryAttempt[];
  timestamp: string;
}

// Error codes
export const A2A_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_TARGET: 'INVALID_TARGET',
  INVALID_ROUTE: 'INVALID_ROUTE',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  RELAY_UNAVAILABLE: 'RELAY_UNAVAILABLE',
  LAN_UNAVAILABLE: 'LAN_UNAVAILABLE',
} as const;
