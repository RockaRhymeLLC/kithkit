/**
 * Tests for pre-task-injector: searchRelevantLearnings, formatInjection, injectLearnings.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, _resetConfigForTesting } from '../../core/config.js';
import { openDatabase, _resetDbForTesting, exec } from '../../core/db.js';
import {
  searchRelevantLearnings,
  formatInjection,
  injectLearnings,
} from '../pre-task-injector.js';
import type { AgentProfile } from '../../agents/profiles.js';

// ── Helpers ──────────────────────────────────────────────────

const BASE_PROFILE: AgentProfile = {
  name: 'coding',
  description: 'Coding worker',
  tools: [],
  disallowedTools: [],
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  maxTurns: 20,
  effort: 'high',
  body: 'You are a coding assistant.',
};

/**
 * Create an ISO timestamp N days in the past.
 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/**
 * Insert a memory into the test DB.
 */
function insertMemory(opts: {
  content: string;
  category: string;
  origin_agent?: string;
  created_at?: string;
}): void {
  exec(
    `INSERT INTO memories (content, category, origin_agent, tags, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?)`,
    opts.content,
    opts.category,
    opts.origin_agent ?? null,
    opts.created_at ?? new Date().toISOString(),
    new Date().toISOString(),
  );
}

function enableInjection(tmpDir: string, extra: string = ''): void {
  fs.writeFileSync(
    path.join(tmpDir, 'kithkit.config.yaml'),
    [
      'self_improvement:',
      '  enabled: true',
      '  pre_task_injection:',
      '    enabled: true',
      extra,
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  loadConfig(tmpDir);
}

// ── Tests ─────────────────────────────────────────────────────

describe('searchRelevantLearnings returns memories matching task description', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns memories in SI categories matching task keywords', async () => {
    insertMemory({
      content: 'Always use payload.text not payload.body for A2A messages',
      category: 'api-format',
      origin_agent: 'bmo',
    });
    insertMemory({
      content: 'Check daemon health before spawning workers',
      category: 'process',
      origin_agent: 'skippy',
    });
    // Non-SI category — should not appear
    insertMemory({
      content: 'The office is at 123 Main Street',
      category: 'operational',
    });

    const results = await searchRelevantLearnings('spawn workers payload', 10, 0.0, db);

    // Should return only SI-category memories
    assert.ok(
      results.every(r => ['api-format', 'behavioral', 'process', 'tool-usage', 'communication'].includes(r.category)),
      'all results should be in SI categories',
    );
    assert.ok(results.length >= 1, 'should return at least one matching memory');
  });

  it('returns memories sorted by relevance score (highest first)', async () => {
    // This memory has 3 matching words
    insertMemory({ content: 'spawn workers daemon api endpoint pattern', category: 'process' });
    // This memory has 1 matching word
    insertMemory({ content: 'spawn tasks on queue', category: 'process' });

    const results = await searchRelevantLearnings('spawn workers daemon', 10, 0.0, db);

    assert.ok(results.length >= 2, 'should return both memories');
    // First result should have higher score
    assert.ok(
      results[0]._relevance_score >= results[1]._relevance_score,
      'results should be sorted by relevance score descending',
    );
  });

  it('returns empty array when no SI-category memories exist', async () => {
    insertMemory({ content: 'Some non-SI knowledge', category: 'operational' });

    const results = await searchRelevantLearnings('any task description', 10, 0.0, db);
    assert.equal(results.length, 0);
  });
});

describe('Memories below min_relevance_score are filtered out', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters out memories with score below threshold', async () => {
    // This memory matches 'authentication' — task has 'authentication' and 'tokens'
    insertMemory({
      content: 'Always validate authentication tokens on entry',
      category: 'behavioral',
    });
    // This memory has NO overlap with the task words
    insertMemory({
      content: 'breakfast is served at 8am in the cafeteria',
      category: 'process',
    });

    // minScore 0.4 means we need at least 40% word match
    const results = await searchRelevantLearnings('authentication tokens management', 10, 0.4, db);

    // The first memory should match (contains 'authentication' and 'tokens')
    // The second should not match (no overlap with 'authentication', 'tokens', 'management')
    assert.ok(
      results.every(r => r.content.toLowerCase().includes('authentication')),
      'only memories matching task words should appear',
    );
  });

  it('returns all memories when minScore is 0', async () => {
    insertMemory({ content: 'completely unrelated topic xyz', category: 'behavioral' });

    const results = await searchRelevantLearnings('authentication tokens', 10, 0.0, db);
    assert.ok(results.length >= 1, 'all memories should pass with minScore=0');
  });
});

describe('formatInjection produces correct markdown block with attribution and age', () => {
  it('formats memories with category, origin_agent, and age', () => {
    const memories = [
      {
        content: 'A2A payload uses field text not body',
        category: 'api-format',
        origin_agent: 'bmo',
        created_at: daysAgo(3),
      },
      {
        content: 'Always check daemon health before spawning workers',
        category: 'process',
        origin_agent: 'skippy',
        created_at: daysAgo(12),
      },
    ];

    const result = formatInjection(memories);

    assert.ok(result.startsWith('## Known Issues / Past Learnings'), 'should have correct header');
    // Check format components without hard-coding exact age (DST can shift day count by 1)
    assert.ok(result.includes('[api-format, from: bmo,'), 'should include api-format category and bmo attribution');
    assert.ok(result.includes('days ago]'), 'should include "days ago" age format');
    assert.ok(result.includes('[process, from: skippy,'), 'should include process category and skippy attribution');
    assert.ok(result.includes('A2A payload uses field text not body'), 'should include first memory content');
    assert.ok(
      result.includes('Always check daemon health before spawning workers'),
      'should include second memory content',
    );
  });

  it('handles missing origin_agent with unknown', () => {
    const memories = [
      {
        content: 'Some learning without attribution',
        category: 'behavioral',
        origin_agent: null,
        created_at: daysAgo(1),
      },
    ];

    const result = formatInjection(memories);
    assert.ok(result.includes('from: unknown'), 'should show unknown when origin_agent is null');
  });

  it('shows "today" for same-day memories', () => {
    const memories = [
      {
        content: 'A very fresh learning',
        category: 'tool-usage',
        origin_agent: 'skippy',
        created_at: new Date().toISOString(),
      },
    ];

    const result = formatInjection(memories);
    assert.ok(result.includes('today'), 'should show "today" for same-day memory');
  });

  it('returns empty string for empty memories array', () => {
    const result = formatInjection([]);
    assert.equal(result, '');
  });
});

describe('Injection prepended to worker prompt when enabled', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableInjection(tmpDir);
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prepends learnings block before the original prompt', async () => {
    insertMemory({
      content: 'Always validate authentication tokens on entry points',
      category: 'behavioral',
      origin_agent: 'bmo',
    });

    const originalPrompt = 'Implement authentication token validation';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.ok(result.includes('## Known Issues / Past Learnings'), 'should contain learnings header');
    assert.ok(result.includes(originalPrompt), 'should preserve original prompt');
    assert.ok(result.indexOf('## Known Issues') < result.indexOf(originalPrompt), 'learnings should come before original prompt');
  });
});

describe('No injection when disabled', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns original prompt unchanged when pre_task_injection.enabled is false', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: true\n  pre_task_injection:\n    enabled: false\n',
    );
    loadConfig(tmpDir);

    insertMemory({ content: 'Some learning', category: 'behavioral' });

    const originalPrompt = 'Do some work';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.equal(result, originalPrompt, 'should return original prompt when disabled');
  });

  it('returns original prompt unchanged when self_improvement.enabled is false', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'kithkit.config.yaml'),
      'self_improvement:\n  enabled: false\n',
    );
    loadConfig(tmpDir);

    insertMemory({ content: 'Some learning', category: 'behavioral' });

    const originalPrompt = 'Do some work';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.equal(result, originalPrompt, 'should return original prompt when self_improvement disabled');
  });

  it('returns original prompt when no config file exists (defaults to disabled)', async () => {
    loadConfig(tmpDir); // no config file — all defaults

    insertMemory({ content: 'Some learning', category: 'behavioral' });

    const originalPrompt = 'Do some work';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.equal(result, originalPrompt, 'should return original prompt with default (disabled) config');
  });
});

describe('No injection when no memories meet relevance threshold', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    enableInjection(tmpDir, '    min_relevance_score: 0.9');
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns original prompt when no memories pass the score threshold', async () => {
    // Insert a memory with no overlap to the task
    insertMemory({
      content: 'breakfast is served at 8am in the cafeteria kitchen area',
      category: 'behavioral',
    });

    const originalPrompt = 'Implement authentication token validation service';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.equal(result, originalPrompt, 'should return original prompt when no memories pass threshold');
  });

  it('returns original prompt when no SI-category memories exist', async () => {
    insertMemory({ content: 'Some operational fact', category: 'operational' });

    const originalPrompt = 'Deploy the service';
    const result = await injectLearnings(originalPrompt, BASE_PROFILE, db);

    assert.equal(result, originalPrompt, 'should return original prompt when no SI memories exist');
  });
});

describe('Profile max_memories_injected overrides global default', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    // Enable with global max of 10 and low threshold so all memories qualify
    enableInjection(tmpDir, '    min_relevance_score: 0.0\n    max_memories_injected: 10');
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('profile max_memories_injected caps results below global default', async () => {
    // Insert 5 SI-category memories
    for (let i = 0; i < 5; i++) {
      insertMemory({ content: `Learning number ${i} about process flow`, category: 'process' });
    }

    // Profile says max 2
    const profile = { ...BASE_PROFILE, max_memories_injected: 2 };
    const result = await injectLearnings('process flow management', profile, db);

    // Count the bullet points in the injected block
    const lines = result.split('\n').filter(l => l.startsWith('- ['));
    assert.equal(lines.length, 2, 'should inject at most profile.max_memories_injected memories');
  });
});

describe('Falls back to global default when profile has no max_memories_injected', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    _resetConfigForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-injector-'));
    _resetDbForTesting();
    db = openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    // Enable with global max of 3 and low threshold
    enableInjection(tmpDir, '    min_relevance_score: 0.0\n    max_memories_injected: 3');
  });

  afterEach(() => {
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses global max_memories_injected when profile has none', async () => {
    // Insert 5 SI-category memories
    for (let i = 0; i < 5; i++) {
      insertMemory({ content: `Learning about process step ${i}`, category: 'process' });
    }

    // Profile has no max_memories_injected
    const profileWithoutMax = { ...BASE_PROFILE };
    delete (profileWithoutMax as Partial<typeof profileWithoutMax>).max_memories_injected;

    const result = await injectLearnings('process management flow', profileWithoutMax, db);

    // Count bullet points — should be capped at 3 (global config)
    const lines = result.split('\n').filter(l => l.startsWith('- ['));
    assert.equal(lines.length, 3, 'should use global max_memories_injected when profile has none');
  });
});
