/**
 * Supabase Keep-Alive task — prevents free-tier project from pausing.
 *
 * Supabase free tier pauses projects after 7 days of inactivity and
 * deletes them after 90 days paused. This task pings the REST API
 * every 3 days to keep the project active.
 *
 * Uses curl (macOS LAN workaround pattern) to hit the PostgREST
 * health endpoint with the anon key.
 */

import { execFile } from 'node:child_process';
import { readKeychain } from '../../../core/keychain.js';
import { createLogger } from '../../../core/logger.js';
import type { Scheduler } from '../../../automation/scheduler.js';

const log = createLogger('supabase-keep-alive');

function curlRequest(
  url: string,
  headers: Record<string, string>,
): Promise<{ httpStatus: number; body: string; latencyMs: number } | { error: string; latencyMs: number }> {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const args = [
      '-s',
      '-w', '\n%{http_code}',
      '--connect-timeout', '10',
      '--max-time', '30',
    ];

    for (const [key, value] of Object.entries(headers)) {
      args.push('-H', `${key}: ${value}`);
    }

    args.push(url);

    execFile('curl', args, { timeout: 35000 }, (err, stdout, stderr) => {
      const latencyMs = Date.now() - startTime;
      if (err) {
        resolve({ error: stderr?.trim() || err.message || 'connection failed', latencyMs });
        return;
      }
      const lines = stdout.trimEnd().split('\n');
      const httpStatus = parseInt(lines.pop() ?? '', 10) || 0;
      resolve({ httpStatus, body: lines.join('\n'), latencyMs });
    });
  });
}

async function run(): Promise<void> {
  const supabaseUrl = await readKeychain('credential-supabase-playplan-url');
  const anonKey = await readKeychain('credential-supabase-playplan-anon-key');

  if (!supabaseUrl || !anonKey) {
    log.warn('Supabase credentials not found in Keychain, skipping keep-alive');
    return;
  }

  // Query a known table with limit=0 — any authenticated request counts as activity.
  const url = `${supabaseUrl}/rest/v1/families?limit=0`;
  const result = await curlRequest(url, {
    'apikey': anonKey,
    'Authorization': `Bearer ${anonKey}`,
  });

  if ('error' in result) {
    log.error('Supabase keep-alive failed', { error: result.error, latencyMs: result.latencyMs });
    return;
  }

  if (result.httpStatus >= 200 && result.httpStatus < 400) {
    log.info(`Supabase keep-alive OK (HTTP ${result.httpStatus}, ${result.latencyMs}ms)`);
  } else {
    log.error(`Supabase keep-alive failed (HTTP ${result.httpStatus})`, {
      body: result.body.slice(0, 200),
      latencyMs: result.latencyMs,
    });
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('supabase-keep-alive', async () => {
    await run();
  });
}
