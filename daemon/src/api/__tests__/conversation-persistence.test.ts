/**
 * Conversation persistence tests — covers:
 * 1. Outbound flag+scope gating (captured vs excluded)
 * 2. API endpoint token gating
 * 3. Archival move logic
 * 4. Real-seam gate: drives actual channel-router routeMessage() to verify the
 *    loadConfig().features?.conversation_persistence guard in channel-router.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type http from 'node:http';
import { openDatabase, closeDatabase, _resetDbForTesting, getDatabase, insert, query } from '../../core/db.js';
import { issueToken } from '../../auth/agent-tokens.js';
import { handleConversationMessagesRoute } from '../conversation-messages.js';
import {
  routeMessage,
  registerAdapter,
  _resetForTesting as _resetChannelRouterForTesting,
} from '../../comms/channel-router.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import type { ChannelAdapter } from '../../comms/adapter.js';

// ── Test helpers ─────────────────────────────────────────────

let tmpDir: string;

function setupDb(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-convpersist-'));
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function teardownDb(): void {
  _resetDbForTesting();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body: string): void;
  _json(): unknown;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(code, headers = {}) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
    _json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}

function makeReq(opts: { token?: string }): http.IncomingMessage {
  return {
    method: 'GET',
    url: '/api/conversation-messages',
    headers: opts.token ? { 'x-agent-token': opts.token } : {},
  } as unknown as http.IncomingMessage;
}

// ── Phase 3: Outbound flag + scope gating ────────────────────

describe('conversation_messages: outbound scope gating', { concurrency: 1 }, () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('comms-agent reply on telegram IS captured', () => {
    // Simulate what channel-router does when sender_agent=comms AND flag is enabled
    insert('conversation_messages', {
      direction: 'outbound',
      channel: 'telegram',
      sender: 'agent',
      text: 'Here is the deploy status...',
      metadata: JSON.stringify({ sender_agent: 'comms', recipients: [] }),
    });

    const rows = query<{ direction: string }>(
      "SELECT * FROM conversation_messages WHERE direction='outbound' AND channel='telegram'",
    );
    assert.equal(rows.length, 1);
  });

  // The following tests verify the channel-router predicate logic directly.
  // channel-router.ts captures only when: featureEnabled AND (channel=teams|telegram) AND sender_agent=comms
  function evalPredicate(featureEnabled: boolean, channelName: string, senderAgent: string): boolean {
    return (
      featureEnabled &&
      (channelName === 'teams' || channelName === 'telegram') &&
      senderAgent === 'comms'
    );
  }

  it('digest message (sender_agent=daemon) is NOT captured', () => {
    assert.equal(
      evalPredicate(true, 'telegram', 'daemon'),
      false,
      'daemon sender_agent must not be captured',
    );
  });

  it('unknown sender_agent (in-process scheduler) is NOT captured', () => {
    assert.equal(
      evalPredicate(true, 'telegram', 'unknown'),
      false,
      'unknown sender_agent must not be captured',
    );
  });

  it('email channel is NOT captured even if sender_agent=comms', () => {
    assert.equal(
      evalPredicate(true, 'email', 'comms'),
      false,
      'email channel must not be captured',
    );
  });

  it('feature flag disabled suppresses capture', () => {
    assert.equal(
      evalPredicate(false, 'telegram', 'comms'),
      false,
      'disabled feature flag must suppress capture',
    );
  });

  it('comms + telegram qualifies', () => {
    assert.equal(evalPredicate(true, 'telegram', 'comms'), true);
  });

  it('comms + teams qualifies', () => {
    assert.equal(evalPredicate(true, 'teams', 'comms'), true);
  });
});

// ── Phase 5: Archival move ────────────────────────────────────

describe('conversation_messages: archival move', { concurrency: 1 }, () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('rows older than retention_days are moved to archive', () => {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO conversation_messages (direction, channel, sender, text, ts)
      VALUES ('inbound', 'telegram', 'user', 'old message', datetime('now', '-91 days'))
    `).run();
    db.prepare(`
      INSERT INTO conversation_messages (direction, channel, sender, text, ts)
      VALUES ('inbound', 'telegram', 'user', 'recent message', datetime('now', '-1 day'))
    `).run();

    const retentionDays = 90;
    const retentionParam = `-${retentionDays} days`;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO conversation_messages_archive
          (id, direction, channel, sender, recipient, text, ts, chat_id, message_id, metadata, sys_created)
        SELECT id, direction, channel, sender, recipient, text, ts, chat_id, message_id, metadata, sys_created
        FROM conversation_messages
        WHERE ts < datetime('now', ?)
      `).run(retentionParam);

      db.prepare(`
        DELETE FROM conversation_messages
        WHERE ts < datetime('now', ?)
      `).run(retentionParam);
    })();

    const liveRows = query<{ text: string }>('SELECT * FROM conversation_messages');
    assert.equal(liveRows.length, 1);
    assert.equal(liveRows[0].text, 'recent message');

    const archiveRows = query<{ text: string }>('SELECT * FROM conversation_messages_archive');
    assert.equal(archiveRows.length, 1);
    assert.equal(archiveRows[0].text, 'old message');
  });
});

// ── API endpoint: token gating ────────────────────────────────

describe('GET /api/conversation-messages: token gating', { concurrency: 1 }, () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  it('returns 401 with no token', async () => {
    const req = makeReq({ token: undefined });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 401);
    const body = res._json() as { error: string };
    assert.ok(body.error.includes('X-Agent-Token'));
  });

  it('returns 401 with invalid token', async () => {
    const req = makeReq({ token: 'not-a-real-token' });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 for worker role', async () => {
    const token = issueToken('worker', { jobId: 'job-1' });
    const req = makeReq({ token });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 403);
  });

  it('returns 403 for orchestrator role', async () => {
    const token = issueToken('orchestrator');
    const req = makeReq({ token });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 403);
  });

  it('returns 200 with rows for comms role', async () => {
    insert('conversation_messages', {
      direction: 'inbound',
      channel: 'telegram',
      sender: 'user',
      text: 'Hello from test',
    });

    const token = issueToken('comms');
    const req = makeReq({ token });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 200);
    const body = res._json() as { rows: unknown[]; count: number };
    assert.equal(body.count, 1);
    assert.equal(body.rows.length, 1);
  });

  it('returns 200 with rows for daemon role', async () => {
    insert('conversation_messages', {
      direction: 'outbound',
      channel: 'teams',
      sender: 'agent',
      text: 'Agent reply',
    });

    const token = issueToken('daemon');
    const req = makeReq({ token });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams(),
    );
    assert.equal(res.statusCode, 200);
    const body = res._json() as { rows: unknown[]; count: number };
    assert.ok(body.count >= 1);
  });

  it('filters by direction param', async () => {
    insert('conversation_messages', { direction: 'inbound', channel: 'telegram', sender: 'user', text: 'in' });
    insert('conversation_messages', { direction: 'outbound', channel: 'telegram', sender: 'agent', text: 'out' });

    const token = issueToken('comms');
    const req = makeReq({ token });
    const res = makeRes();
    await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/conversation-messages',
      new URLSearchParams({ direction: 'inbound' }),
    );
    assert.equal(res.statusCode, 200);
    const body = res._json() as { rows: Array<{ direction: string }> };
    assert.ok(body.rows.every(r => r.direction === 'inbound'));
  });

  it('returns false for unrelated pathname', async () => {
    const req = makeReq({});
    const res = makeRes();
    const handled = await handleConversationMessagesRoute(
      req,
      res as unknown as http.ServerResponse,
      '/api/other',
      new URLSearchParams(),
    );
    assert.equal(handled, false);
  });
});

// ── Real-seam gate: drives the ACTUAL channel-router code path ────────
//
// R2 concern: the tests above re-implement the predicate locally (evalPredicate)
// so they don't catch a deleted/bypassed gate in channel-router.ts itself.
// These tests import and exercise routeMessage() directly — no re-implementation.
// MUTATION-KILL PROOF: temporarily remove the `if (loadConfig().features?.conversation_persistence)`
// guard in channel-router.ts and the "flag OFF → 0 rows" test goes RED.

/** Build a minimal stub adapter that records send calls but returns true. */
function makeStubAdapter(channelName: string): ChannelAdapter & { sends: number } {
  return {
    name: channelName,
    sends: 0,
    async send() { this.sends++; return true; },
    async receive() { return []; },
    formatMessage(text) { return text; },
    capabilities() {
      return { markdown: false, images: false, buttons: false, html: false, maxLength: null };
    },
  };
}

describe('channel-router: real-seam conversation_persistence gate', { concurrency: 1 }, () => {
  let seamDir: string;

  beforeEach(() => {
    seamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-cr-seam-'));
    _resetDbForTesting();
    openDatabase(seamDir, path.join(seamDir, 'test.db'));
    _resetChannelRouterForTesting();
    _resetConfigForTesting();
  });

  afterEach(() => {
    _resetChannelRouterForTesting();
    _resetConfigForTesting();
    closeDatabase();
    _resetDbForTesting();
    fs.rmSync(seamDir, { recursive: true, force: true });
  });

  it('flag OFF (default) → routeMessage persists 0 rows to conversation_messages', async () => {
    // No features.conversation_persistence in config → defaults to false/absent
    fs.writeFileSync(
      path.join(seamDir, 'kithkit.config.yaml'),
      'agent:\n  name: TestAgent\n',
    );
    loadConfig(seamDir);

    const stub = makeStubAdapter('telegram');
    registerAdapter(stub);

    await routeMessage(
      { text: 'hello from comms', metadata: { sender_agent: 'comms', recipients: [] } },
      ['telegram'],
    );

    const rows = query<{ id: number }>('SELECT id FROM conversation_messages');
    assert.equal(rows.length, 0, 'flag=OFF: gate must suppress persistence; 0 rows expected');
  });

  it('flag ON + comms/telegram message → routeMessage persists exactly 1 row', async () => {
    fs.writeFileSync(
      path.join(seamDir, 'kithkit.config.yaml'),
      [
        'agent:',
        '  name: TestAgent',
        'features:',
        '  conversation_persistence: true',
      ].join('\n'),
    );
    loadConfig(seamDir);

    const stub = makeStubAdapter('telegram');
    registerAdapter(stub);

    await routeMessage(
      { text: 'hello from comms', metadata: { sender_agent: 'comms', recipients: [] } },
      ['telegram'],
    );

    const rows = query<{ direction: string; channel: string }>('SELECT direction, channel FROM conversation_messages');
    assert.equal(rows.length, 1, 'flag=ON: exactly 1 row must be persisted');
    assert.equal(rows[0]!.direction, 'outbound');
    assert.equal(rows[0]!.channel, 'telegram');
  });
});
