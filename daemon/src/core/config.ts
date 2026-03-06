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

export interface LanConfig {
  enabled: boolean;
  bind_host: string;
  port: number;
}

export interface DaemonConfig {
  port: number;
  bind_host?: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_dir: string;
  log_rotation: { max_size_mb: number; max_files: number };
  lan?: LanConfig;
  db_path?: string;  // Optional override for database file location
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

export interface ToolsConfig {
  tmux_path: string;
  himalaya_path: string;
  ffmpeg_path: string;
  whisper_cli_path: string;
}

export interface TimerConfig {
  nag_interval_ms: number;
  max_nag_duration_ms: number;
  default_snooze_seconds: number;
}

export interface VoiceConfig {
  max_audio_bytes: number;
  max_tts_chars: number;
  response_timeout_ms: number;
  audio_convert_timeout_ms: number;
  transcription_timeout_ms: number;
  client_stale_timeout_ms: number;
  client_prune_interval_ms: number;
}

export interface TaskRunnerConfig {
  default_timeout_ms: number;
  max_buffer_bytes: number;
  max_output_chars: number;
}

export interface WeatherConfig {
  geocoding_api_url: string;
  forecast_api_url: string;
  wttr_base_url: string;
}

export interface EmailConfig {
  fastmail_jmap_session_url: string;
}

export interface KithkitConfig {
  agent: AgentConfig;
  tmux?: TmuxConfig;
  daemon: DaemonConfig;
  scheduler: SchedulerConfig;
  security: SecurityConfig;
  tools?: ToolsConfig;
  timers?: TimerConfig;
  voice?: VoiceConfig;
  task_runner?: TaskRunnerConfig;
  weather?: WeatherConfig;
  email?: EmailConfig;
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
  tools: {
    tmux_path: '/opt/homebrew/bin/tmux',
    himalaya_path: '/opt/homebrew/bin/himalaya',
    ffmpeg_path: '/opt/homebrew/bin/ffmpeg',
    whisper_cli_path: '/opt/homebrew/bin/whisper-cli',
  },
  timers: { nag_interval_ms: 30_000, max_nag_duration_ms: 600_000, default_snooze_seconds: 300 },
  voice: { max_audio_bytes: 10 * 1024 * 1024, max_tts_chars: 500, response_timeout_ms: 30_000, audio_convert_timeout_ms: 15_000, transcription_timeout_ms: 30_000, client_stale_timeout_ms: 60_000, client_prune_interval_ms: 15_000 },
  task_runner: { default_timeout_ms: 300_000, max_buffer_bytes: 1024 * 1024, max_output_chars: 50_000 },
  weather: {
    geocoding_api_url: 'https://geocoding-api.open-meteo.com/v1/search',
    forecast_api_url: 'https://api.open-meteo.com/v1/forecast',
    wttr_base_url: 'https://wttr.in',
  },
  email: {
    fastmail_jmap_session_url: 'https://api.fastmail.com/.well-known/jmap',
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
