/**
 * Prerequisites checker — verify Node.js, npm, and Claude Code CLI.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PrereqResult {
  name: string;
  ok: boolean;
  version?: string;
  error?: string;
  instructions?: string;
}

export interface PrereqReport {
  results: PrereqResult[];
  allPassed: boolean;
}

/**
 * Run a command and return stdout trimmed, or null on failure.
 */
async function tryCommand(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Parse a version string like "v22.3.0" or "22.3.0" into major number.
 */
function parseMajor(version: string): number | null {
  const match = version.match(/v?(\d+)/);
  return match ? parseInt(match[1]!, 10) : null;
}

/**
 * Check all prerequisites for kithkit init.
 */
export async function checkPrerequisites(): Promise<PrereqReport> {
  const results: PrereqResult[] = [];

  // Node.js 22+
  const nodeVersion = await tryCommand('node', ['--version']);
  if (nodeVersion) {
    const major = parseMajor(nodeVersion);
    if (major !== null && major >= 22) {
      results.push({ name: 'Node.js', ok: true, version: nodeVersion });
    } else {
      results.push({
        name: 'Node.js',
        ok: false,
        version: nodeVersion,
        error: `Node.js 22+ required, found ${nodeVersion}`,
        instructions: 'Install Node.js 22+: https://nodejs.org/',
      });
    }
  } else {
    results.push({
      name: 'Node.js',
      ok: false,
      error: 'Node.js not found',
      instructions: 'Install Node.js 22+: https://nodejs.org/',
    });
  }

  // npm
  const npmVersion = await tryCommand('npm', ['--version']);
  if (npmVersion) {
    results.push({ name: 'npm', ok: true, version: npmVersion });
  } else {
    results.push({
      name: 'npm',
      ok: false,
      error: 'npm not found',
      instructions: 'npm is included with Node.js — reinstall Node.js',
    });
  }

  // Claude Code CLI
  const claudeVersion = await tryCommand('claude', ['--version']);
  if (claudeVersion) {
    results.push({ name: 'Claude Code', ok: true, version: claudeVersion });
  } else {
    results.push({
      name: 'Claude Code',
      ok: false,
      error: 'Claude Code CLI not found',
      instructions: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    });
  }

  return {
    results,
    allPassed: results.every(r => r.ok),
  };
}

/**
 * Format prerequisite results for terminal output.
 */
export function formatPrereqReport(report: PrereqReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    if (r.ok) {
      lines.push(`  [ok] ${r.name} ${r.version ?? ''}`);
    } else {
      lines.push(`  [!!] ${r.name}: ${r.error}`);
      if (r.instructions) {
        lines.push(`       ${r.instructions}`);
      }
    }
  }
  return lines.join('\n');
}
