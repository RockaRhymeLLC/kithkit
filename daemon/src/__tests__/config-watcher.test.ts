/**
 * t-162: Config hot-reload via file watching
 * t-163: Invalid config change doesn't crash daemon
 * t-370: reload() must preserve defaults-only keys (fix for #370/#749)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { createConfigWatcher, type ConfigWatcher, type ReloadResult } from '../core/config-watcher.js';
import type { KithkitConfig } from '../core/config.js';

function makeConfig(overrides: Partial<KithkitConfig> = {}): KithkitConfig {
  return {
    agent: { name: 'TestAgent', ...overrides.agent },
    daemon: {
      port: 3847,
      log_level: 'info',
      log_dir: 'logs',
      log_rotation: { max_size_mb: 10, max_files: 5 },
      ...overrides.daemon,
    },
    scheduler: { tasks: [], ...overrides.scheduler },
    security: {
      rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 },
      ...overrides.security,
    },
  };
}

describe('Config hot-reload via file watching (t-162)', () => {
  let tmpDir: string;
  let configPath: string;
  let watcher: ConfigWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-watcher-'));
    configPath = path.join(tmpDir, 'kithkit.config.yaml');
    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'Initial' }, daemon: { port: 3847 } }));
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reload() loads updated config from disk', async () => {
    const initial = makeConfig({ agent: { name: 'Initial' } });
    watcher = createConfigWatcher(configPath, initial);

    // Write new config
    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'Updated' }, daemon: { port: 4000 } }));

    const result = await watcher.reload();
    assert.equal(result.success, true);
  });

  it('onChange callback fires on reload', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    let callbackFired = false;
    let receivedConfig: KithkitConfig | null = null;

    watcher.onChange((config) => {
      callbackFired = true;
      receivedConfig = config;
    });

    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'CallbackTest' }, daemon: { port: 3847 } }));
    await watcher.reload();

    assert.ok(callbackFired, 'Callback should fire');
    assert.ok(receivedConfig);
    assert.equal((receivedConfig as KithkitConfig).agent.name, 'CallbackTest');
  });

  it('start() begins watching', () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);
    watcher.start();
    assert.ok(watcher.isWatching());
  });

  it('stop() stops watching', () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);
    watcher.start();
    assert.ok(watcher.isWatching());
    watcher.stop();
    assert.ok(!watcher.isWatching());
  });

  it('POST /config/reload returns 200 on success', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    const result = await watcher.reload();
    assert.equal(result.success, true);
    assert.equal(result.error, undefined);
  });

  it('multiple onChange callbacks all fire', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    let count = 0;
    watcher.onChange(() => { count++; });
    watcher.onChange(() => { count++; });

    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'Multi' }, daemon: { port: 3847 } }));
    await watcher.reload();

    assert.equal(count, 2, 'Both callbacks should fire');
  });

  it('async onChange callback is awaited before reload() resolves', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    const order: string[] = [];
    watcher.onChange(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      order.push('callback');
    });

    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'AsyncTest' }, daemon: { port: 3847 } }));
    await watcher.reload();
    order.push('after-reload');

    assert.deepEqual(order, ['callback', 'after-reload'], 'Async callback must complete before reload() resolves');
  });
});

describe('Invalid config change does not crash daemon (t-163)', () => {
  let tmpDir: string;
  let configPath: string;
  let watcher: ConfigWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-watcher-'));
    configPath = path.join(tmpDir, 'kithkit.config.yaml');
    fs.writeFileSync(configPath, yaml.dump({ agent: { name: 'Valid' }, daemon: { port: 3847 } }));
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invalid YAML keeps previous config', async () => {
    const initial = makeConfig({ agent: { name: 'Good' } });
    watcher = createConfigWatcher(configPath, initial);

    // Write invalid YAML
    fs.writeFileSync(configPath, ': : : not valid yaml {{{{');

    const result = await watcher.reload();
    assert.equal(result.success, false);
    assert.ok(result.error, 'Should have error message');
  });

  it('invalid config values keep previous config', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    // Write config with invalid port
    fs.writeFileSync(configPath, yaml.dump({
      agent: { name: 'Test' },
      daemon: { port: 999999 },
    }));

    const result = await watcher.reload();
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('port'), 'Error should mention port');
  });

  it('empty config file keeps previous config', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    fs.writeFileSync(configPath, '');

    const result = await watcher.reload();
    assert.equal(result.success, false);
    assert.ok(result.error);
  });

  it('missing config file returns error', async () => {
    const initial = makeConfig();
    const missingPath = path.join(tmpDir, 'nonexistent.yaml');
    watcher = createConfigWatcher(missingPath, initial);

    const result = await watcher.reload();
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('not found'));
  });

  it('callback error does not crash watcher', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    // Register a callback that throws
    watcher.onChange(() => {
      throw new Error('Callback explosion');
    });

    // Reload should still succeed (callback error caught)
    const result = await watcher.reload();
    assert.equal(result.success, true);
  });

  it('async callback rejection does not crash watcher', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    // Register an async callback that rejects
    watcher.onChange(async () => {
      throw new Error('Async callback explosion');
    });

    // Reload should still succeed (async callback error caught)
    const result = await watcher.reload();
    assert.equal(result.success, true);
  });
});

describe('reload() preserves defaults-only keys — regression #370/#749 (t-370)', () => {
  // Mutation-kill test: if the defaults deep-merge is removed from the reload path,
  // this test goes RED because tools.tmux_path (a DEFAULTS-only key) will be undefined
  // in the config delivered to the onChange callback.

  let tmpDir: string;
  let configPath: string;
  let watcher: ConfigWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-watcher-370-'));
    configPath = path.join(tmpDir, 'kithkit.config.yaml');
    // Minimal config — intentionally omits the entire `tools` section
    // (and other sections that live only in DEFAULTS).
    fs.writeFileSync(
      configPath,
      yaml.dump({
        agent: { name: 'ReloadTest' },
        daemon: { port: 3847, log_level: 'info', log_dir: 'logs', log_rotation: { max_size_mb: 10, max_files: 5 } },
        scheduler: { tasks: [] },
        security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
      }),
    );
  });

  afterEach(() => {
    watcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reloaded config carries tools.tmux_path default even when tools is absent from config file', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    let receivedConfig: KithkitConfig | null = null;
    watcher.onChange((cfg) => { receivedConfig = cfg; });

    const result = await watcher.reload();

    assert.equal(result.success, true, 'reload() must succeed');
    assert.ok(receivedConfig, 'onChange callback must fire');
    // tools.tmux_path comes exclusively from DEFAULTS — it is not written to the
    // config file above.  Without the deep-merge fix this is undefined (RED).
    assert.equal(
      (receivedConfig as KithkitConfig).tools?.tmux_path,
      '/opt/homebrew/bin/tmux',
      'defaults-only key tools.tmux_path must survive hot-reload (regression #370/#749)',
    );
  });

  it('reloaded config carries voice.max_tts_chars default even when voice is absent from config file', async () => {
    const initial = makeConfig();
    watcher = createConfigWatcher(configPath, initial);

    let receivedConfig: KithkitConfig | null = null;
    watcher.onChange((cfg) => { receivedConfig = cfg; });

    const result = await watcher.reload();

    assert.equal(result.success, true);
    assert.ok(receivedConfig);
    // voice block is also DEFAULTS-only — a second independent mutation kill.
    assert.equal(
      (receivedConfig as KithkitConfig).voice?.max_tts_chars,
      500,
      'defaults-only key voice.max_tts_chars must survive hot-reload',
    );
  });
});
