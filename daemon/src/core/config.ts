/**
 * Config loader — reads kithkit.config.yaml and provides typed access.
 * Deep-merges user config with shipped defaults.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ── Config types ─────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  identity_file?: string;
}

export interface DaemonConfig {
  port: number;
  bind_host?: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_dir: string;
  log_rotation: { max_size_mb: number; max_files: number };
}

export interface SchedulerConfig {
  tasks: TaskScheduleConfig[];
  /** Additional directories to scan for external task handler files at boot. */
  tasks_dirs?: string[];
}

export interface TaskScheduleConfig {
  name: string;
  enabled: boolean;
  interval?: string;
  cron?: string;
  config?: Record<string, unknown>;
}

export interface SecurityConfig {
  rate_limits: { incoming_max_per_minute: number; outgoing_max_per_minute: number };
}

export interface TmuxConfig {
  session?: string;
}

export interface KithkitConfig {
  agent: AgentConfig;
  tmux?: TmuxConfig;
  daemon: DaemonConfig;
  scheduler: SchedulerConfig;
  security: SecurityConfig;
}

// ── Defaults ─────────────────────────────────────────────────

const DEFAULTS: KithkitConfig = {
  agent: { name: 'Assistant' },
  daemon: {
    port: 3847,
    log_level: 'info',
    log_dir: 'logs',
    log_rotation: { max_size_mb: 10, max_files: 5 },
  },
  scheduler: { tasks: [] },
  security: {
    rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 },
  },
};

// ── Deep merge ───────────────────────────────────────────────

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result;
}

// ── Validation ───────────────────────────────────────────────

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function validate(config: KithkitConfig): void {
  if (typeof config.daemon.port !== 'number' || !Number.isInteger(config.daemon.port)) {
    throw new ConfigValidationError(`Invalid daemon.port: expected integer, got ${JSON.stringify(config.daemon.port)}`);
  }
  if (config.daemon.port < 1 || config.daemon.port > 65535) {
    throw new ConfigValidationError(`Invalid daemon.port: ${config.daemon.port} (must be 1–65535)`);
  }

  const validLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLevels.includes(config.daemon.log_level)) {
    throw new ConfigValidationError(`Invalid daemon.log_level: "${config.daemon.log_level}" (must be one of ${validLevels.join(', ')})`);
  }

  if (typeof config.daemon.log_dir !== 'string' || config.daemon.log_dir.length === 0) {
    throw new ConfigValidationError('Invalid daemon.log_dir: must be a non-empty string');
  }

  if (typeof config.agent.name !== 'string' || config.agent.name.length === 0) {
    throw new ConfigValidationError('Invalid agent.name: must be a non-empty string');
  }
}

// ── Loader ───────────────────────────────────────────────────

let _config: KithkitConfig | null = null;
let _projectDir = '';

/**
 * Parse an interval string like "3m", "15m", "1h", "30s" into milliseconds.
 */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid interval format: "${interval}" (use e.g. "3m", "30s", "1h")`);
  const [, num, unit] = match;
  const value = parseInt(num!, 10);
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

/**
 * Load config from kithkit.config.yaml. Caches after first load.
 * Falls back to kithkit.defaults.yaml, then to hardcoded defaults.
 *
 * @throws ConfigValidationError if config values are invalid
 */
export function loadConfig(projectDir?: string): KithkitConfig {
  if (_config) return _config;

  const dir = projectDir ?? process.cwd();
  _projectDir = dir;

  let userConfig: Partial<KithkitConfig> = {};

  // Try user config first
  const userConfigPath = path.join(dir, 'kithkit.config.yaml');
  if (fs.existsSync(userConfigPath)) {
    const raw = fs.readFileSync(userConfigPath, 'utf8');
    userConfig = (yaml.load(raw) as Partial<KithkitConfig>) ?? {};
  }

  // Try shipped defaults
  let defaults: Record<string, unknown> = DEFAULTS as unknown as Record<string, unknown>;
  const defaultsPath = path.join(dir, 'kithkit.defaults.yaml');
  if (fs.existsSync(defaultsPath)) {
    const raw = fs.readFileSync(defaultsPath, 'utf8');
    const parsed = (yaml.load(raw) as Record<string, unknown>) ?? {};
    defaults = deepMerge(DEFAULTS as unknown as Record<string, unknown>, parsed);
  }

  _config = deepMerge(
    defaults,
    userConfig as Record<string, unknown>,
  ) as unknown as KithkitConfig;

  validate(_config);
  return _config;
}

/**
 * Get the project root directory.
 */
export function getProjectDir(): string {
  return _projectDir;
}

/**
 * Resolve a relative path against the project directory.
 */
export function resolveProjectPath(...segments: string[]): string {
  return path.resolve(_projectDir, ...segments);
}

/** Reset cached config for testing. */
export function _resetConfigForTesting(): void {
  _config = null;
  _projectDir = '';
}
