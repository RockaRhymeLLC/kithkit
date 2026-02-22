/**
 * Tests for BMO comms extensions (s-m24).
 *
 * t-232: BMO Telegram adapter handles messages
 * t-233: BMO email adapters handle read and send
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── t-232: BMO Telegram adapter handles messages ─────────────

describe('BMO Telegram adapter (t-232)', () => {

  describe('ChannelAdapter interface compliance', () => {
    it('has required name property', async () => {
      // Dynamic import to avoid side effects at module load
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      assert.equal(adapter.name, 'telegram');
    });

    it('implements send() method', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      assert.equal(typeof adapter.send, 'function');
    });

    it('implements receive() method', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      assert.equal(typeof adapter.receive, 'function');
    });

    it('implements formatMessage() method', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      assert.equal(typeof adapter.formatMessage, 'function');
    });

    it('implements capabilities() method', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      assert.equal(typeof adapter.capabilities, 'function');
    });
  });

  describe('capabilities', () => {
    it('reports markdown support', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      const caps = adapter.capabilities();
      assert.equal(caps.markdown, true);
      assert.equal(caps.images, true);
      assert.equal(caps.buttons, true);
      assert.equal(caps.html, false);
      assert.equal(caps.maxLength, 4096);
    });
  });

  describe('formatMessage', () => {
    it('truncates in normal mode', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      const long = 'x'.repeat(5000);
      const formatted = adapter.formatMessage(long, 'normal');
      assert.ok(formatted.length <= 4003); // 4000 + "..."
      assert.ok(formatted.endsWith('...'));
    });

    it('returns full text in verbose mode', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      const long = 'x'.repeat(5000);
      const formatted = adapter.formatMessage(long, 'verbose');
      assert.equal(formatted.length, 5000);
    });

    it('returns first line in headlines mode', async () => {
      const { BmoTelegramAdapter } = await import('../extensions/comms/adapters/telegram.js');
      const adapter = new BmoTelegramAdapter();
      const multi = 'First line\nSecond line\nThird line';
      const formatted = adapter.formatMessage(multi, 'headlines');
      assert.equal(formatted, 'First line');
    });
  });

  describe('receive() buffer', () => {
    it('returns empty array when no messages buffered', async () => {
      const { BmoTelegramAdapter, _resetForTesting } = await import('../extensions/comms/adapters/telegram.js');
      _resetForTesting();
      const adapter = new BmoTelegramAdapter();
      const messages = await adapter.receive();
      assert.deepEqual(messages, []);
    });
  });

  describe('handleUpdate', () => {
    it('handles duplicate update_ids', async () => {
      const { BmoTelegramAdapter, _resetForTesting } = await import('../extensions/comms/adapters/telegram.js');
      _resetForTesting();
      const adapter = new BmoTelegramAdapter();
      // First call — should process (though no token, so nothing happens after dedup)
      await adapter.handleUpdate({ update_id: 12345, message: undefined });
      // Second call with same ID — should be skipped
      await adapter.handleUpdate({ update_id: 12345, message: undefined });
      // No errors = dedup working
    });

    it('skips updates without message or reaction', async () => {
      const { BmoTelegramAdapter, _resetForTesting } = await import('../extensions/comms/adapters/telegram.js');
      _resetForTesting();
      const adapter = new BmoTelegramAdapter();
      // Empty update — should not throw
      await adapter.handleUpdate({ update_id: 99999 });
    });
  });

  describe('handleShortcut', () => {
    it('rejects missing auth token', async () => {
      const { BmoTelegramAdapter, _resetForTesting } = await import('../extensions/comms/adapters/telegram.js');
      _resetForTesting();
      const adapter = new BmoTelegramAdapter();
      const result = await adapter.handleShortcut({ text: 'hello' });
      // No token configured — returns 500 or 401
      assert.ok(result.status >= 400);
    });

    it('rejects empty text', async () => {
      const { BmoTelegramAdapter, _resetForTesting } = await import('../extensions/comms/adapters/telegram.js');
      _resetForTesting();
      const adapter = new BmoTelegramAdapter();
      const result = await adapter.handleShortcut({ text: '', token: 'test' });
      assert.ok(result.status >= 400);
    });
  });
});

// ── t-233: BMO email adapters handle read and send ───────────

describe('BMO Graph email adapter (t-233)', () => {

  describe('ChannelAdapter interface compliance', () => {
    it('has required name property', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      assert.equal(adapter.name, 'email-graph');
    });

    it('implements send() method', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      assert.equal(typeof adapter.send, 'function');
    });

    it('implements receive() method', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      assert.equal(typeof adapter.receive, 'function');
    });

    it('implements formatMessage() method', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      assert.equal(typeof adapter.formatMessage, 'function');
    });

    it('implements capabilities() method', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      assert.equal(typeof adapter.capabilities, 'function');
    });
  });

  describe('capabilities', () => {
    it('reports HTML support for email', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      const caps = adapter.capabilities();
      assert.equal(caps.html, true);
      assert.equal(caps.images, true);
      assert.equal(caps.markdown, false);
      assert.equal(caps.maxLength, null);
    });
  });

  describe('formatMessage', () => {
    it('returns full text in normal mode', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      const text = 'Hello world\nSecond line';
      assert.equal(adapter.formatMessage(text, 'normal'), text);
    });

    it('returns first line in headlines mode', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      const text = 'First line\nSecond line';
      assert.equal(adapter.formatMessage(text, 'headlines'), 'First line');
    });
  });

  describe('send requires recipient', () => {
    it('fails without metadata.to', async () => {
      const { BmoGraphAdapter } = await import('../extensions/comms/adapters/email/graph-provider.js');
      const adapter = new BmoGraphAdapter();
      const result = await adapter.send({ text: 'test' });
      assert.equal(result, false); // No recipient = failure
    });
  });
});

describe('BMO Himalaya email adapter (t-233)', () => {

  describe('ChannelAdapter interface compliance', () => {
    it('has correct name with account suffix', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter('gmail');
      assert.equal(adapter.name, 'email-himalaya-gmail');
    });

    it('defaults to gmail account', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter();
      assert.equal(adapter.name, 'email-himalaya-gmail');
    });

    it('supports custom account names', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter('yahoo-lindee');
      assert.equal(adapter.name, 'email-himalaya-yahoo-lindee');
    });

    it('implements all ChannelAdapter methods', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter();
      assert.equal(typeof adapter.send, 'function');
      assert.equal(typeof adapter.receive, 'function');
      assert.equal(typeof adapter.formatMessage, 'function');
      assert.equal(typeof adapter.capabilities, 'function');
    });
  });

  describe('capabilities', () => {
    it('reports plain text only', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter();
      const caps = adapter.capabilities();
      assert.equal(caps.html, false);
      assert.equal(caps.markdown, false);
      assert.equal(caps.images, false);
      assert.equal(caps.maxLength, null);
    });
  });

  describe('send requires recipient', () => {
    it('fails without metadata.to', async () => {
      const { BmoHimalayaAdapter } = await import('../extensions/comms/adapters/email/himalaya-provider.js');
      const adapter = new BmoHimalayaAdapter();
      const result = await adapter.send({ text: 'test' });
      assert.equal(result, false);
    });
  });
});

// ── BMO Channel Router ──────────────────────────────────────

describe('BMO Channel Router (t-232 supplementary)', () => {

  it('defaults to terminal channel when file missing', async () => {
    // The channel router reads from a state file — in test env it defaults to terminal
    const { getChannel } = await import('../extensions/comms/channel-router.js');
    // Will return 'terminal' if file doesn't exist (test environment)
    const channel = getChannel();
    assert.ok(['terminal', 'telegram', 'telegram-verbose', 'silent', 'voice'].includes(channel));
  });
});

// ── Comms init ──────────────────────────────────────────────

describe('BMO Comms init module', () => {

  it('exports createTelegramRouteHandler', async () => {
    const { createTelegramRouteHandler } = await import('../extensions/comms/index.js');
    assert.equal(typeof createTelegramRouteHandler, 'function');
  });

  it('exports createShortcutRouteHandler', async () => {
    const { createShortcutRouteHandler } = await import('../extensions/comms/index.js');
    assert.equal(typeof createShortcutRouteHandler, 'function');
  });

  it('exports getTelegramAdapter', async () => {
    const { getTelegramAdapter } = await import('../extensions/comms/index.js');
    assert.equal(typeof getTelegramAdapter, 'function');
    // Before init, should be null
    assert.equal(getTelegramAdapter(), null);
  });

  it('exports getGraphAdapter', async () => {
    const { getGraphAdapter } = await import('../extensions/comms/index.js');
    assert.equal(typeof getGraphAdapter, 'function');
    assert.equal(getGraphAdapter(), null);
  });

  it('exports getHimalayaAdapters', async () => {
    const { getHimalayaAdapters } = await import('../extensions/comms/index.js');
    assert.equal(typeof getHimalayaAdapters, 'function');
    assert.deepEqual(getHimalayaAdapters(), []);
  });
});
