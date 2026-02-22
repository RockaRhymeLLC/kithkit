/**
 * Structured JSON logger with file rotation.
 * All daemon modules log through this.
 */

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

let _logDir = '';
let _minLevel: LogLevel = 'info';
let _maxSizeBytes = 10 * 1024 * 1024;
let _maxFiles = 5;
let _initialized = false;

/**
 * Initialize logger with explicit settings.
 */
export function initLogger(opts: {
  logDir: string;
  minLevel?: LogLevel;
  maxSizeMB?: number;
  maxFiles?: number;
}): void {
  _logDir = opts.logDir;
  _minLevel = opts.minLevel ?? 'info';
  _maxSizeBytes = (opts.maxSizeMB ?? 10) * 1024 * 1024;
  _maxFiles = opts.maxFiles ?? 5;

  fs.mkdirSync(_logDir, { recursive: true });
  _initialized = true;
}

function getLogFile(): string {
  return path.join(_logDir, 'daemon.log');
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[_minLevel];
}

/**
 * Rotate logs if current file exceeds size limit.
 */
function rotateIfNeeded(): void {
  const logFile = getLogFile();
  if (!fs.existsSync(logFile)) return;

  const stats = fs.statSync(logFile);
  if (stats.size < _maxSizeBytes) return;

  for (let i = _maxFiles - 1; i >= 1; i--) {
    const src = `${logFile}.${i}`;
    const dst = `${logFile}.${i + 1}`;
    if (fs.existsSync(src)) {
      if (i + 1 >= _maxFiles) {
        fs.unlinkSync(src);
      } else {
        fs.renameSync(src, dst);
      }
    }
  }
  fs.renameSync(logFile, `${logFile}.1`);
}

function writeLog(entry: LogEntry): void {
  if (!_initialized) {
    console.log(`[${entry.level}] ${entry.module}: ${entry.msg}`);
    return;
  }

  rotateIfNeeded();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(getLogFile(), line);

  if (entry.level === 'error') {
    console.error(`[${entry.level}] ${entry.module}: ${entry.msg}`);
  }
}

/** Reset logger internals for testing. */
export function _resetLoggerForTesting(opts: {
  logDir: string;
  minLevel?: LogLevel;
  maxSizeMB?: number;
  maxFiles?: number;
}): void {
  _logDir = opts.logDir;
  _minLevel = opts.minLevel ?? 'info';
  _maxSizeBytes = (opts.maxSizeMB ?? 10) * 1024 * 1024;
  _maxFiles = opts.maxFiles ?? 5;
  _initialized = true;
}

/**
 * Create a scoped logger for a specific module.
 */
export function createLogger(module: string) {
  return {
    debug(msg: string, data?: Record<string, unknown>) {
      if (shouldLog('debug')) writeLog({ ts: new Date().toISOString(), level: 'debug', module, msg, data });
    },
    info(msg: string, data?: Record<string, unknown>) {
      if (shouldLog('info')) writeLog({ ts: new Date().toISOString(), level: 'info', module, msg, data });
    },
    warn(msg: string, data?: Record<string, unknown>) {
      if (shouldLog('warn')) writeLog({ ts: new Date().toISOString(), level: 'warn', module, msg, data });
    },
    error(msg: string, data?: Record<string, unknown>) {
      if (shouldLog('error')) writeLog({ ts: new Date().toISOString(), level: 'error', module, msg, data });
    },
  };
}
