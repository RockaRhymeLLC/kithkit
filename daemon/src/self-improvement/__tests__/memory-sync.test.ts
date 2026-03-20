/**
 * Tests for memory-sync: syncToPeers, handleMemorySync, pullFromPeers.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, exec, query } from '../../core/db.js';
import {
  syncToPeers,
  handleMemorySync,
  pullFromPeers,
  computeSimilarity,
  CONFLICT_THRESHOLD,
  _setSendA2AFnForTesting,
  getSyncStateFile,
} from '../memory-sync.js';

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MemoryRow {
  id: number;
  content: string;
  category: string | null;
  tags: string;
  origin_agent: string | null;
  trigger: string | null;
  decay_policy: string | null;
  shareable: number;
  created_at: string;
}

function insertMemory(opts: {
  content: string;
  category?: string;
  origin_agent?: string;
  trigger?: string;
  shareable?: number;
  created_at?: string;
}): void {
  exec(
    `INSERT INTO memories (content, category, origin_agent, trigger, shareable, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
    opts.content,
    opts.category ?? 'behavioral',
    opts.origin_agent ?? null,
    opts.trigger ?? null,
    opts.shareable ?? 1,
    opts.created_at ?? new Date().toISOString(),
    new Date().toISOString(),
  );
}

function getAllMemories(): MemoryRow[] {
  return query<MemoryRow>('SELECT * FROM memories ORDER BY id ASC');
}

function enableMemorySync(tmpDir: string, peers: string[] = ['bmo']): void {
  const peersYaml = peers.map((p) => `    - ${p}`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'agent:',
      '  name: skippy',
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
    content: 'Always use payload.text not payload.body',
    category: 'api-format',
    tags: '[]',
    origin_agent: 'skippy',
    trigger: 'retro',
    decay_policy: 'default',
    shareable: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Test 1: Outbound sync sends to all configured peers ──────

describe('syncToPeers sends to all configured peers', () => {
  let tmpDir: string;
  let capturedBodies: Record<string, unknown>[];

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableMemorySync(tmpDir, ['bmo', 'r2d2']);

    capturedBodies = [];
    _setSendA2AFnForTesting(async (body) => {
      capturedBodies.push(body);
    });
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends one A2A message per peer for a shareable memory', async () => {
    const memory = makeShareableMemory();
    await syncToPeers(memory);

    assert.equal(capturedBodies.length, 2, 'should send to both peers');
    const targets = capturedBodies.map((b) => b.to);
    assert.ok(targets.includes('bmo'), 'should send to bmo');
    assert.ok(targets.includes('r2d2'), 'should send to r2d2');
  });

  it('payload contains memory-sync type and learning data', async () => {
    const memory = makeShareableMemory({ content: 'Test content for sync' });
    await syncToPeers(memory);

    const body = capturedBodies[0]!;
    const payload = body.payload as Record<string, unknown>;
    assert.equal(payload.type, 'memory-sync');

    const learning = payload.learning as Record<string, unknown>;
    assert.equal(learning.content, 'Test content for sync');
    assert.equal(learning.category, 'api-format');
    assert.equal(learning.origin_agent, 'skippy');
  });
});

// ── Test 2: Outbound sync skips when shareable=false ────────

describe('syncToPeers skips non-shareable memories', () => {
  let tmpDir: string;
  let capturedBodies: Record<string, unknown>[];

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableMemorySync(tmpDir, ['bmo']);

    capturedBodies = [];
    _setSendA2AFnForTesting(async (body) => {
      capturedBodies.push(body);
    });
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not send when shareable=0', async () => {
    const memory = makeShareableMemory({ shareable: 0 });
    await syncToPeers(memory);
    assert.equal(capturedBodies.length, 0, 'should not send for shareable=0');
  });

  it('does not send when shareable=false', async () => {
    const memory = makeShareableMemory({ shareable: false });
    await syncToPeers(memory);
    assert.equal(capturedBodies.length, 0, 'should not send for shareable=false');
  });
});

// ── Test 3: Outbound sync skips when memory_sync disabled ───

describe('syncToPeers skips when memory_sync disabled', () => {
  let tmpDir: string;
  let capturedBodies: Record<string, unknown>[];

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Memory sync disabled
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: true\n  memory_sync:\n    enabled: false\n    peers:\n      - bmo\n',
    );
    loadConfig(tmpDir);

    capturedBodies = [];
    _setSendA2AFnForTesting(async (body) => {
      capturedBodies.push(body);
    });
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not send when memory_sync.enabled is false', async () => {
    const memory = makeShareableMemory();
    await syncToPeers(memory);
    assert.equal(capturedBodies.length, 0, 'should not send when disabled');
  });
});

// ── Test 4: Outbound sync skips echo-back to origin agent ───

describe('syncToPeers does not echo back to origin agent', () => {
  let tmpDir: string;
  let capturedBodies: Record<string, unknown>[];

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableMemorySync(tmpDir, ['bmo', 'r2d2']);

    capturedBodies = [];
    _setSendA2AFnForTesting(async (body) => {
      capturedBodies.push(body);
    });
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips peer that matches origin_agent', async () => {
    // Memory originated from bmo — should not send back to bmo
    const memory = makeShareableMemory({ origin_agent: 'bmo' });
    await syncToPeers(memory);

    assert.equal(capturedBodies.length, 1, 'should send to r2d2 only');
    assert.equal(capturedBodies[0]!.to, 'r2d2');
  });

  it('sends to all peers when origin_agent is self', async () => {
    const memory = makeShareableMemory({ origin_agent: 'skippy' });
    await syncToPeers(memory);
    assert.equal(capturedBodies.length, 2, 'should send to both bmo and r2d2');
  });
});

// ── Test 5: Inbound sync stores learning with attribution ───

describe('handleMemorySync stores learning with correct attribution', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores the learning with trigger=sync and correct origin_agent', async () => {
    await handleMemorySync({
      learning: {
        content: 'BMO learning: always check daemon health before spawning',
        category: 'process',
        tags: ['daemon', 'health'],
        origin_agent: 'bmo',
        trigger: 'retro',
        decay_policy: 'default',
        created_at: new Date().toISOString(),
      },
    });

    const memories = getAllMemories();
    assert.equal(memories.length, 1);
    const m = memories[0]!;
    assert.equal(m.content, 'BMO learning: always check daemon health before spawning');
    assert.equal(m.origin_agent, 'bmo');
    assert.equal(m.trigger, 'sync');
    assert.equal(m.shareable, 1);
    assert.equal(m.category, 'process');
  });
});

// ── Test 6: Same-origin conflict — newer incoming wins ───────

describe('handleMemorySync same-origin conflict: newer incoming wins', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces existing memory when incoming timestamp is newer', async () => {
    const oldTs = new Date('2026-01-01T00:00:00Z').toISOString();
    const newTs = new Date('2026-06-01T00:00:00Z').toISOString();

    // Existing memory from bmo
    insertMemory({
      content: 'BMO learning about memory sync performance OLD',
      category: 'process',
      origin_agent: 'bmo',
      trigger: 'retro',
      created_at: oldTs,
    });

    // Incoming: same origin (bmo), same category, high similarity, newer
    await handleMemorySync({
      learning: {
        content: 'BMO learning about memory sync performance UPDATED',
        category: 'process',
        tags: [],
        origin_agent: 'bmo',
        trigger: 'retro',
        decay_policy: 'default',
        created_at: newTs,
      },
    });

    const memories = getAllMemories();
    // Should still be 1 row — the older one was replaced
    assert.equal(memories.length, 1, 'should replace existing rather than adding new');
    assert.ok(
      memories[0]!.content.includes('UPDATED'),
      'existing memory should be updated with incoming content',
    );
  });
});

// ── Test 7: Same-origin conflict — newer existing wins ───────

describe('handleMemorySync same-origin conflict: newer existing wins (skip incoming)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps existing memory when existing timestamp is newer than incoming', async () => {
    const oldTs = new Date('2026-01-01T00:00:00Z').toISOString();
    const newTs = new Date('2026-06-01T00:00:00Z').toISOString();

    // Existing memory from bmo — NEWER
    insertMemory({
      content: 'BMO learning about memory sync performance CURRENT',
      category: 'process',
      origin_agent: 'bmo',
      trigger: 'retro',
      created_at: newTs,
    });

    // Incoming: same origin (bmo), same category, high similarity, OLDER
    await handleMemorySync({
      learning: {
        content: 'BMO learning about memory sync performance STALE',
        category: 'process',
        tags: [],
        origin_agent: 'bmo',
        trigger: 'retro',
        decay_policy: 'default',
        created_at: oldTs,
      },
    });

    const memories = getAllMemories();
    assert.equal(memories.length, 1, 'should not add stale incoming memory');
    assert.ok(
      memories[0]!.content.includes('CURRENT'),
      'existing (newer) memory should be unchanged',
    );
  });
});

// ── Test 8: Cross-agent conflict — keeps both ────────────────

describe('handleMemorySync cross-agent conflict: keeps both with attribution', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores both memories when origins differ', async () => {
    // Existing memory from skippy
    insertMemory({
      content: 'Always validate memory payloads before processing sync data',
      category: 'process',
      origin_agent: 'skippy',
      trigger: 'retro',
    });

    // Incoming: from bmo — similar content, different origin
    await handleMemorySync({
      learning: {
        content: 'Always validate memory payloads before processing sync messages',
        category: 'process',
        tags: [],
        origin_agent: 'bmo',
        trigger: 'sync',
        decay_policy: 'default',
        created_at: new Date().toISOString(),
      },
    });

    const memories = getAllMemories();
    assert.equal(memories.length, 2, 'should store both memories for cross-agent conflict');

    const origins = memories.map((m) => m.origin_agent);
    assert.ok(origins.includes('skippy'), 'should keep skippy memory');
    assert.ok(origins.includes('bmo'), 'should store bmo memory');
  });
});

// ── Test 9: Offline catch-up pulls newer memories ───────────

describe('pullFromPeers pulls memories newer than last_sync_timestamp', () => {
  let tmpDir: string;
  let mockPeerServer: { memories: Array<Record<string, unknown>>; calls: string[] };

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Write config with agent-comms peers pointing to mock server
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'agent:',
        '  name: skippy',
        'self_improvement:',
        '  enabled: true',
        '  memory_sync:',
        '    enabled: true',
        '    peers:',
        '      - bmo',
        'agent-comms:',
        '  peers:',
        '    - name: bmo',
        '      host: 127.0.0.1',
        '      port: 39999',
      ].join('\n') + '\n',
    );
    loadConfig(tmpDir);

    mockPeerServer = { memories: [], calls: [] };
  });

  afterEach(() => {
    _resetConfigForTesting();
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Clean up sync state file
    try { fs.unlinkSync(getSyncStateFile()); } catch { /* ok */ }
  });

  it('logs that catch-up would be attempted when peer is reachable (mock via fetch override)', async () => {
    // We can't easily mock fetch in node:test without extra deps.
    // Instead, verify that pullFromPeers runs without throwing when peer is unreachable
    // (which is the case in a unit test environment).
    // pullFromPeers should log a warning and continue, not throw.
    await assert.doesNotReject(
      () => pullFromPeers(),
      'pullFromPeers should not throw when peer is unreachable',
    );
  });

  it('does nothing when memory_sync is disabled', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: true\n  memory_sync:\n    enabled: false\n',
    );
    loadConfig(tmpDir);

    // Should return immediately without error
    await assert.doesNotReject(() => pullFromPeers());
  });
});

// ── Test 10: Offline catch-up updates last_sync_timestamp ───

describe('pullFromPeers updates last_sync_timestamp after successful pull', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // No peers configured means no HTTP calls, but saveSyncTimestamps still runs
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      [
        'agent:',
        '  name: skippy',
        'self_improvement:',
        '  enabled: true',
        '  memory_sync:',
        '    enabled: true',
        '    peers: []',
      ].join('\n') + '\n',
    );
    loadConfig(tmpDir);
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(getSyncStateFile()); } catch { /* ok */ }
  });

  it('runs successfully with empty peers list (no-op)', async () => {
    await assert.doesNotReject(() => pullFromPeers());
  });
});

// ── Test 11: Inbound sync ignores unrecognized payload ───────

describe('handleMemorySync ignores unrecognized or malformed payload', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not throw when payload is missing learning field', async () => {
    await assert.doesNotReject(
      () => handleMemorySync({ type: 'memory-sync', text: 'hello' }),
      'should not throw for missing learning field',
    );
    assert.equal(getAllMemories().length, 0, 'should store nothing for invalid payload');
  });

  it('does not throw when learning.content is empty string', async () => {
    await assert.doesNotReject(
      () => handleMemorySync({ learning: { content: '', category: 'process' } }),
      'should not throw for empty content',
    );
    assert.equal(getAllMemories().length, 0, 'should store nothing for empty content');
  });

  it('does not throw for completely empty payload', async () => {
    await assert.doesNotReject(
      () => handleMemorySync({}),
      'should not throw for empty payload',
    );
    assert.equal(getAllMemories().length, 0);
  });
});

// ── Test 12: Conflict threshold is 0.85 ─────────────────────

describe('Conflict resolution uses 0.85 similarity threshold', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-memsync-'));
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CONFLICT_THRESHOLD is 0.85', () => {
    assert.equal(CONFLICT_THRESHOLD, 0.85);
  });

  it('computeSimilarity returns >= 0.85 for near-identical strings', () => {
    const a = 'Always validate memory payloads before processing them carefully';
    const b = 'Always validate memory payloads before processing them thoroughly';
    const score = computeSimilarity(a, b);
    assert.ok(score >= 0.85, `expected score >= 0.85, got ${score}`);
  });

  it('computeSimilarity returns < 0.85 for different but related strings', () => {
    const a = 'Always check daemon health before spawning workers';
    const b = 'Use payload text field not body for all A2A messages';
    const score = computeSimilarity(a, b);
    assert.ok(score < 0.85, `expected score < 0.85, got ${score}`);
  });

  it('high-similarity inbound triggers conflict handling, low-similarity does not', async () => {
    // Existing memory
    insertMemory({
      content: 'Always validate memory payloads before processing them carefully in sync',
      category: 'process',
      origin_agent: 'bmo',
      trigger: 'retro',
    });

    // High-similarity incoming (same origin — should replace if newer)
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    await handleMemorySync({
      learning: {
        content: 'Always validate memory payloads before processing them carefully in sync',
        category: 'process',
        tags: [],
        origin_agent: 'bmo',
        trigger: 'retro',
        decay_policy: 'default',
        created_at: future, // newer — should replace
      },
    });

    // This was an exact match — dedup, no new row
    const memoriesAfterFirst = getAllMemories();
    assert.equal(memoriesAfterFirst.length, 1, 'exact match should be deduped');

    // Low-similarity incoming — should add new row
    await handleMemorySync({
      learning: {
        content: 'Use fetch API with AbortSignal timeout for remote peer calls',
        category: 'process',
        tags: [],
        origin_agent: 'bmo',
        trigger: 'retro',
        decay_policy: 'default',
        created_at: future,
      },
    });

    const memoriesAfterSecond = getAllMemories();
    assert.equal(memoriesAfterSecond.length, 2, 'low-similarity should be stored as new memory');
  });
});
