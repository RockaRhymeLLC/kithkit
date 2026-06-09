/**
 * Config hot-reload — watch kithkit.config.yaml for changes and apply live.
 *
 * Uses fs.watch() to detect file changes. Debounces rapid changes.
 * On valid config: applies new config and notifies subscribers.
 * On invalid config: logs error, keeps previous config running.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { KithkitConfig } from './config.js';
import { ConfigValidationError, mergeWithDefaults } from './config.js';

// ── Types ───────────────────────────────────────────────────

export type ConfigChangeCallback = (config: KithkitConfig) => Promise<void> | void;

export interface ConfigWatcher {
  /** Start watching for config changes. */
  start(): void;
  /** Stop watching. */
  stop(): void;
  /** Force an immediate reload (used by POST /config/reload). Awaits all onChange callbacks. */
  reload(): Promise<ReloadResult>;
  /** Register a callback for config changes. */
  onChange(callback: ConfigChangeCallback): void;
  /** Check if watcher is active. */
  isWatching(): boolean;
}

export interface ReloadResult {
  success: boolean;
  error?: string;
}

// ── ConfigWatcher ───────────────────────────────────────────

const DEBOUNCE_MS = 300;

export function createConfigWatcher(
  configPath: string,
  currentConfig: KithkitConfig,
  logger?: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void },
): ConfigWatcher {
  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let _config = currentConfig;
  const callbacks: ConfigChangeCallback[] = [];
  let _watching = false;

  const log = logger ?? {
    info: () => {},
    error: () => {},
  };

  async function loadAndApply(): Promise<ReloadResult> {
    try {
      if (!fs.existsSync(configPath)) {
        return { success: false, error: 'Config file not found' };
      }

      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);

      if (!parsed || typeof parsed !== 'object') {
        return { success: false, error: 'Config file is empty or invalid YAML' };
      }

      const newConfig = mergeWithDefaults(parsed as Record<string, unknown>, path.dirname(configPath));
      _config = newConfig;

      for (const cb of callbacks) {
        try {
          await Promise.resolve(cb(newConfig));
        } catch (err) {
          log.error('Config change callback error', { error: String(err) });
        }
      }

      log.info('Config reloaded successfully');
      return { success: true };
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        log.error('Config validation error, keeping previous config', { error: err.message });
        return { success: false, error: err.message };
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Config reload error, keeping previous config', { error: msg });
      return { success: false, error: msg };
    }
  }

  return {
    start() {
      if (_watching) return;

      const dir = path.dirname(configPath);
      const filename = path.basename(configPath);

      try {
        watcher = fs.watch(dir, (event, changedFile) => {
          if (changedFile !== filename) return;

          // Debounce rapid changes (editors often write multiple events)
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            log.info('Config file changed, reloading');
            loadAndApply();
          }, DEBOUNCE_MS);
        });

        _watching = true;
        log.info('Config watcher started', { path: configPath });
      } catch (err) {
        log.error('Failed to start config watcher', { error: String(err) });
      }
    },

    stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      _watching = false;
    },

    async reload(): Promise<ReloadResult> {
      return loadAndApply();
    },

    onChange(callback: ConfigChangeCallback) {
      callbacks.push(callback);
    },

    isWatching() {
      return _watching;
    },
  };
}
