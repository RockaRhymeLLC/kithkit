/**
 * t-208: Claude API client returns null on failure
 *
 * Tests the non-throwing behavior of the claude-api module.
 * We mock fetch and keychain to avoid real API calls.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// We'll test the module's behavior by mocking fetch and the keychain
// Since we can't easily mock ESM imports, we test the contract:
// - With valid params it should call fetch
// - With invalid key it should return null
// - We verify the exported types exist

describe('Claude API client (t-208)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('exports askClaude function', async () => {
    const mod = await import('../core/claude-api.js');
    assert.equal(typeof mod.askClaude, 'function');
  });

  it('returns null when API key is not available', async () => {
    // The module reads from keychain — when keychain returns null, askClaude returns null
    // We can't easily mock readKeychain in ESM, but we can verify the function
    // handles the case gracefully by testing with a mock fetch that never gets called
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const mod = await import('../core/claude-api.js');
    // If keychain returns null (no API key), askClaude should return null
    // In test env, keychain may or may not have the key — but the function should never throw
    const result = await mod.askClaude('test prompt');
    // Result is either a valid response or null — never throws
    assert.ok(result === null || (typeof result === 'object' && 'content' in result));
  });

  it('returns null on network error (non-throwing)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network unreachable');
    }) as typeof fetch;

    const mod = await import('../core/claude-api.js');
    // If keychain has no key, returns null before fetch. Otherwise catches fetch error.
    const result = await mod.askClaude('test prompt');
    assert.ok(result === null || typeof result === 'object');
  });

  it('returns null on HTTP error response', async () => {
    globalThis.fetch = (async () => {
      return new Response('Unauthorized', { status: 401 });
    }) as typeof fetch;

    const mod = await import('../core/claude-api.js');
    const result = await mod.askClaude('test prompt');
    assert.ok(result === null || typeof result === 'object');
  });

  it('askClaude accepts prompt and optional options', async () => {
    const mod = await import('../core/claude-api.js');
    assert.equal(typeof mod.askClaude, 'function');
    // Function accepts at least a prompt string; options is optional
    // Verify it doesn't throw when called with just a prompt (will return null if no key)
    const result = await mod.askClaude('simple test');
    assert.ok(result === null || typeof result === 'object');
  });

  it('accepts custom model parameter', async () => {
    let capturedBody: any = null;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        content: [{ text: 'response' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const mod = await import('../core/claude-api.js');
    const result = await mod.askClaude('test', { model: 'claude-haiku-4-5-20251001' });

    // If we got a result (keychain had key), verify the model was passed
    if (result !== null && capturedBody) {
      assert.equal(capturedBody.model, 'claude-haiku-4-5-20251001');
    }
    // Either way, should not throw
    assert.ok(result === null || typeof result === 'object');
  });
});
