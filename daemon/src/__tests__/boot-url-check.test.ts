/**
 * boot-url-check: boot-time relay/community URL DNS validation.
 *
 * Mutation-kill strategy:
 *   (a) unresolvable URL  → warn fired AND /health surfaces it in unresolvable_urls.
 *       Mutations killed: removing the push(), omitting the logWarn call.
 *   (b) resolvable URL + bare-IP URL → clean (no warn, unresolvable_urls empty).
 *       Mutations killed: removing bare-IP skip (IP gets passed to mock that throws →
 *       unresolvableUrls becomes non-empty → assertion fails).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runBootUrlCheck,
  getBootUrlCheckState,
  extractHostname,
  _setDepsForTesting,
  _resetStateForTesting,
} from '../core/boot-url-check.js';
import type { KithkitConfig } from '../core/config.js';

// ── Helpers ───────────────────────────────────────────────────

/** Build a minimal KithkitConfig with an optional network override. */
function makeConfig(network?: Record<string, unknown>): KithkitConfig {
  const base: KithkitConfig = {
    agent: { name: 'test-agent' },
    daemon: {
      port: 3847,
      log_level: 'info',
      log_dir: 'logs',
      log_rotation: { max_size_mb: 10, max_files: 5 },
    },
    scheduler: { tasks: [] },
    security: { rate_limits: { incoming_max_per_minute: 5, outgoing_max_per_minute: 10 } },
  };
  if (network !== undefined) {
    (base as unknown as Record<string, unknown>)['network'] = network;
  }
  return base;
}

// ── Test setup ────────────────────────────────────────────────

describe('boot-url-check', () => {
  beforeEach(() => {
    _resetStateForTesting();
  });

  afterEach(() => {
    _resetStateForTesting();
    _setDepsForTesting(null); // restore real deps
  });

  // ── extractHostname unit tests ─────────────────────────────

  describe('extractHostname', () => {
    it('extracts hostname from ws:// URL', () => {
      assert.equal(extractHostname('ws://relay.example.com'), 'relay.example.com');
    });

    it('extracts hostname from wss:// URL with port and path', () => {
      assert.equal(extractHostname('wss://relay.example.com:8080/ws'), 'relay.example.com');
    });

    it('extracts hostname from http:// URL', () => {
      assert.equal(extractHostname('http://relay.example.com/api'), 'relay.example.com');
    });

    it('extracts hostname from https:// URL', () => {
      assert.equal(extractHostname('https://relay.example.com'), 'relay.example.com');
    });

    it('returns null for bare IPv4 literal', () => {
      assert.equal(extractHostname('http://192.168.1.1'), null);
    });

    it('returns null for bare IPv4 literal with port', () => {
      assert.equal(extractHostname('http://10.0.0.1:3847'), null);
    });

    it('returns null for IPv6 literal', () => {
      assert.equal(extractHostname('http://[::1]:3000'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(extractHostname(''), null);
    });

    it('returns null for whitespace-only string', () => {
      assert.equal(extractHostname('   '), null);
    });
  });

  // ── (a) Unresolvable URL: warn + health surface ────────────

  it('(a) unresolvable URL fires a warn and surfaces entry in unresolvable_urls', async () => {
    const warnMessages: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];

    _setDepsForTesting({
      resolve: async (_hostname: string) => {
        throw new Error('ENOTFOUND');
      },
      logWarn: (msg, ctx) => warnMessages.push({ msg, ctx }),
    });

    const config = makeConfig({
      enabled: true,
      communities: [{ name: 'test-community', primary: 'wss://unresolvable.example.invalid' }],
    });

    await runBootUrlCheck(config);

    // ── Mutation kill 1: logWarn must have been called
    assert.ok(warnMessages.length > 0, 'Expected at least one logWarn call for unresolvable host');
    assert.ok(
      warnMessages.some(w => w.msg.includes('unresolvable')),
      `Expected warn message to mention "unresolvable", got: ${JSON.stringify(warnMessages.map(w => w.msg))}`,
    );

    // ── Mutation kill 2: state must contain the failure entry
    const state = getBootUrlCheckState();
    assert.equal(state.checked, true, 'State must be marked checked');
    assert.equal(
      state.unresolvableUrls.length,
      1,
      `Expected 1 unresolvable entry, got ${state.unresolvableUrls.length}`,
    );

    const entry = state.unresolvableUrls[0]!;
    assert.equal(entry.url, 'wss://unresolvable.example.invalid');
    assert.equal(entry.hostname, 'unresolvable.example.invalid');
    assert.ok(entry.error, 'Entry must include an error string');
  });

  // ── (a) relay.url path also checked ────────────────────────

  it('(a) network.relay.url is checked and surfaced when unresolvable', async () => {
    const warnMessages: string[] = [];

    _setDepsForTesting({
      resolve: async (_hostname: string) => {
        throw new Error('ENOTFOUND relay');
      },
      logWarn: (msg) => warnMessages.push(msg),
    });

    const config = makeConfig({
      enabled: true,
      relay: { url: 'wss://bad-relay.example.invalid' },
    });

    await runBootUrlCheck(config);

    assert.ok(warnMessages.some(m => m.includes('unresolvable')), 'Warn must fire for relay.url');
    const state = getBootUrlCheckState();
    assert.equal(state.unresolvableUrls.length, 1);
    assert.equal(state.unresolvableUrls[0]!.hostname, 'bad-relay.example.invalid');
  });

  // ── (b) Resolvable URL + bare IP: clean ────────────────────

  it('(b) resolvable named host + bare-IP URL → no warn, unresolvable_urls empty', async () => {
    const warnMessages: string[] = [];

    // Mock DNS: succeeds for the named host, throws for anything else.
    // If the bare-IP skip is mutated away, the IP host will be passed to this
    // resolver, it will throw, and unresolvableUrls will become non-empty → RED.
    _setDepsForTesting({
      resolve: async (hostname: string) => {
        if (hostname === 'relay.example.com') return; // success
        throw new Error(`ENOTFOUND ${hostname}`);
      },
      logWarn: (msg) => warnMessages.push(msg),
    });

    const config = makeConfig({
      enabled: true,
      relay: { url: 'http://192.168.1.100' },  // bare IPv4 — must be skipped
      communities: [
        { name: 'prod', primary: 'wss://relay.example.com' }, // named host — resolves
      ],
    });

    await runBootUrlCheck(config);

    // ── Mutation kill: no warnings must have fired
    assert.equal(
      warnMessages.length,
      0,
      `Expected no warns, got: ${JSON.stringify(warnMessages)}`,
    );

    // ── Mutation kill: unresolvable_urls must be empty
    const state = getBootUrlCheckState();
    assert.equal(state.checked, true);
    assert.equal(
      state.unresolvableUrls.length,
      0,
      `Expected empty unresolvable_urls, got: ${JSON.stringify(state.unresolvableUrls)}`,
    );
  });

  // ── Edge: no network config → no-op ───────────────────────

  it('skips gracefully when network config is absent', async () => {
    let resolveCalled = false;
    _setDepsForTesting({
      resolve: async () => { resolveCalled = true; },
      logWarn: () => {},
    });

    const config = makeConfig(); // no network key

    await runBootUrlCheck(config);

    assert.equal(resolveCalled, false, 'DNS resolve must not be called when no URLs configured');
    const state = getBootUrlCheckState();
    assert.equal(state.checked, true);
    assert.equal(state.unresolvableUrls.length, 0);
  });

  // ── Edge: empty/blank URL values → skipped ─────────────────

  it('skips empty string community primary URL', async () => {
    const warnMessages: string[] = [];
    _setDepsForTesting({
      resolve: async () => {},
      logWarn: (msg) => warnMessages.push(msg),
    });

    const config = makeConfig({
      enabled: true,
      communities: [{ name: 'empty', primary: '' }],
    });

    await runBootUrlCheck(config);
    assert.equal(warnMessages.length, 0);
    const state = getBootUrlCheckState();
    assert.equal(state.unresolvableUrls.length, 0);
  });
});
