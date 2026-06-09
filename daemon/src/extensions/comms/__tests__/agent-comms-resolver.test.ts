/**
 * Mutation-killing tests for the peer address resolver (kithkit#785b).
 *
 * Pins IP-primary ordering: static .ip MUST be tried before .host.
 * These tests go RED if the order is reverted to host-first.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeerHosts } from '../agent-comms.js';
import type { PeerConfig } from '../agent-comms.js';

describe('buildPeerHosts — ip-before-host resolver (#785b)', () => {
  /**
   * Case 1: peer has both .ip and .host set.
   * .ip MUST be first in the returned list.
   * If this test goes RED, the order was flipped back to host-first.
   */
  it('returns .ip before .host when both are set', () => {
    const peer: PeerConfig = {
      name: 'r2d2',
      host: 'chrissys-mini.local',
      port: 3847,
      ip: '192.168.12.243',
    };

    const hosts = buildPeerHosts(peer, null);

    // .ip is first — any other ordering is a regression
    assert.equal(hosts[0], '192.168.12.243', '.ip must be first address tried');
    assert.equal(hosts[1], 'chrissys-mini.local', '.host must be the fallback');
    assert.equal(hosts.length, 2);
  });

  /**
   * Case 2: peer has no .ip (or empty string).
   * Resolver MUST fall back to .host (gate (a) fallback preserved).
   */
  it('falls back to .host when .ip is unset', () => {
    const peerNoIp: PeerConfig = {
      name: 'unknown-box',
      host: 'some-machine.local',
      port: 3847,
      // ip deliberately omitted
    };
    const hostsNoIp = buildPeerHosts(peerNoIp, null);
    assert.equal(hostsNoIp[0], 'some-machine.local', '.host must be used when .ip is absent');
    assert.equal(hostsNoIp.length, 1);

    const peerEmptyIp: PeerConfig = {
      name: 'unknown-box',
      host: 'some-machine.local',
      port: 3847,
      ip: '',
    };
    const hostsEmptyIp = buildPeerHosts(peerEmptyIp, null);
    assert.equal(hostsEmptyIp[0], 'some-machine.local', '.host must be used when .ip is empty string');
    assert.equal(hostsEmptyIp.length, 1);
  });

  /**
   * Case 3: env override is present.
   * Override MUST be first, .ip second, .host last.
   */
  it('places env override before .ip and .host', () => {
    const peer: PeerConfig = {
      name: 'bmo',
      host: 'davids-mac-mini.lan',
      port: 3847,
      ip: '192.168.12.169',
    };

    const hosts = buildPeerHosts(peer, '10.0.0.1');

    assert.equal(hosts[0], '10.0.0.1', 'override must be first');
    assert.equal(hosts[1], '192.168.12.169', '.ip must be second');
    assert.equal(hosts[2], 'davids-mac-mini.lan', '.host must be third');
    assert.equal(hosts.length, 3);
  });

  /**
   * Case 4: .ip equals .host (e.g. peer configured with a bare IP in both fields).
   * Should not add duplicates.
   */
  it('deduplicates when .ip and .host are identical', () => {
    const peer: PeerConfig = {
      name: 'dup-peer',
      host: '192.168.12.100',
      port: 3847,
      ip: '192.168.12.100',
    };

    const hosts = buildPeerHosts(peer, null);

    assert.equal(hosts.length, 1, 'no duplicate when .ip === .host');
    assert.equal(hosts[0], '192.168.12.100');
  });
});
