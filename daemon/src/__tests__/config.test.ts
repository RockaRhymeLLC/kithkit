/**
 * t-116: Config loads and deep-merges with defaults
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting, ConfigValidationError } from '../core/config.js';

describe('Config (t-116)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-config-'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads hardcoded defaults when no config files exist', () => {
    const config = loadConfig(tmpDir);
    assert.equal(config.agent.name, 'Assistant');
    assert.equal(config.daemon.port, 3847);
    assert.equal(config.daemon.log_level, 'info');
    assert.equal(config.daemon.log_dir, 'logs');
    assert.equal(config.daemon.log_rotation.max_size_mb, 10);
    assert.equal(config.daemon.log_rotation.max_files, 5);
    assert.deepEqual(config.scheduler.tasks, []);
    assert.equal(config.security.rate_limits.incoming_max_per_minute, 5);
  });

  it('loads kithkit.defaults.yaml and merges with hardcoded defaults', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.defaults.yaml'),
      'daemon:\n  port: 4000\n  log_level: debug\n',
    );
    const config = loadConfig(tmpDir);
    assert.equal(config.daemon.port, 4000);
    assert.equal(config.daemon.log_level, 'debug');
    // Other defaults still present
    assert.equal(config.agent.name, 'Assistant');
    assert.equal(config.daemon.log_rotation.max_size_mb, 10);
  });

  it('deep-merges user config with defaults — partial override', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'agent:\n  name: BMO\n',
    );
    const config = loadConfig(tmpDir);
    assert.equal(config.agent.name, 'BMO');
    // Defaults for everything else
    assert.equal(config.daemon.port, 3847);
    assert.equal(config.daemon.log_level, 'info');
  });

  it('user config overrides defaults.yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.defaults.yaml'),
      'daemon:\n  port: 4000\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'daemon:\n  port: 5000\n',
    );
    const config = loadConfig(tmpDir);
    assert.equal(config.daemon.port, 5000);
  });

  it('deep-merges nested objects without clobbering siblings', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'daemon:\n  log_rotation:\n    max_size_mb: 50\n',
    );
    const config = loadConfig(tmpDir);
    assert.equal(config.daemon.log_rotation.max_size_mb, 50);
    // Sibling field preserved from defaults
    assert.equal(config.daemon.log_rotation.max_files, 5);
  });

  it('throws ConfigValidationError for non-integer port', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'daemon:\n  port: abc\n',
    );
    assert.throws(() => loadConfig(tmpDir), (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.match(err.message, /daemon\.port/);
      return true;
    });
  });

  it('throws ConfigValidationError for port out of range', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'daemon:\n  port: 99999\n',
    );
    assert.throws(() => loadConfig(tmpDir), (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.match(err.message, /65535/);
      return true;
    });
  });

  it('throws ConfigValidationError for invalid log level', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'daemon:\n  log_level: verbose\n',
    );
    assert.throws(() => loadConfig(tmpDir), (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.match(err.message, /log_level/);
      return true;
    });
  });

  it('throws ConfigValidationError for empty agent name', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      "agent:\n  name: ''\n",
    );
    assert.throws(() => loadConfig(tmpDir), (err: unknown) => {
      assert.ok(err instanceof ConfigValidationError);
      assert.match(err.message, /agent\.name/);
      return true;
    });
  });

  it('caches config after first load', () => {
    const config1 = loadConfig(tmpDir);
    const config2 = loadConfig(tmpDir);
    assert.equal(config1, config2); // Same reference
  });
});
