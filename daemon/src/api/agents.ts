/**
 * Agents API — HTTP endpoints for agent lifecycle management.
 *
 * POST /api/agents/spawn   — Spawn a worker with a profile and prompt
 * GET  /api/agents         — List all agents
 * GET  /api/agents/:id/status — Get detailed job/agent status
 * DELETE /api/agents/:id   — Kill a running worker
 */

import type http from 'node:http';
import {
  spawnWorkerJob,
  getJobStatus,
  getAgentStatus,
  listAgents,
  killJob,
} from '../agents/lifecycle.js';
import { loadProfiles } from '../agents/profiles.js';

// ── Helpers ──────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function withTimestamp<T extends object>(obj: T): T & { timestamp: string } {
  return { ...obj, timestamp: new Date().toISOString() };
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Configuration ────────────────────────────────────────────

let profilesDir: string = '';

export function setProfilesDir(dir: string): void {
  profilesDir = dir;
}

// ── Route handler ────────────────────────────────────────────

export async function handleAgentsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  try {
    // POST /api/agents/spawn
    if (pathname === '/api/agents/spawn' && method === 'POST') {
      const body = await parseBody(req);

      // Validate required fields
      if (!body.prompt || typeof body.prompt !== 'string') {
        json(res, 400, withTimestamp({ error: 'prompt is required' }));
        return true;
      }
      if (!body.profile || typeof body.profile !== 'string') {
        json(res, 400, withTimestamp({ error: 'profile is required' }));
        return true;
      }

      // Load and find profile
      const profiles = loadProfiles(profilesDir);
      const profile = profiles.get(body.profile as string);
      if (!profile) {
        json(res, 400, withTimestamp({ error: `Profile ${body.profile} not found` }));
        return true;
      }

      const result = spawnWorkerJob({
        profile,
        prompt: body.prompt as string,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        maxBudgetUsd: typeof body.maxBudgetUsd === 'number' ? body.maxBudgetUsd : undefined,
      });

      json(res, 202, withTimestamp({ jobId: result.jobId, status: result.status }));
      return true;
    }

    // GET /api/agents
    if (pathname === '/api/agents' && method === 'GET') {
      const agents = listAgents();
      json(res, 200, withTimestamp({ data: agents }));
      return true;
    }

    // Routes with agent ID: /api/agents/:id/...
    const agentsPrefix = '/api/agents/';
    if (pathname.startsWith(agentsPrefix) && pathname !== '/api/agents/spawn') {
      const rest = pathname.slice(agentsPrefix.length);
      const slashIdx = rest.indexOf('/');
      const agentId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const suffix = slashIdx === -1 ? '' : rest.slice(slashIdx);

      if (!agentId) return false;

      // GET /api/agents/:id/status
      if (suffix === '/status' && method === 'GET') {
        const job = getJobStatus(agentId);
        if (job) {
          json(res, 200, withTimestamp(job));
          return true;
        }

        const agent = getAgentStatus(agentId);
        if (agent) {
          json(res, 200, withTimestamp(agent));
          return true;
        }

        json(res, 404, withTimestamp({ error: 'Not found' }));
        return true;
      }

      // GET /api/agents/:id
      if (suffix === '' && method === 'GET') {
        const agent = getAgentStatus(agentId);
        if (!agent) {
          json(res, 404, withTimestamp({ error: 'Not found' }));
          return true;
        }
        json(res, 200, withTimestamp(agent));
        return true;
      }

      // DELETE /api/agents/:id
      if (suffix === '' && method === 'DELETE') {
        const killed = killJob(agentId);
        if (!killed) {
          json(res, 404, withTimestamp({ error: 'Not found or not running' }));
          return true;
        }
        json(res, 200, withTimestamp({ status: 'killed' }));
        return true;
      }
    }

    return false;
  } catch (err) {
    if (err instanceof Error && err.message === 'Invalid JSON') {
      json(res, 400, withTimestamp({ error: 'Invalid JSON' }));
      return true;
    }
    throw err;
  }
}
