/**
 * Unified A2A Messaging — type definitions.
 *
 * Defines the request/response shapes for the POST /api/a2a/send endpoint,
 * including delivery attempts, error codes, and result types.
 */

export interface A2ASendRequest {
  to?: string;
  group?: string;
  payload: {
    type: string;
    text?: string;
    [key: string]: unknown;
  };
  route?: 'auto' | 'lan' | 'relay';
}

export interface DeliveryAttempt {
  route: 'lan' | 'relay';
  status: 'success' | 'failed';
  error?: string;
  latencyMs: number;
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

export interface A2ASendError {
  ok: false;
  error: string;
  code: ErrorCode;
  attempts?: DeliveryAttempt[];
  timestamp: string;
}

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_TARGET'
  | 'INVALID_ROUTE'
  | 'PEER_NOT_FOUND'
  | 'GROUP_NOT_FOUND'
  | 'DELIVERY_FAILED'
  | 'RELAY_UNAVAILABLE'
  | 'LAN_UNAVAILABLE';

export type A2ASendResult = A2ASendResponse | A2ASendError;
