/**
 * Catalog Client Search Tests
 *
 * Tests: t-079 (agent searches catalog and finds matching skills)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateKeyPairSync,
  createPrivateKey,
  sign as cryptoSign,
} from 'node:crypto';

import { CatalogCache, verifyAndParseIndex, searchCatalog, formatSearchResults } from '../src/search.ts';
import type { SignedCatalogIndex, SkillEntry } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Generate an Ed25519 keypair (same encoding as signing-bridge.ts in catalog).
 */
function generateKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

/**
 * Sign data with a base64-encoded PKCS8 DER private key.
 */
function signData(data: Buffer, privateKeyBase64: string): string {
  const keyObject = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = cryptoSign(null, data, keyObject);
  return signature.toString('base64');
}

/**
 * Sort keys recursively for canonical JSON.
 */
function sortDeep(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sortDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortDeep((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortDeep(obj));
}

/**
 * Build a signed catalog index from a list of skill entries.
 */
function buildTestSignedIndex(
  skills: SkillEntry[],
  privateKey: string,
  timestamp = '2026-02-21T00:00:00.000Z',
): SignedCatalogIndex {
  const indexBody = {
    version: 1,
    updated: timestamp,
    skills: [...skills].sort((a, b) => a.name.localeCompare(b.name)),
  };

  const canonical = canonicalJson(indexBody);
  const data = Buffer.from(canonical, 'utf8');
  const signature = signData(data, privateKey);

  return { ...indexBody, signature };
}

/**
 * Make a minimal SkillEntry for tests.
 */
function makeSkill(opts: {
  name: string;
  description: string;
  tags: string[];
  capabilities: string[];
  trust_level: 'first-party' | 'verified' | 'community';
  version?: string;
}): SkillEntry {
  const version = opts.version ?? '1.0.0';
  return {
    name: opts.name,
    description: opts.description,
    author: { name: 'Test Author', github: 'testauthor' },
    capabilities: { required: opts.capabilities },
    tags: opts.tags,
    category: 'testing',
    trust_level: opts.trust_level,
    latest: version,
    versions: {
      [version]: {
        version,
        archive: `archives/${opts.name}/${opts.name}-${version}.tar.gz`,
        sha256: 'a'.repeat(64),
        signature: 'fakesig',
        size: 1024,
        published: '2026-02-21T00:00:00.000Z',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture: 3 skills used throughout t-079
// ---------------------------------------------------------------------------

const WEATHER_SKILL = makeSkill({
  name: 'weather-check',
  description: 'Check weather forecasts',
  tags: ['api', 'weather'],
  capabilities: ['web_fetch'],
  trust_level: 'verified',
});

const DOCKER_SKILL = makeSkill({
  name: 'docker-manage',
  description: 'Manage Docker containers',
  tags: ['devops', 'docker'],
  capabilities: ['bash'],
  trust_level: 'community',
});

const EMAIL_SKILL = makeSkill({
  name: 'email-compose',
  description: 'Compose and send emails',
  tags: ['api', 'email'],
  capabilities: ['web_fetch', 'bash'],
  trust_level: 'first-party',
});

// ---------------------------------------------------------------------------
// t-079: Agent searches catalog and finds matching skills
// ---------------------------------------------------------------------------

let tmpDir: string;
let keys: { publicKey: string; privateKey: string };
let signedIndex: SignedCatalogIndex;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'kithkit-client-search-test-'));
  keys = generateKeyPair();
  signedIndex = buildTestSignedIndex(
    [WEATHER_SKILL, DOCKER_SKILL, EMAIL_SKILL],
    keys.privateKey,
  );
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('t-079: Agent searches catalog and finds matching skills', () => {
  it('step 1: text search "weather" returns only weather-check', () => {
    const results = searchCatalog(signedIndex, { text: 'weather' });

    assert.equal(results.length, 1, 'Should return exactly 1 result');
    assert.equal(results[0].name, 'weather-check');
    assert.equal(results[0].description, 'Check weather forecasts');
  });

  it('step 2: text search is case-insensitive', () => {
    const upper = searchCatalog(signedIndex, { text: 'WEATHER' });
    const mixed = searchCatalog(signedIndex, { text: 'Weather' });
    assert.equal(upper.length, 1);
    assert.equal(mixed.length, 1);
    assert.equal(upper[0].name, 'weather-check');
  });

  it('step 3: tag search "api" returns weather-check and email-compose', () => {
    const results = searchCatalog(signedIndex, { tag: 'api' });

    assert.equal(results.length, 2, 'Should return 2 results with api tag');
    const names = results.map(r => r.name).sort();
    assert.deepStrictEqual(names, ['email-compose', 'weather-check']);
  });

  it('step 4: capability search "web_fetch" returns weather-check and email-compose', () => {
    const results = searchCatalog(signedIndex, { capability: 'web_fetch' });

    assert.equal(results.length, 2, 'Should return 2 results with web_fetch capability');
    const names = results.map(r => r.name).sort();
    assert.deepStrictEqual(names, ['email-compose', 'weather-check']);
  });

  it('step 5: each result includes trust_level', () => {
    const results = searchCatalog(signedIndex, {});

    for (const result of results) {
      assert.ok(
        ['first-party', 'verified', 'community'].includes(result.trust_level),
        `trust_level should be a known value, got: ${result.trust_level}`,
      );
    }

    // Verify specific trust levels
    const weather = results.find(r => r.name === 'weather-check');
    const docker = results.find(r => r.name === 'docker-manage');
    const email = results.find(r => r.name === 'email-compose');

    assert.ok(weather, 'weather-check should be in results');
    assert.ok(docker, 'docker-manage should be in results');
    assert.ok(email, 'email-compose should be in results');

    assert.equal(weather!.trust_level, 'verified');
    assert.equal(docker!.trust_level, 'community');
    assert.equal(email!.trust_level, 'first-party');
  });

  it('step 6: AND logic — text + tag both must match', () => {
    // 'api' tag matches weather-check and email-compose
    // 'email' text matches only email-compose
    const results = searchCatalog(signedIndex, { text: 'email', tag: 'api' });

    assert.equal(results.length, 1, 'AND logic: only email-compose matches both');
    assert.equal(results[0].name, 'email-compose');
  });

  it('step 7: empty query returns all skills', () => {
    const results = searchCatalog(signedIndex, {});
    assert.equal(results.length, 3, 'Empty query should return all 3 skills');
  });

  it('step 8: no match returns empty array', () => {
    const results = searchCatalog(signedIndex, { text: 'nonexistent-xyz-skill' });
    assert.equal(results.length, 0, 'No match should return empty array');
  });

  it('step 9: results include version, capabilities, tags, author', () => {
    const results = searchCatalog(signedIndex, { text: 'weather' });
    const result = results[0];

    assert.equal(result.version, '1.0.0');
    assert.deepStrictEqual(result.capabilities.required, ['web_fetch']);
    assert.deepStrictEqual(result.tags, ['api', 'weather']);
    assert.deepStrictEqual(result.author, { name: 'Test Author', github: 'testauthor' });
  });

  it('step 10: cache — second call returns cached without re-fetch', async () => {
    const cacheDir = join(tmpDir, 'cache-test');

    let fetchCount = 0;
    const fetchFn = async (): Promise<SignedCatalogIndex> => {
      fetchCount++;
      return signedIndex;
    };

    const cache = new CatalogCache(cacheDir, 60_000); // 1 minute TTL

    const first = await cache.getIndex(fetchFn);
    const second = await cache.getIndex(fetchFn);

    assert.equal(fetchCount, 1, 'fetch should only be called once (second call uses cache)');
    assert.equal(first.signature, signedIndex.signature);
    assert.equal(second.signature, signedIndex.signature);
    assert.equal(first.skills.length, second.skills.length);
  });

  it('step 11: cache — expired TTL causes re-fetch', async () => {
    const cacheDir = join(tmpDir, 'cache-ttl-test');

    let fetchCount = 0;
    const fetchFn = async (): Promise<SignedCatalogIndex> => {
      fetchCount++;
      return signedIndex;
    };

    // TTL of 0ms means every call is stale
    const cache = new CatalogCache(cacheDir, 0);

    await cache.getIndex(fetchFn);

    // Wait a tick to ensure the timestamp is definitely past TTL=0
    await new Promise(resolve => setTimeout(resolve, 5));

    await cache.getIndex(fetchFn);

    assert.equal(fetchCount, 2, 'Expired cache should trigger re-fetch');
  });

  it('step 12: cache invalidate clears the cache', async () => {
    const cacheDir = join(tmpDir, 'cache-invalidate-test');

    let fetchCount = 0;
    const fetchFn = async (): Promise<SignedCatalogIndex> => {
      fetchCount++;
      return signedIndex;
    };

    const cache = new CatalogCache(cacheDir, 60_000);

    await cache.getIndex(fetchFn);
    assert.equal(fetchCount, 1, 'First call fetches');

    await cache.invalidate();

    await cache.getIndex(fetchFn);
    assert.equal(fetchCount, 2, 'After invalidate, should re-fetch');
  });

  it('step 13: valid index passes signature verification', () => {
    const result = verifyAndParseIndex(signedIndex, keys.publicKey);
    assert.ok(result.valid, 'Valid signed index should pass verification');
    if (result.valid) {
      assert.equal(result.index.skills.length, 3);
    }
  });

  it('step 14: tampered index fails verification', () => {
    // Deep clone and tamper
    const tampered: SignedCatalogIndex = JSON.parse(JSON.stringify(signedIndex));
    tampered.skills[0].description = 'TAMPERED DESCRIPTION';

    const result = verifyAndParseIndex(tampered, keys.publicKey);
    assert.ok(!result.valid, 'Tampered index should fail verification');
    if (!result.valid) {
      assert.ok(result.error.length > 0, 'Should include error message');
    }
  });

  it('step 15: index signed with wrong key fails verification', () => {
    const otherKeys = generateKeyPair();
    const result = verifyAndParseIndex(signedIndex, otherKeys.publicKey);
    assert.ok(!result.valid, 'Index signed with different key should fail verification');
  });

  it('step 16: invalid public key returns error (not throw)', () => {
    const result = verifyAndParseIndex(signedIndex, 'not-valid-base64!!');
    assert.ok(!result.valid, 'Invalid public key should return valid:false');
    if (!result.valid) {
      assert.ok(result.error.length > 0);
    }
  });

  it('step 17: formatSearchResults shows "No matching skills found" on empty', () => {
    const output = formatSearchResults([]);
    assert.equal(output, 'No matching skills found.');
  });

  it('step 18: formatSearchResults shows name, version, trust_level, description, capabilities, tags', () => {
    const results = searchCatalog(signedIndex, { text: 'weather' });
    const output = formatSearchResults(results);

    assert.ok(output.includes('weather-check'), 'Should include skill name');
    assert.ok(output.includes('v1.0.0'), 'Should include version');
    assert.ok(output.includes('[verified]'), 'Should include trust level label');
    assert.ok(output.includes('Check weather forecasts'), 'Should include description');
    assert.ok(output.includes('web_fetch'), 'Should include capability');
    assert.ok(output.includes('api') && output.includes('weather'), 'Should include tags');
  });

  it('step 19: formatSearchResults shows all results when multiple match', () => {
    const results = searchCatalog(signedIndex, { tag: 'api' });
    const output = formatSearchResults(results);

    assert.ok(output.includes('weather-check'), 'Should include weather-check');
    assert.ok(output.includes('email-compose'), 'Should include email-compose');
    assert.ok(output.includes('[verified]'), 'Should include verified label');
    assert.ok(output.includes('[first-party]'), 'Should include first-party label');
  });
});
