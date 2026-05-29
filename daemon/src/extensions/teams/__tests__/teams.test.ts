/**
 * Teams Bot Framework extension tests
 *
 * Tests:
 * (a) JWT validation logic — valid audience passes, wrong audience/issuer/expired fails.
 *     JWKS fetch is mocked to avoid network calls.
 * (b) Outbound activity construction — correct URL + body shape from a conversation reference.
 * (c) Teams channel is subject to the approval gate (policy-configured channel is gated).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

// ── Imports under test ────────────────────────────────────────────────────────
import {
  verifyBotFrameworkJwt,
  _setFetchJson,
  _resetJwksCacheForTesting,
  BOT_FRAMEWORK_ISSUER,
} from '../jwt-verify.js';

import {
  TeamsAdapter,
  upsertConversationRef,
  getConversationRef,
  _resetConversationRefsForTesting,
  sendTeamsActivity,
  _resetTokenCacheForTesting,
  type ConversationReference,
} from '../index.js';

import {
  registerAdapter,
  routeMessage,
  registerOutboundGate,
  _resetForTesting as resetChannelRouter,
} from '../../../comms/channel-router.js';

import {
  approvalGate,
  _resetForTesting as resetApprovalGate,
} from '../../../comms/approval-gate.js';

import { openDatabase, closeDatabase, _resetDbForTesting } from '../../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../../core/config.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const BOT_APP_ID = '70db3bc8-52fd-4270-9247-61d53b2ea019';

/**
 * Generate a minimal RSA key pair and build a signed JWT for testing.
 * Uses Node.js crypto.generateKeyPairSync (synchronous for test simplicity).
 *
 * Returns { token, kid, publicKeyJwk }.
 */
function makeMockJwt(overrides: {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  kid?: string;
  alg?: string;
} = {}): { token: string; kid: string; publicKeyJwk: Record<string, unknown> } {
  const kid = overrides.kid ?? 'test-kid-001';

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  // Export public key as JWK
  const jwkExported = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const publicKeyJwk = { ...jwkExported, kid, use: 'sig', alg: 'RS256' };

  // Build JWT
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg: overrides.alg ?? 'RS256',
    kid,
    typ: 'JWT',
  };
  const payload = {
    iss: overrides.iss ?? BOT_FRAMEWORK_ISSUER,
    aud: overrides.aud ?? BOT_APP_ID,
    exp: overrides.exp ?? nowSec + 3600,
    iat: nowSec,
    nbf: nowSec - 60,
    appid: BOT_APP_ID,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign with private key (RS256 = SHA256 + RSA PKCS1v1.5)
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  const signature = signer.sign(privateKey, 'base64url');

  const token = `${signingInput}.${signature}`;
  return { token, kid, publicKeyJwk };
}

/**
 * Install a mock fetchJson that serves a JWKS with the given keys.
 */
function installMockJwks(keys: Record<string, unknown>[]): void {
  _setFetchJson(async (url: string) => {
    if (url.includes('openidconfiguration')) {
      return { jwks_uri: 'https://mock-jwks.invalid/keys' };
    }
    if (url.includes('mock-jwks')) {
      return { keys };
    }
    throw new Error(`Unexpected fetchJson URL: ${url}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) JWT VALIDATION TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Teams JWT verification — valid token passes', () => {
  beforeEach(() => {
    _resetJwksCacheForTesting();
  });

  afterEach(() => {
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });

  it('accepts a correctly-signed token with matching iss and aud', async () => {
    const { token, publicKeyJwk } = makeMockJwt();
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(
      result.ok,
      true,
      `Expected ok:true but got: ${result.ok ? '' : (result as { ok: false; reason: string }).reason}`,
    );
    if (result.ok) {
      assert.equal(result.claims.iss, BOT_FRAMEWORK_ISSUER);
    }
  });

  it('accepts a token with aud as an array containing the bot app id', async () => {
    const { token, publicKeyJwk } = makeMockJwt({ aud: [BOT_APP_ID, 'other-app'] });
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, true);
  });
});

describe('Teams JWT verification — wrong audience rejected', () => {
  beforeEach(() => {
    _resetJwksCacheForTesting();
  });

  afterEach(() => {
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });

  it('rejects a token with wrong aud', async () => {
    const { token, publicKeyJwk } = makeMockJwt({ aud: 'wrong-app-id' });
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /audience/i);
    }
  });

  it('rejects a token with aud array that does not contain the bot app id', async () => {
    const { token, publicKeyJwk } = makeMockJwt({ aud: ['other-id-1', 'other-id-2'] });
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /audience/i);
    }
  });
});

describe('Teams JWT verification — wrong issuer rejected', () => {
  beforeEach(() => {
    _resetJwksCacheForTesting();
  });

  afterEach(() => {
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });

  it('rejects a token with wrong iss', async () => {
    const { token, publicKeyJwk } = makeMockJwt({ iss: 'https://evil.attacker.com' });
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /issuer/i);
    }
  });
});

describe('Teams JWT verification — expired token rejected', () => {
  beforeEach(() => {
    _resetJwksCacheForTesting();
  });

  afterEach(() => {
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });

  it('rejects a token with exp in the past', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { token, publicKeyJwk } = makeMockJwt({ exp: nowSec - 3600 }); // expired 1h ago
    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /expired/i);
    }
  });
});

describe('Teams JWT verification — malformed token rejected', () => {
  it('rejects a non-JWT string', async () => {
    const result = await verifyBotFrameworkJwt('not-a-jwt', BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /malformed/i);
    }
  });

  it('rejects a token with invalid signature', async () => {
    _resetJwksCacheForTesting();
    const { token, publicKeyJwk } = makeMockJwt();

    // Tamper the signature
    const parts = token.split('.');
    const tamperedSig = parts[2].slice(0, -4) + 'XXXX';
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    installMockJwks([publicKeyJwk]);

    const result = await verifyBotFrameworkJwt(tamperedToken, BOT_APP_ID);
    assert.equal(result.ok, false);
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });

  it('fails closed when JWKS fetch throws', async () => {
    _resetJwksCacheForTesting();
    const { token } = makeMockJwt();
    _setFetchJson(async () => { throw new Error('network down'); });

    const result = await verifyBotFrameworkJwt(token, BOT_APP_ID);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /JWKS/i);
    }
    _resetJwksCacheForTesting();
    _setFetchJson(async (url) => { throw new Error(`Unexpected network in test: ${url}`); });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) OUTBOUND ACTIVITY CONSTRUCTION
// ─────────────────────────────────────────────────────────────────────────────

describe('Teams outbound — activity URL and body shape', () => {
  let capturedRequests: Array<{ url: string; options: RequestInit }> = [];
  let originalFetch: typeof globalThis.fetch;

  const mockRef: ConversationReference = {
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    conversationId: 'conv-001:abc',
    botId: 'bot-id-001',
    botName: 'Bridget',
    userId: 'user-id-001',
    userName: 'Marnie',
    channelId: 'msteams',
  };

  beforeEach(() => {
    _resetTokenCacheForTesting();
    capturedRequests = [];
    originalFetch = globalThis.fetch;

    // Mock fetch to capture requests
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      capturedRequests.push({ url: urlStr, options: options ?? {} });

      // AAD token endpoint
      if (urlStr.includes('microsoftonline.com')) {
        return new Response(JSON.stringify({
          access_token: 'mock-aad-token-value',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Bot Framework connector endpoint
      if (urlStr.includes('v3/conversations')) {
        return new Response(JSON.stringify({ id: 'activity-response-001' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetTokenCacheForTesting();
  });

  it('sends to correct URL: {serviceUrl}/v3/conversations/{conversationId}/activities', async () => {
    await sendTeamsActivity(mockRef, 'Hello from Bridget!', 'client-id', 'client-secret');

    const outboundReq = capturedRequests.find(r => r.url.includes('v3/conversations'));
    assert.ok(outboundReq, 'Expected an outbound Teams activity request');
    // serviceUrl trailing slash removed + path appended
    const expectedUrl = `https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent('conv-001:abc')}/activities`;
    assert.equal(outboundReq!.url, expectedUrl);
  });

  it('sets Authorization: Bearer <token> header on outbound request', async () => {
    await sendTeamsActivity(mockRef, 'Test message', 'client-id', 'client-secret');

    const outboundReq = capturedRequests.find(r => r.url.includes('v3/conversations'));
    assert.ok(outboundReq);
    const headers = outboundReq!.options.headers as Record<string, string>;
    assert.ok(headers['Authorization']?.startsWith('Bearer '), 'Authorization header must start with Bearer');
    assert.equal(headers['Authorization'], 'Bearer mock-aad-token-value');
  });

  it('sends correct activity body shape', async () => {
    await sendTeamsActivity(mockRef, 'Hello Teams!', 'client-id', 'client-secret');

    const outboundReq = capturedRequests.find(r => r.url.includes('v3/conversations'));
    assert.ok(outboundReq);
    const body = JSON.parse(outboundReq!.options.body as string) as Record<string, unknown>;

    assert.equal(body.type, 'message');
    assert.equal(body.text, 'Hello Teams!');
    assert.deepEqual(body.from, { id: 'bot-id-001', name: 'Bridget' });
    assert.deepEqual(body.recipient, { id: 'user-id-001', name: 'Marnie' });
    assert.deepEqual(body.conversation, { id: 'conv-001:abc' });
    assert.equal(body.channelId, 'msteams');
  });

  it('TeamsAdapter.send() resolves true on success', async () => {
    _resetConversationRefsForTesting();
    upsertConversationRef(mockRef);
    const adapter = new TeamsAdapter('client-id', 'client-secret');
    const result = await adapter.send({ text: 'Hello!', metadata: { conversationId: 'conv-001:abc' } });
    assert.equal(result, true);
    _resetConversationRefsForTesting();
  });

  it('TeamsAdapter.send() resolves false when no conversation ref available', async () => {
    _resetConversationRefsForTesting();
    const adapter = new TeamsAdapter('client-id', 'client-secret');
    const result = await adapter.send({ text: 'No conversation ref' });
    assert.equal(result, false);
  });

  it('TeamsAdapter.send() uses metadata.conversationId to target specific conversation', async () => {
    _resetConversationRefsForTesting();
    const ref2: ConversationReference = { ...mockRef, conversationId: 'conv-002' };
    upsertConversationRef(mockRef);
    upsertConversationRef(ref2);

    const adapter = new TeamsAdapter('client-id', 'client-secret');
    await adapter.send({ text: 'Targeted', metadata: { conversationId: 'conv-001:abc' } });

    const outboundReq = capturedRequests.find(r => r.url.includes('v3/conversations'));
    assert.ok(outboundReq);
    assert.ok(outboundReq!.url.includes(encodeURIComponent('conv-001:abc')));
    _resetConversationRefsForTesting();
  });

  it('AAD token is cached across multiple sends', async () => {
    _resetConversationRefsForTesting();
    upsertConversationRef(mockRef);
    const adapter = new TeamsAdapter('client-id', 'client-secret');
    await adapter.send({ text: 'First', metadata: { conversationId: 'conv-001:abc' } });
    await adapter.send({ text: 'Second', metadata: { conversationId: 'conv-001:abc' } });

    const aadRequests = capturedRequests.filter(r => r.url.includes('microsoftonline.com'));
    assert.equal(aadRequests.length, 1, 'AAD token should be fetched once and cached');
    _resetConversationRefsForTesting();
  });

  it('refreshes AAD token on 401 from connector', async () => {
    _resetTokenCacheForTesting();
    let connectorCallCount = 0;

    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
      const urlStr = url.toString();
      capturedRequests.push({ url: urlStr, options: options ?? {} });

      if (urlStr.includes('microsoftonline.com')) {
        return new Response(JSON.stringify({ access_token: 'fresh-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('v3/conversations')) {
        connectorCallCount++;
        if (connectorCallCount === 1) {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ id: 'reply-id' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`);
    };

    await sendTeamsActivity(mockRef, 'Retry test', 'client-id', 'client-secret');
    assert.equal(connectorCallCount, 2, 'Connector should be called twice (initial 401 + retry)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) APPROVAL GATE: teams channel is gated when policy is configured
// ─────────────────────────────────────────────────────────────────────────────

describe('Teams approval gate — channel=teams is subject to the gate', () => {
  let _dbDir: string;

  beforeEach(() => {
    _dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-gate-'));
    _resetDbForTesting();
    openDatabase(_dbDir, path.join(_dbDir, 'test.db'));
    resetApprovalGate();
    resetChannelRouter();

    // Write a config that gates the 'teams' channel
    fs.writeFileSync(path.join(_dbDir, 'kithkit.config.yaml'), [
      'approval_policies:',
      '  teams:',
      '    require_approval_for: all',
      '    timeout_minutes: 1',
    ].join('\n'));
    _resetConfigForTesting();
    loadConfig(_dbDir);
  });

  afterEach(() => {
    resetApprovalGate();
    resetChannelRouter();
    _resetConfigForTesting();
    closeDatabase();
    _resetDbForTesting();
    fs.rmSync(_dbDir, { recursive: true, force: true });
  });

  it('approvalGate returns false when no card delivery fn registered (fail-closed)', async () => {
    // No card delivery fn — gate should fail closed when a policy exists
    const result = await approvalGate({
      channel: 'teams',
      recipient: ['user@example.com'],
      content: 'Hello Teams!',
      rawContent: 'Hello Teams!',
      sender_agent: 'bridget',
    });
    assert.equal(result, false, 'Gate must fail-closed when card delivery fn is absent');
  });

  it('routeMessage with channel=teams is blocked when gate returns false', async () => {
    // Register a mock TeamsAdapter that records sends
    let sendCalled = false;
    const mockAdapter = {
      name: 'teams',
      send: async (_msg: { text: string }) => { sendCalled = true; return true; },
      receive: async () => [],
      formatMessage: (text: string) => text,
      capabilities: () => ({ markdown: true, images: false, buttons: false, html: false, maxLength: null }),
    };

    registerAdapter(mockAdapter);
    // Register a gate that returns false (simulates approval denied / not yet resolved)
    registerOutboundGate(async () => false);

    const results = await routeMessage({ text: 'Should be blocked' }, ['teams']);
    assert.equal(results['teams'], false, 'routeMessage should return false when gate denies');
    assert.equal(sendCalled, false, 'adapter.send() must NOT be called when gate denies');
  });

  it('routeMessage with channel=teams passes through when gate returns true', async () => {
    let sendCalled = false;
    const mockAdapter = {
      name: 'teams',
      send: async (_msg: { text: string }) => { sendCalled = true; return true; },
      receive: async () => [],
      formatMessage: (text: string) => text,
      capabilities: () => ({ markdown: true, images: false, buttons: false, html: false, maxLength: null }),
    };

    registerAdapter(mockAdapter);
    registerOutboundGate(async () => true);

    const results = await routeMessage({ text: 'Should go through' }, ['teams']);
    assert.equal(results['teams'], true);
    assert.equal(sendCalled, true, 'adapter.send() must be called when gate approves');
  });

  it('approvalGate resolvePolicy returns a policy entry for configured teams channel', async () => {
    // This verifies the config integration: the gate reads approval_policies
    // and recognizes 'teams' as gated
    const { resolvePolicy } = await import('../../../comms/approval-gate.js');
    const policy = resolvePolicy('teams');
    assert.ok(policy !== null, 'resolvePolicy should return a policy for teams');
    assert.equal(policy!.require_approval_for, 'all');
  });

  it('approvalGate resolvePolicy returns null for unconfigured channels (pass-through)', async () => {
    const { resolvePolicy } = await import('../../../comms/approval-gate.js');
    const policy = resolvePolicy('not-configured-channel');
    assert.equal(policy, null, 'Unconfigured channels should return null (pass-through)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION REFERENCE STORE
// ─────────────────────────────────────────────────────────────────────────────

describe('Conversation reference store', () => {
  beforeEach(() => {
    _resetConversationRefsForTesting();
  });

  afterEach(() => {
    _resetConversationRefsForTesting();
  });

  const mockRef: ConversationReference = {
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    conversationId: 'test-conv-id',
    botId: 'bot-001',
    botName: 'Bridget',
    userId: 'user-001',
    userName: 'Marnie',
    channelId: 'msteams',
  };

  it('upsertConversationRef stores and getConversationRef retrieves', () => {
    upsertConversationRef(mockRef);
    const retrieved = getConversationRef('test-conv-id');
    assert.ok(retrieved);
    assert.equal(retrieved!.serviceUrl, mockRef.serviceUrl);
    assert.equal(retrieved!.botId, mockRef.botId);
  });

  it('upsertConversationRef updates an existing entry', () => {
    upsertConversationRef(mockRef);
    upsertConversationRef({ ...mockRef, userName: 'Updated Name' });
    const retrieved = getConversationRef('test-conv-id');
    assert.equal(retrieved!.userName, 'Updated Name');
  });

  it('getConversationRef returns undefined for unknown id', () => {
    const result = getConversationRef('unknown-id');
    assert.equal(result, undefined);
  });
});
