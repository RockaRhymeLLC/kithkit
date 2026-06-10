/**
 * t-E-sendA2A-timeout: Mutation-killing test for Batch E sendA2A timeout behavior.
 *
 * E behavior: the internal sendA2A function passes `signal: AbortSignal.timeout(10000)`
 * to fetch so that unreachable peers do not block the sync loop indefinitely.
 *
 * Strategy: call syncToPeers with the _sendA2AFn override set to null so the real
 * sendA2A path executes. Mock global.fetch to capture the RequestInit options.
 * Assert that init.signal is an AbortSignal.
 *
 * RED when reverted: removing `signal: AbortSignal.timeout(10000)` from the fetch
 * call leaves init.signal === undefined, failing the instanceof assertion.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting } from '../../core/db.js';
import { syncToPeers, _setSendA2AFnForTesting } from '../memory-sync.js';

let tmpDir: string;

function setupWithPeer(peers: string[] = ['bmo']): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-sendA2A-timeout-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

  const peersYaml = peers.map((p) => `    - ${p}`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'agent:',
      '  name: skippy',
      'daemon:',
      '  port: 3847',
      'self_improvement:',
      '  enabled: true',
      '  memory_sync:',
      '    enabled: true',
      '    peers:',
      peersYaml,
    ].join('\n') + '\n',
  );
  loadConfig(tmpDir);
}

function makeShareableMemory(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    content: 'Always use AbortSignal for fetch timeouts',
    category: 'behavioral',
    tags: '[]',
    origin_agent: 'skippy',
    trigger: 'retro',
    decay_policy: 'default',
    shareable: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('sendA2A timeout — AbortSignal.timeout(10000) passed to fetch (t-E-sendA2A-timeout)', { concurrency: 1 }, () => {
  beforeEach(() => {
    _resetConfigForTesting();
    setupWithPeer(['bmo']);
    // Ensure the real sendA2A path runs (not the test injection).
    _setSendA2AFnForTesting(null);
  });

  afterEach(() => {
    _setSendA2AFnForTesting(null);
    _resetConfigForTesting();
    _resetDbForTesting();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes AbortSignal to fetch (E behavior: AbortSignal.timeout(10000))', async () => {
    let capturedSignal: AbortSignal | undefined;
    const originalFetch = global.fetch;

    // Replace global.fetch to capture the RequestInit before any network call.
    // Returns a successful response so syncToPeers does not throw.
    (global as Record<string, unknown>).fetch = async (
      _url: string,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      await syncToPeers(makeShareableMemory());
    } finally {
      (global as Record<string, unknown>).fetch = originalFetch;
    }

    // MUTATION KILL: removing `signal: AbortSignal.timeout(10000)` from
    // sendA2A leaves capturedSignal === undefined → assertion fails.
    assert.ok(
      capturedSignal instanceof AbortSignal,
      'sendA2A must pass an AbortSignal to fetch — ' +
      'if undefined, E timeout behavior was reverted',
    );

    // The timeout signal should not have fired yet (10 seconds have not elapsed).
    assert.ok(
      !capturedSignal.aborted,
      'AbortSignal should not be pre-aborted (10s timeout has not elapsed)',
    );
  });

  it('does not pass signal when _sendA2AFnForTesting override is active (sanity check)', async () => {
    // When the test override is active, real sendA2A (and its signal) is bypassed.
    // This confirms the override path behaves correctly.
    const bodies: unknown[] = [];
    _setSendA2AFnForTesting(async (body) => { bodies.push(body); });

    await syncToPeers(makeShareableMemory());

    assert.equal(bodies.length, 1, 'override should receive exactly one call');
    assert.ok(
      (bodies[0] as Record<string, unknown>).to === 'bmo',
      'override should receive the sync body',
    );
  });
});
