/**
 * Revocation Tests
 *
 * Tests: t-077 (revocation list blocks install), t-078 (installed revoked skill warning)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPair,
  createRevocationList,
  verifyRevocationList,
  isRevoked,
  checkInstalledRevocations,
} from '../src/index.ts';
import type { RevocationEntry, SignedRevocationList } from '../src/types.ts';

// --- Shared keys ---

let keys: { publicKey: string; privateKey: string };

before(() => {
  keys = generateKeyPair();
});

// --- Tests ---

describe('t-077: Revocation list blocks install of revoked skill', () => {
  let revokedList: SignedRevocationList;

  before(() => {
    const entries: RevocationEntry[] = [
      {
        name: 'malicious-skill',
        version: '1.0.0',
        reason: 'Exfiltrates user data via network requests',
        revoked_at: '2026-02-21T00:00:00.000Z',
        severity: 'critical',
      },
    ];
    revokedList = createRevocationList(entries, keys.privateKey);
  });

  it('step 1: create a signed revocation list with malicious-skill v1.0.0', () => {
    assert.equal(revokedList.entries.length, 1);
    assert.equal(revokedList.entries[0].name, 'malicious-skill');
    assert.equal(revokedList.entries[0].version, '1.0.0');
    assert.equal(revokedList.entries[0].severity, 'critical');
    assert.ok(revokedList.signature, 'Revocation list should have a signature');
    assert.ok(revokedList.signature.length > 10, 'Signature should be non-trivial base64');
  });

  it('step 2: malicious-skill v1.0.0 is revoked — blocked with reason', () => {
    const result = isRevoked(revokedList, 'malicious-skill', '1.0.0');
    assert.ok(result.revoked, 'malicious-skill v1.0.0 should be revoked');
    assert.ok(result.entry, 'Should return the matching revocation entry');
    assert.equal(result.entry!.reason, 'Exfiltrates user data via network requests');
    assert.equal(result.entry!.severity, 'critical');
  });

  it('step 3: malicious-skill v2.0.0 is NOT revoked (version-specific)', () => {
    const result = isRevoked(revokedList, 'malicious-skill', '2.0.0');
    assert.ok(!result.revoked, 'malicious-skill v2.0.0 should not be revoked');
    assert.equal(result.entry, undefined);
  });

  it('step 4: tampered revocation list fails signature verification', () => {
    // Verify the untampered list first
    const validBefore = verifyRevocationList(revokedList, keys.publicKey);
    assert.ok(validBefore, 'Untampered revocation list should verify');

    // Tamper: change the reason
    const tampered: SignedRevocationList = JSON.parse(JSON.stringify(revokedList));
    tampered.entries[0].reason = 'Harmless, actually fine to use';

    const validAfter = verifyRevocationList(tampered, keys.publicKey);
    assert.ok(!validAfter, 'Tampered revocation list should fail verification');
  });

  it('signature fails with wrong public key', () => {
    const otherKeys = generateKeyPair();
    const valid = verifyRevocationList(revokedList, otherKeys.publicKey);
    assert.ok(!valid, 'Should fail verification with a different public key');
  });
});

describe('t-078: Installed revoked skill triggers warning without auto-removal', () => {
  it('step 1+2: installed skills not on revocation list produce no warnings', () => {
    const installedSkills = [
      { name: 'example-skill', version: '1.0.0' },
      { name: 'other-skill', version: '2.3.1' },
    ];

    // Empty revocation list
    const emptyList = createRevocationList([], keys.privateKey);
    const matches = checkInstalledRevocations(emptyList, installedSkills);
    assert.equal(matches.length, 0, 'No warnings when no skills are revoked');
  });

  it('step 3+4: adding example-skill v1.0.0 to revocation list returns a match with reason', () => {
    const installedSkills = [
      { name: 'example-skill', version: '1.0.0' },
      { name: 'safe-skill', version: '3.0.0' },
    ];

    const entries: RevocationEntry[] = [
      {
        name: 'example-skill',
        version: '1.0.0',
        reason: 'Discovered privilege escalation vulnerability',
        revoked_at: '2026-02-21T06:00:00.000Z',
        severity: 'high',
      },
    ];
    const revokedList = createRevocationList(entries, keys.privateKey);

    const matches = checkInstalledRevocations(revokedList, installedSkills);
    assert.equal(matches.length, 1, 'Should find exactly one revoked skill');
    assert.equal(matches[0].skill.name, 'example-skill');
    assert.equal(matches[0].skill.version, '1.0.0');
    assert.equal(matches[0].entry.reason, 'Discovered privilege escalation vulnerability');
    assert.equal(matches[0].entry.severity, 'high');
  });

  it('step 5: checkInstalledRevocations reports but does NOT remove — installed list is unchanged', () => {
    const installedSkills = [
      { name: 'example-skill', version: '1.0.0' },
      { name: 'another-skill', version: '0.9.0' },
    ];
    const originalSnapshot = JSON.parse(JSON.stringify(installedSkills));

    const entries: RevocationEntry[] = [
      {
        name: 'example-skill',
        version: '1.0.0',
        reason: 'Malicious update pushed',
        revoked_at: '2026-02-21T08:00:00.000Z',
        severity: 'critical',
      },
    ];
    const revokedList = createRevocationList(entries, keys.privateKey);

    const matches = checkInstalledRevocations(revokedList, installedSkills);

    // Report: one match found
    assert.equal(matches.length, 1);

    // No removal: installed list is UNCHANGED
    assert.deepStrictEqual(
      installedSkills,
      originalSnapshot,
      'Installed skills array must not be modified by checkInstalledRevocations',
    );
    assert.equal(installedSkills.length, 2, 'All 2 skills still in installed list');
  });

  it('only exact version matches are reported — other versions of revoked skill are safe', () => {
    const installedSkills = [
      { name: 'example-skill', version: '1.0.1' },  // patched version
      { name: 'example-skill', version: '2.0.0' },  // newer version
    ];

    const entries: RevocationEntry[] = [
      {
        name: 'example-skill',
        version: '1.0.0',
        reason: 'Only v1.0.0 is affected',
        revoked_at: '2026-02-21T00:00:00.000Z',
        severity: 'medium',
      },
    ];
    const revokedList = createRevocationList(entries, keys.privateKey);

    const matches = checkInstalledRevocations(revokedList, installedSkills);
    assert.equal(matches.length, 0, 'Patched and newer versions should not be flagged');
  });
});

describe('createRevocationList: determinism and sorting', () => {
  it('entries are sorted by name then version for deterministic signing', () => {
    const entries: RevocationEntry[] = [
      { name: 'zebra-skill', version: '1.0.0', reason: 'Z', revoked_at: '2026-01-01T00:00:00.000Z', severity: 'low' },
      { name: 'alpha-skill', version: '2.0.0', reason: 'A2', revoked_at: '2026-01-01T00:00:00.000Z', severity: 'low' },
      { name: 'alpha-skill', version: '1.0.0', reason: 'A1', revoked_at: '2026-01-01T00:00:00.000Z', severity: 'low' },
    ];

    const list = createRevocationList(entries, keys.privateKey);

    assert.equal(list.entries[0].name, 'alpha-skill');
    assert.equal(list.entries[0].version, '1.0.0');
    assert.equal(list.entries[1].name, 'alpha-skill');
    assert.equal(list.entries[1].version, '2.0.0');
    assert.equal(list.entries[2].name, 'zebra-skill');
  });

  it('same entries in different order produce identical signed lists', () => {
    const entry1: RevocationEntry = {
      name: 'skill-a', version: '1.0.0', reason: 'reason a',
      revoked_at: '2026-01-01T00:00:00.000Z', severity: 'high',
    };
    const entry2: RevocationEntry = {
      name: 'skill-b', version: '1.0.0', reason: 'reason b',
      revoked_at: '2026-01-01T00:00:00.000Z', severity: 'medium',
    };

    const list1 = createRevocationList([entry1, entry2], keys.privateKey);
    const list2 = createRevocationList([entry2, entry1], keys.privateKey);

    assert.equal(list1.signature, list2.signature, 'Different entry order should produce identical signature');
    assert.deepStrictEqual(list1.entries, list2.entries, 'Entries should be in same sorted order');
  });
});
