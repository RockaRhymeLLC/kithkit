/**
 * Tests for retro-ingest: parseRetroLearnings and ingestRetroResult.
 *
 * Covers the previously-missing ingestion step of the retro feedback loop:
 * retro worker JSON output → memories table → visible to pre-task injection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, query } from '../../core/db.js';
import { parseRetroLearnings, ingestRetroResult, backfillRetroLearnings } from '../retro-ingest.js';
import { exec } from '../../core/db.js';
import type { JobRecord } from '../../agents/lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'retro-job-0001',
    agent_id: 'retro-job-0001',
    profile: 'retro',
    prompt: 'analyze task',
    status: 'completed',
    result: null,
    error: null,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    spawned_by: 'orchestrator',
    spawner_notified_at: null,
    ...overrides,
  };
}

const VALID_JSON_RESULT = JSON.stringify({
  learnings: [
    { content: 'POST /api/a2a/send uses field text not body', category: 'api-format', tags: ['retro', 'self-improvement'] },
    { content: 'Always check daemon health before spawning workers', category: 'behavioral', tags: ['retro', 'self-improvement'] },
  ],
  skipped: [],
});

function enableRetro(tmpDir: string, extra: string[] = []): void {
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'self_improvement:',
      '  enabled: true',
      '  retro:',
      '    enabled: true',
      ...extra,
    ].join('\n') + '\n',
  );
  loadConfig(tmpDir);
}

interface MemRow {
  content: string;
  category: string | null;
  tags: string;
  source: string | null;
  origin_agent: string | null;
  trigger: string | null;
}

function getStoredMemories(): MemRow[] {
  return query<MemRow>('SELECT content, category, tags, source, origin_agent, trigger FROM memories ORDER BY id ASC');
}

// ── parseRetroLearnings ───────────────────────────────────────

describe('parseRetroLearnings', () => {
  it('parses a clean JSON object', () => {
    const learnings = parseRetroLearnings(VALID_JSON_RESULT);
    assert.equal(learnings.length, 2);
    assert.equal(learnings[0]!.category, 'api-format');
    assert.ok(learnings[0]!.content.includes('text not body'));
  });

  it('parses JSON inside a fenced code block with surrounding prose', () => {
    const text = [
      'Here is my analysis of the task.',
      '',
      '```json',
      VALID_JSON_RESULT,
      '```',
      '',
      'Let me know if you need more.',
    ].join('\n');
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 2);
  });

  it('parses JSON embedded in prose without fences', () => {
    const text = `Analysis complete. ${VALID_JSON_RESULT} End of report.`;
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 2);
  });

  it('returns empty array for non-JSON text', () => {
    assert.deepEqual(parseRetroLearnings('no learnings found, task was clean'), []);
  });

  it('returns empty array when learnings key is missing or not an array', () => {
    assert.deepEqual(parseRetroLearnings('{"skipped": []}'), []);
    assert.deepEqual(parseRetroLearnings('{"learnings": "none"}'), []);
  });

  it('skips learnings with invalid category but keeps valid siblings', () => {
    const text = JSON.stringify({
      learnings: [
        { content: 'Valid learning', category: 'process', tags: [] },
        { content: 'Bad category', category: 'random-category', tags: [] },
        { content: 'Missing category', tags: [] },
      ],
    });
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0]!.content, 'Valid learning');
  });

  it('skips learnings with empty content', () => {
    const text = JSON.stringify({
      learnings: [
        { content: '   ', category: 'process', tags: [] },
        { content: 'Real one', category: 'tool-usage', tags: [] },
      ],
    });
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0]!.category, 'tool-usage');
  });

  it('always includes retro/self-improvement tags and merges provided ones', () => {
    const text = JSON.stringify({
      learnings: [{ content: 'Tagged learning', category: 'communication', tags: ['custom-tag'] }],
    });
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 1);
    assert.ok(learnings[0]!.tags.includes('retro'));
    assert.ok(learnings[0]!.tags.includes('self-improvement'));
    assert.ok(learnings[0]!.tags.includes('custom-tag'));
  });

  it('truncates overlong content', () => {
    const long = 'x'.repeat(2000);
    const text = JSON.stringify({
      learnings: [{ content: long, category: 'process', tags: [] }],
    });
    const learnings = parseRetroLearnings(text);
    assert.equal(learnings.length, 1);
    assert.ok(learnings[0]!.content.length <= 500);
  });
});

// ── ingestRetroResult ─────────────────────────────────────────

describe('ingestRetroResult', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-ingest-'));
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableRetro(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores parsed learnings as memories with retro provenance', async () => {
    const stored = await ingestRetroResult(makeJob({ result: VALID_JSON_RESULT }));
    assert.equal(stored, 2);

    const memories = getStoredMemories();
    assert.equal(memories.length, 2);
    assert.equal(memories[0]!.category, 'api-format');
    assert.equal(memories[0]!.source, 'retro:retro-job-0001');
    assert.equal(memories[0]!.origin_agent, 'retro');
    // trigger='retro' is what /api/self-improvement/stats counts learnings by —
    // without it the ingested learnings are invisible to the stats surface.
    assert.equal(memories[0]!.trigger, 'retro');
    const tags = JSON.parse(memories[0]!.tags) as string[];
    assert.ok(tags.includes('retro'));
    assert.ok(tags.includes('self-improvement'));
  });

  it('accepts the retro-light profile too', async () => {
    const stored = await ingestRetroResult(makeJob({ profile: 'retro-light', result: VALID_JSON_RESULT }));
    assert.equal(stored, 2);
  });

  it('ignores non-retro profiles', async () => {
    const stored = await ingestRetroResult(makeJob({ profile: 'coding', result: VALID_JSON_RESULT }));
    assert.equal(stored, 0);
    assert.equal(getStoredMemories().length, 0);
  });

  it('ignores non-completed retro jobs', async () => {
    const stored = await ingestRetroResult(
      makeJob({ status: 'failed', result: VALID_JSON_RESULT, error: 'turn cap' }),
    );
    assert.equal(stored, 0);
    assert.equal(getStoredMemories().length, 0);
  });

  it('returns 0 for completed retro with unparseable result', async () => {
    const stored = await ingestRetroResult(makeJob({ result: 'I could not find any learnings.' }));
    assert.equal(stored, 0);
    assert.equal(getStoredMemories().length, 0);
  });

  it('does nothing when self_improvement is disabled', async () => {
    _resetConfigForTesting(); // loadConfig caches — reset before rewriting config
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: false\n',
    );
    loadConfig(tmpDir);
    const stored = await ingestRetroResult(makeJob({ result: VALID_JSON_RESULT }));
    assert.equal(stored, 0);
    assert.equal(getStoredMemories().length, 0);
  });

  it('caps stored learnings at max_learnings_per_retro', async () => {
    _resetConfigForTesting(); // loadConfig caches — reset before rewriting config
    enableRetro(tmpDir, ['    max_learnings_per_retro: 2']);
    const result = JSON.stringify({
      learnings: [
        { content: 'Learning one about scheduling', category: 'process', tags: [] },
        { content: 'Learning two about tool usage', category: 'tool-usage', tags: [] },
        { content: 'Learning three about behavior', category: 'behavioral', tags: [] },
        { content: 'Learning four about comms', category: 'communication', tags: [] },
      ],
    });
    const stored = await ingestRetroResult(makeJob({ result }));
    assert.equal(stored, 2);
    assert.equal(getStoredMemories().length, 2);
  });

  it('dedups when the same job result is ingested twice', async () => {
    const first = await ingestRetroResult(makeJob({ result: VALID_JSON_RESULT }));
    assert.equal(first, 2);
    // Double-fire of the job-complete listener (e.g. duplicate finish) must
    // not duplicate memories: storeMemoryInternal dedups on source+prefix.
    await ingestRetroResult(makeJob({ result: VALID_JSON_RESULT }));
    assert.equal(getStoredMemories().length, 2);
  });

  it('stored learnings are visible to the pre-task injection categories', async () => {
    await ingestRetroResult(makeJob({ result: VALID_JSON_RESULT }));
    const rows = query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memories
       WHERE category IN ('api-format', 'behavioral', 'process', 'tool-usage', 'communication')`,
    );
    assert.equal(rows[0]!.count, 2);
  });
});

// ── backfillRetroLearnings (Round 5) ──────────────────────────

describe('backfillRetroLearnings', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-retro-backfill-'));
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableRetro(tmpDir);
  });

  afterEach(() => {
    _resetDbForTesting();
    _resetConfigForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertRetroJob(id: string, result: string | null, profile = 'retro', status = 'completed'): void {
    exec(
      `INSERT INTO worker_jobs (id, profile, prompt, status, result, created_at)
       VALUES (?, ?, 'retro prompt', ?, ?, datetime('now'))`,
      id, profile, status, result,
    );
  }

  it('dry run counts without storing', async () => {
    insertRetroJob('bf-1', VALID_JSON_RESULT);
    insertRetroJob('bf-2', 'no json here');
    insertRetroJob('bf-3', VALID_JSON_RESULT, 'coding'); // not a retro profile

    const r = await backfillRetroLearnings({ dryRun: true });
    assert.equal(r.dry_run, true);
    assert.equal(r.scanned, 2, 'only retro-profile jobs scanned');
    assert.equal(r.ingested_jobs, 1);
    assert.equal(r.stored_learnings, 2);
    assert.equal(r.no_learnings, 1);
    assert.equal(getStoredMemories().length, 0, 'dry run must not store');
  });

  it('real run stores learnings and is idempotent on re-run', async () => {
    insertRetroJob('bf-10', VALID_JSON_RESULT);
    insertRetroJob('bf-11', VALID_JSON_RESULT);

    const first = await backfillRetroLearnings({ dryRun: false });
    assert.equal(first.ingested_jobs, 2);
    assert.equal(first.stored_learnings, 4);
    assert.equal(getStoredMemories().length, 4);

    const second = await backfillRetroLearnings({ dryRun: false });
    assert.equal(second.already_ingested, 2, 'previously ingested jobs are skipped');
    assert.equal(second.ingested_jobs, 0);
    assert.equal(getStoredMemories().length, 4, 'no duplicate memories on re-run');
  });

  it('skips non-completed and empty-result jobs at the query level', async () => {
    insertRetroJob('bf-20', VALID_JSON_RESULT, 'retro', 'failed');
    insertRetroJob('bf-21', null);
    insertRetroJob('bf-22', '');

    const r = await backfillRetroLearnings({ dryRun: false });
    assert.equal(r.scanned, 0);
    assert.equal(getStoredMemories().length, 0);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) insertRetroJob(`bf-3${i}`, VALID_JSON_RESULT);
    const r = await backfillRetroLearnings({ dryRun: false, limit: 2 });
    assert.equal(r.scanned, 2);
    assert.equal(getStoredMemories().length, 4, '2 jobs × 2 learnings');
  });
});
