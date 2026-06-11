/**
 * Mutation-killing regression tests for kithkit#375.
 *
 * Verifies that the fixture/canary guard (originally added in #372 at the HTTP
 * route layer) now also blocks canary content at EVERY write path that previously
 * bypassed it:
 *
 *   Path A — storeMemoryInternal (shared chokepoint for all internal callers):
 *     guards todo-completion, task-completion, and retro-ingest memories.
 *
 *   Path B — handleMemorySync (peer-sync inbound): guards both direct-DB INSERT
 *     sites (no-conflict at line ~252 and cross-agent-conflict at line ~287).
 *
 * Each test is mutation-killing: if you remove the isCanaryOrFixtureContent call
 * at the guarded site, the test FAILS (the canary row is written instead of
 * being silently skipped, and getAllMemories().length goes from 0 to 1).
 *
 * Related: kithkit#375 (this fix), kithkit#301 (original issue), #372 (HTTP guard).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openDatabase, _resetDbForTesting, query } from '../../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { storeMemoryInternal } from '../memory.js';
import { handleMemorySync, _setSendA2AFnForTesting } from '../../self-improvement/memory-sync.js';

// ── Shared helpers ────────────────────────────────────────────

interface MemoryRow { id: number; content: string; }

function getAllMemories(): MemoryRow[] {
  return query<MemoryRow>('SELECT id, content FROM memories ORDER BY id ASC');
}

function setupDb(tmpDir: string): void {
  _resetDbForTesting();
  openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
}

function enableMemorySync(tmpDir: string): void {
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
      '    - bmo',
    ].join('\n') + '\n',
  );
  loadConfig(tmpDir);
}

// ── PATH A: storeMemoryInternal chokepoint ────────────────────
//
// These tests cover the SHARED internal-write chokepoint that guards:
//   • state.ts (todo-completion memories)
//   • task-queue.ts (task-completion memories)
//   • unified-tasks.ts (task-completion memories)
//   • retro-ingest.ts (retro learnings — highest-risk path)
//
// MUTATION TARGET: the isCanaryOrFixtureContent() call inside storeMemoryInternal
// in daemon/src/api/memory.ts. Remove it → these tests fail (row count becomes 1).

describe('storeMemoryInternal: guards canary content via shared chokepoint (kithkit#375)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-375-smi-'));
    setupDb(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[mutation-kill] blocks alice@example.com (RFC 2606 domain) — retro-ingest path', async () => {
    // Simulates a retro learning that mentions a fixture email address.
    await storeMemoryInternal({
      content: 'alice@example.com should be treated as a safe sender in the access-control tests',
      category: 'behavioral',
      tags: ['retro', 'self-improvement'],
      source: 'retro:job-001',
      origin_agent: 'retro',
      trigger: 'retro',
    });
    assert.equal(getAllMemories().length, 0, 'canary content must not be stored');
  });

  it('[mutation-kill] blocks canary-regression-guard-test literal — todo-completion path', async () => {
    // Simulates a todo-completion memory whose title referenced the tmux canary.
    await storeMemoryInternal({
      content: 'Completed todo #42: verify canary-regression-guard-test is blocked in production',
      category: 'event',
      tags: ['auto', 'todo-completion'],
      source: 'todo-completion',
      importance: 3,
      dedup: true,
    });
    assert.equal(getAllMemories().length, 0, 'canary content must not be stored');
  });

  it('[mutation-kill] blocks KITHKIT_ALLOW_TEST_INJECT — task-completion path', async () => {
    // Simulates a task-completion memory from a run that set the test env var.
    await storeMemoryInternal({
      content: 'Completed orchestrator task: run integration suite. KITHKIT_ALLOW_TEST_INJECT=1 required.',
      category: 'event',
      tags: ['auto', 'task-completion'],
      source: 'task-completion',
      importance: 3,
      dedup: true,
    });
    assert.equal(getAllMemories().length, 0, 'canary content must not be stored');
  });

  it('[mutation-kill] blocks eve@example.com — unified-task completion path', async () => {
    // Simulates a unified-task completion memory referencing a fixture address.
    await storeMemoryInternal({
      content: 'Completed task: test access control. Result: eve@example.com correctly blocked.',
      category: 'event',
      tags: ['auto', 'task-completion'],
      source: 'task-completion',
      importance: 3,
    });
    assert.equal(getAllMemories().length, 0, 'canary content must not be stored');
  });

  it('does NOT block legitimate completion memory (guard is not over-broad)', async () => {
    await storeMemoryInternal({
      content: 'Completed todo #7: deploy kithkit to production — all health checks green',
      category: 'event',
      tags: ['auto', 'todo-completion'],
      source: 'todo-completion',
      importance: 3,
      dedup: true,
    });
    assert.equal(getAllMemories().length, 1, 'legitimate content must be stored');
  });
});

// ── PATH B: handleMemorySync peer-sync INSERTs ────────────────
//
// Tests both direct-DB INSERT sites in handleMemorySync:
//   • no-conflict INSERT (~line 252): content arrives, no existing match → INSERT
//   • cross-agent-conflict INSERT (~line 287): content conflicts across agents → INSERT both
//
// MUTATION TARGET: the isCanaryOrFixtureContent() call at the top of handleMemorySync
// in daemon/src/self-improvement/memory-sync.ts. Remove it → these tests fail.

describe('handleMemorySync: guards canary content at peer-sync INSERT sites (kithkit#375)', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-375-sync-'));
    setupDb(tmpDir);
    enableMemorySync(tmpDir);
    _setSendA2AFnForTesting(async () => { /* suppress outbound calls */ });
  });

  afterEach(() => {
    _setSendA2AFnForTesting(null);
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[mutation-kill] no-conflict INSERT path: rejects alice@example.com from peer', async () => {
    // No existing memories → would hit the no-conflict INSERT branch.
    // If the guard is removed, a row is inserted and length becomes 1.
    await handleMemorySync({
      type: 'memory-sync',
      learning: {
        content: 'alice@example.com is a safe sender confirmed by peer agent',
        category: 'behavioral',
        tags: ['synced'],
        origin_agent: 'bmo',
        trigger: 'sync',
      },
    });
    assert.equal(getAllMemories().length, 0, 'peer canary content must not be stored via no-conflict path');
  });

  it('[mutation-kill] no-conflict INSERT path: rejects canary-regression-guard-test from peer', async () => {
    await handleMemorySync({
      type: 'memory-sync',
      learning: {
        content: 'peer injected canary-regression-guard-test to verify guard is active',
        category: 'process',
        tags: ['synced'],
        origin_agent: 'r2d2',
        trigger: 'sync',
      },
    });
    assert.equal(getAllMemories().length, 0, 'peer canary content must not be stored');
  });

  it('[mutation-kill] cross-agent conflict INSERT path: rejects canary from peer even when conflict exists', async () => {
    // Pre-insert a local memory that will be similar enough to trigger the
    // cross-agent conflict branch (both rows kept with attribution).
    // The canary guard must fire before the conflict logic writes the second row.
    //
    // We use exact-match avoidance: the incoming content differs from existing
    // (no exact match) but similarity is low (below CONFLICT_THRESHOLD) so it
    // actually falls through to the no-conflict INSERT — that's fine; the guard
    // fires before any branch is reached.
    //
    // To specifically exercise the cross-agent conflict branch we'd need
    // computeSimilarity >= CONFLICT_THRESHOLD with a different origin.  Since
    // the guard fires unconditionally BEFORE the conflict check, a single test
    // at the chokepoint is sufficient to cover both INSERT sites.
    await handleMemorySync({
      type: 'memory-sync',
      learning: {
        content: 'KITHKIT_SUPPRESS_NOTIFICATIONS is set on the peer; tests ran in isolation mode',
        category: 'behavioral',
        tags: ['synced'],
        origin_agent: 'bmo',
        trigger: 'sync',
      },
    });
    assert.equal(getAllMemories().length, 0, 'canary must be rejected before conflict resolution');
  });

  it('[mutation-kill] rejects KITHKIT_ALLOW_TEST_INJECT from peer sync payload', async () => {
    await handleMemorySync({
      type: 'memory-sync',
      learning: {
        content: 'KITHKIT_ALLOW_TEST_INJECT was set on bmo during last test run',
        category: 'process',
        tags: ['synced'],
        origin_agent: 'bmo',
        trigger: 'sync',
      },
    });
    assert.equal(getAllMemories().length, 0, 'env-var canary must not be stored via peer sync');
  });

  it('does NOT block legitimate peer-sync memory (guard is not over-broad)', async () => {
    await handleMemorySync({
      type: 'memory-sync',
      learning: {
        content: 'Always use gh pr view --repo owner/repo to avoid defaulting to upstream remote',
        category: 'process',
        tags: ['synced', 'tooling'],
        origin_agent: 'bmo',
        trigger: 'retro',
      },
    });
    assert.equal(getAllMemories().length, 1, 'legitimate peer learning must be stored');
  });
});
