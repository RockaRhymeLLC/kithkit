/**
 * Agent Extended Status — rich operational data for the /agent/status endpoint.
 *
 * Gathers agent-specific status beyond what the kithkit framework provides:
 * - Todo counts from filesystem
 * - Git status (branch, dirty, ahead of origin)
 * - Context usage from context-usage.json
 * - Service statuses (Telegram, email, voice, agent-comms)
 * - Memory stats (local count, peer sync state)
 * - Recent commits
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectDir } from '../core/config.js';
import { sessionExists } from '../core/session-bridge.js';
import { createLogger } from '../core/logger.js';
import type { AgentConfig } from './config.js';

const execFileAsync = promisify(execFile);
const log = createLogger('agent-extended-status');

// ── Types ───────────────────────────────────────────────────

export interface TodoCounts {
  open: number;
  inProgress: number;
  blocked: number;
}

export interface GitStatus {
  branch: string;
  aheadOfOrigin: number;
  dirty: boolean;
}

export interface ContextUsage {
  usedPercent: number;
  remainingPercent: number;
}

export interface ServiceStatus {
  name: string;
  status: 'ok' | 'degraded' | 'down';
  detail?: string;
}

export interface MemoryStats {
  totalLocal: number;
  peerCount: number;
}

export interface CommitInfo {
  hash: string;
  message: string;
  time: string;
}

export interface AgentExtendedStatus {
  agent: string;
  session: 'active' | 'stopped';
  channel: string;
  todos: TodoCounts;
  services: ServiceStatus[];
  git?: GitStatus;
  context?: ContextUsage;
  memory?: MemoryStats;
  commits?: CommitInfo[];
}

// ── Data Gatherers ──────────────────────────────────────────

export function getTodoCounts(): TodoCounts {
  const todosDir = path.join(getProjectDir(), '.claude', 'state', 'todos');
  const counts: TodoCounts = { open: 0, inProgress: 0, blocked: 0 };

  try {
    const files = fs.readdirSync(todosDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    for (const file of files) {
      if (file.includes('-completed-')) continue;
      if (file.includes('-open-')) counts.open++;
      else if (file.includes('-in-progress-')) counts.inProgress++;
      else if (file.includes('-blocked-')) counts.blocked++;
    }
  } catch {
    // Todos dir might not exist
  }

  return counts;
}

export async function getRecentCommits(limit = 3): Promise<CommitInfo[]> {
  try {
    const { stdout } = await execFileAsync('git', [
      'log', `--max-count=${limit}`, '--format=%h|%s|%aI',
    ], { cwd: getProjectDir(), encoding: 'utf8', timeout: 5000 });

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, time] = line.split('|');
      return { hash: hash!, message: message!, time: time! };
    });
  } catch {
    return [];
  }
}

export async function getGitStatus(): Promise<GitStatus | undefined> {
  const cwd = getProjectDir();
  try {
    const [branchResult, aheadResult, statusResult] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000 }),
      execFileAsync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd, encoding: 'utf8', timeout: 3000 }).catch(() => ({ stdout: '0' })),
      execFileAsync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 3000 }),
    ]);

    return {
      branch: branchResult.stdout.trim(),
      aheadOfOrigin: parseInt(aheadResult.stdout.trim(), 10) || 0,
      dirty: statusResult.stdout.trim().length > 0,
    };
  } catch {
    return undefined;
  }
}

export function getContextUsage(): ContextUsage | undefined {
  try {
    const filePath = path.join(getProjectDir(), '.claude', 'state', 'context-usage.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Only report if data is recent (within 5 minutes)
    const age = (Date.now() / 1000) - (data.timestamp || 0);
    if (age > 300) return undefined;
    return {
      usedPercent: data.used_percentage ?? 0,
      remainingPercent: data.remaining_percentage ?? 100,
    };
  } catch {
    return undefined;
  }
}

export function getMemoryStats(): MemoryStats | undefined {
  const memoriesDir = path.join(getProjectDir(), '.claude', 'state', 'memory', 'memories');
  const syncStatePath = path.join(getProjectDir(), '.claude', 'state', 'memory', 'sync-state.json');

  try {
    const files = fs.readdirSync(memoriesDir).filter(f => f.endsWith('.md'));
    let peerCount = 0;
    try {
      const peers = JSON.parse(fs.readFileSync(syncStatePath, 'utf-8'));
      peerCount = Object.keys(peers).length;
    } catch { /* no sync state */ }

    return { totalLocal: files.length, peerCount };
  } catch {
    return undefined;
  }
}

export function getServiceStatuses(config: AgentConfig): ServiceStatus[] {
  const services: ServiceStatus[] = [];

  services.push({
    name: 'telegram',
    status: config.channels?.telegram?.enabled ? 'ok' : 'down',
    detail: config.channels?.telegram?.enabled ? 'enabled' : 'disabled',
  });

  services.push({
    name: 'email',
    status: config.channels?.email?.enabled ? 'ok' : 'down',
    detail: config.channels?.email?.enabled
      ? `${config.channels.email.providers?.length ?? 0} provider(s)`
      : 'disabled',
  });

  services.push({
    name: 'voice',
    status: config.channels?.voice?.enabled ? 'ok' : 'down',
    detail: config.channels?.voice?.enabled ? 'enabled' : 'disabled',
  });

  services.push({
    name: 'agent-comms',
    status: config['agent-comms']?.enabled ? 'ok' : 'down',
    detail: config['agent-comms']?.enabled
      ? `${config['agent-comms'].peers?.length ?? 0} peer(s)`
      : 'disabled',
  });

  return services;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Gather agent extended status for the /agent/status endpoint.
 */
export async function getAgentExtendedStatus(config: AgentConfig): Promise<AgentExtendedStatus> {
  // Read current channel
  let channel = 'unknown';
  try {
    channel = fs.readFileSync(path.join(getProjectDir(), '.claude', 'state', 'channel.txt'), 'utf8').trim();
  } catch { /* default */ }

  const [git, commits] = await Promise.all([
    getGitStatus(),
    getRecentCommits(),
  ]);

  return {
    agent: config.agent?.name ?? 'Agent',
    session: sessionExists() ? 'active' : 'stopped',
    channel,
    todos: getTodoCounts(),
    services: getServiceStatuses(config),
    ...(git && { git }),
    context: getContextUsage(),
    memory: getMemoryStats(),
    ...(commits.length > 0 && { commits }),
  };
}
