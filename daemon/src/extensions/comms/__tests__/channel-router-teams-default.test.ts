/**
 * Mutation-killing tests for the teams case + default arm in routeOutgoingMessage().
 *
 * Bug: 'teams' was a valid AgentChannel and TEXT_CHANNEL but had no case in
 * routeOutgoingMessage()'s switch — messages silently fell through with zero log.
 * Similarly, there was no default arm, so any unrecognized channel value was
 * silently dropped.
 *
 * Fix: added case 'teams' and default: arms. These tests MUST fail if either arm
 * is removed (mutation kill verified).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase, _resetDbForTesting } from '../../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';
import { _resetLoggerForTesting } from '../../../core/logger.js';
import { _resetForTesting as _resetKithkitRouter } from '../../../comms/channel-router.js';
import { registerAdapter } from '../../../comms/channel-router.js';
import {
  routeOutgoingMessage,
  setChannel,
  _resetForTesting as _resetChannelRouter,
  _setChannelOverrideForTesting,
} from '../channel-router.js';
import type { AgentChannel } from '../channel-router.js';
import type { ChannelAdapter, OutboundMessage, InboundMessage, Verbosity, ChannelCapabilities } from '../../../comms/adapter.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let _logDir: string;

function setupProject(): void {
  _resetDbForTesting();
  _resetConfigForTesting();
  _resetChannelRouter();
  _resetKithkitRouter();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-teams-default-'));
  _logDir = path.join(tmpDir, 'logs');
  fs.mkdirSync(path.join(tmpDir, '.kithkit', 'state'), { recursive: true });
  fs.mkdirSync(_logDir, { recursive: true });
  _resetLoggerForTesting({ logDir: _logDir, minLevel: 'debug' });
  loadConfig(tmpDir);
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function readLogFile(): string {
  const logPath = path.join(_logDir, 'daemon.log');
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
}

/** Minimal stub adapter that records calls to send(). */
function makeStubAdapter(name: string): ChannelAdapter & { calls: OutboundMessage[] } {
  const calls: OutboundMessage[] = [];
  return {
    name,
    calls,
    async send(msg: OutboundMessage): Promise<boolean> {
      calls.push(msg);
      return true;
    },
    async receive(): Promise<InboundMessage[]> {
      return [];
    },
    formatMessage(text: string, _v: Verbosity): string {
      return text;
    },
    capabilities(): ChannelCapabilities {
      return { markdown: false, images: false, buttons: false, html: false, maxLength: 4096 };
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('routeOutgoingMessage — teams case (fix #549)', () => {
  beforeEach(setupProject);

  it('routes to teams adapter when channel=teams and adapter is registered', async () => {
    const adapter = makeStubAdapter('teams');
    registerAdapter(adapter);
    setChannel('teams');

    routeOutgoingMessage('hello teams');

    // Give the async dispatch one tick to settle
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(adapter.calls.length, 1, 'teams adapter must have been called once');
    assert.equal(adapter.calls[0].text, 'hello teams');
  });

  it('warns when channel=teams but no adapter is registered', async () => {
    // No adapter registered for 'teams'
    setChannel('teams');

    routeOutgoingMessage('dropped message');
    await new Promise(resolve => setImmediate(resolve));

    const log = readLogFile();
    assert.ok(
      log.includes('Teams message dropped: no adapter registered'),
      `Expected "Teams message dropped: no adapter registered" in log. Got: ${log.slice(0, 500)}`,
    );
  });
});

describe('routeOutgoingMessage — default arm (fix #549)', () => {
  beforeEach(setupProject);

  it('logs "Unknown channel, message dropped" for an unrecognised channel', async () => {
    // _setChannelOverrideForTesting bypasses getChannel()'s whitelist so the
    // default: arm is reachable. This is the only runtime path to exercise it,
    // since getChannel() sanitises unknown values to 'terminal' in production.
    _setChannelOverrideForTesting('bogus-channel' as unknown as AgentChannel);

    routeOutgoingMessage('should not deliver');
    await new Promise(resolve => setImmediate(resolve));

    const log = readLogFile();
    assert.ok(
      log.includes('Unknown channel, message dropped'),
      `Expected "Unknown channel, message dropped" in log. Got: ${log.slice(0, 500)}`,
    );
  });
});
