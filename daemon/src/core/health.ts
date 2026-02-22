/**
 * Health check endpoint logic.
 * Returns daemon status, uptime, version, and timestamp.
 */

export interface HealthResponse {
  status: 'ok';
  uptime: number;
  version: string;
  timestamp: string;
}

const startTime = Date.now();

/**
 * Build a health check response.
 */
export function getHealth(version: string): HealthResponse {
  return {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version,
    timestamp: new Date().toISOString(),
  };
}
