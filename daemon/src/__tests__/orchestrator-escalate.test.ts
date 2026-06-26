/**
 * Regression tests for POST /api/orchestrator/escalate — task field preservation.
 *
 * Root cause: the original INSERT used `task.slice(0, 200)` for title and
 * `context ?? task` for description, silently dropping the full task body
 * whenever a context was provided. BMO's digest task 24dab43c lost its
 * delivery instructions this way.
 *
 * These tests exercise:
 *   1. buildTaskFields() pure helper (unit)
 *   2. Full description preservation when both task + context are provided (unit)
 *   3. Title derived from first line, capped at 200 chars (unit)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, query, exec } from '../core/db.js';
import { loadConfig, _resetConfigForTesting } from '../core/config.js';
import { buildTaskFields, handleOrchestratorRoute, _setDepsForTesting } from '../api/orchestrator.js';
import { initLogger, _resetLoggerForTesting } from '../core/logger.js';

// ── Unit tests for buildTaskFields ──────────────────────────────────────────

describe('buildTaskFields', { concurrency: 1 }, () => {

  describe('title derivation', () => {
    it('uses the first non-empty line as title', () => {
      const task = 'Send the weekly digest\n\nWith lots of body content here.';
      const { titleText } = buildTaskFields(task);
      assert.equal(titleText, 'Send the weekly digest');
    });

    it('skips blank leading lines to find first non-empty line', () => {
      const task = '\n\n  \nActual first line\nSecond line';
      const { titleText } = buildTaskFields(task);
      assert.equal(titleText, 'Actual first line');
    });

    it('caps title at 200 chars', () => {
      const longLine = 'A'.repeat(300);
      const task = `${longLine}\nmore content`;
      const { titleText } = buildTaskFields(task);
      assert.equal(titleText.length, 200);
      assert.equal(titleText, longLine.slice(0, 200));
    });

    it('falls back to task.slice(0,200) when all lines are blank', () => {
      const task = '   \n   \n   ';
      const { titleText } = buildTaskFields(task);
      assert.equal(titleText, task.slice(0, 200));
    });

    it('trims whitespace from title', () => {
      const task = '   Trimmed title   \nBody content';
      const { titleText } = buildTaskFields(task);
      assert.equal(titleText, 'Trimmed title');
    });
  });

  describe('description preservation — no context', () => {
    it('description is the full task body when no context provided', () => {
      const SENTINEL = 'SENTINEL_TASK_FULL_BODY_DO_NOT_LOSE';
      const task = `First line\n\nParagraph two. ${SENTINEL}\n\nMore paragraphs follow.`;
      const { descriptionText } = buildTaskFields(task);
      assert.equal(descriptionText, task, 'description must equal full task');
      assert.ok(descriptionText.includes(SENTINEL), 'sentinel must survive');
    });

    it('description preserves task body longer than 200 chars', () => {
      const task = 'A'.repeat(500);
      const { descriptionText } = buildTaskFields(task);
      assert.equal(descriptionText.length, 500);
    });
  });

  describe('description preservation — with context (regression for 24dab43c)', () => {
    it('description contains BOTH task sentinel AND context sentinel', () => {
      const SENTINEL_TASK = 'SENTINEL_TASK_FULL_BODY_DO_NOT_LOSE';
      const SENTINEL_CTX = 'SENTINEL_CONTEXT_DO_NOT_LOSE';

      const task =
        'Send the weekly digest to all subscribers\n\n' +
        'Delivery instructions: use Telegram channel -5046483444. ' +
        SENTINEL_TASK.repeat(5) + '\n\n' +
        'Additional body paragraph that is definitely longer than two hundred characters so we can confirm the full task body survives the insert without truncation. End of task body.';

      const context =
        'Background context from previous session. ' +
        SENTINEL_CTX.repeat(5) + '\n\n' +
        'More context lines follow here to ensure the context section is also well beyond 300 characters in length for a thorough sentinel check.';

      assert.ok(task.length > 300, `task should be >300 chars, got ${task.length}`);
      assert.ok(context.length > 300, `context should be >300 chars, got ${context.length}`);

      const { titleText, descriptionText } = buildTaskFields(task, context);

      // title is from first line, ≤200 chars
      assert.equal(titleText, 'Send the weekly digest to all subscribers');
      assert.ok(titleText.length <= 200, `title length ${titleText.length} should be ≤200`);

      // description contains full task body
      assert.ok(
        descriptionText.includes(SENTINEL_TASK),
        'description must contain task sentinel — full task body must be preserved',
      );

      // description contains context
      assert.ok(
        descriptionText.includes(SENTINEL_CTX),
        'description must contain context sentinel — context must be preserved',
      );

      // description starts with the task (not context)
      assert.ok(
        descriptionText.startsWith('Send the weekly digest'),
        'description should start with task body',
      );

      // context is in a delimited section
      assert.ok(
        descriptionText.includes('## Context\n'),
        'context should be in a ## Context section',
      );
      assert.ok(
        descriptionText.includes('---'),
        'description should have a horizontal rule separator',
      );
    });

    it('context follows task body, separated by delimiter', () => {
      const task = 'Do the thing\n\nWith full body.';
      const context = 'Extra background here.';
      const { descriptionText } = buildTaskFields(task, context);

      const expected = `${task}\n\n---\n\n## Context\n${context}`;
      assert.equal(descriptionText, expected);
    });

    it('omits context section when context is undefined', () => {
      const task = 'Do the thing\n\nWith full body.';
      const { descriptionText } = buildTaskFields(task, undefined);
      assert.equal(descriptionText, task);
      assert.ok(!descriptionText.includes('## Context'));
    });
  });

  describe('title <= 200 chars in all cases', () => {
    it('title is always ≤200 chars regardless of input', () => {
      for (const task of [
        'Short',
        'A'.repeat(201),
        '\n\n' + 'B'.repeat(300) + '\nMore',
        'Has spaces   \nNext line',
      ]) {
        const { titleText } = buildTaskFields(task);
        assert.ok(titleText.length <= 200, `title exceeds 200 chars for input: ${task.slice(0, 30)}`);
      }
    });
  });
});

// ── Escalate handler: inject-fail warning (#110 phantom-nudge) ────────────────

/**
 * Regression: when injectMessage() returns false (session died between state-check
 * and nudge), the escalate handler must:
 *   1. Still create the task row in DB (for idle monitor recovery)
 *   2. Return { status: 'escalated' }
 *   3. Emit a warn log so operators can diagnose phantom-nudge incidents
 *
 * MUTATION-KILL: removing the `if (!nudged) { log.warn(...) }` block from
 * orchestrator.ts causes test 3 to fail (no warn log emitted → assertion fails).
 */

const ESCALATE_TEST_PORT = 19872;

function escRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: ESCALATE_TEST_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { raw: data } });
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

function readLogEntries(logDir: string): Array<{ level: string; msg: string }> {
  const logFile = path.join(logDir, 'daemon.log');
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l) as { level: string; msg: string }; } catch { return null; } })
    .filter((e): e is { level: string; msg: string } => e !== null);
}

describe('Escalate handler — inject-fail graceful handling (#110)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;
  let logDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-esc-'));
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-esc-log-'));
    initLogger({ logDir, minLevel: 'warn' });
    _resetDbForTesting();
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));

    // Deps: orch is 'waiting' but injectMessage returns false (session died)
    _setDepsForTesting({
      getOrchestratorState: () => 'waiting',
      injectMessage: () => false,
      spawnOrchestratorSession: () => null,  // not called in waiting path
      sendMessage: () => ({ messageId: 1, delivered: false }),
    });

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${ESCALATE_TEST_PORT}`);
      handleOrchestratorRoute(req, res, url.pathname)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
    });

    await new Promise<void>((resolve) => server.listen(ESCALATE_TEST_PORT, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _setDepsForTesting(null);
    _resetDbForTesting();
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          fs.rmSync(logDir, { recursive: true, force: true });
          resolve();
        });
      } else {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
        resolve();
      }
    });
  });

  it('task is created in DB and response is escalated even when inject fails', async () => {
    const res = await escRequest('POST', '/api/orchestrator/escalate', {
      task: 'Test phantom nudge guard — inject fails',
    });

    assert.equal(res.status, 200, 'should return HTTP 200');
    assert.equal(res.json.status, 'escalated', 'status should be escalated');
    assert.ok(typeof res.json.task_id === 'string', 'task_id should be present');

    // Verify task was committed to DB — it must be pending for idle monitor recovery
    const taskId = res.json.task_id as string;
    const rows = query<{ external_id: string; status: string }>(
      "SELECT external_id, status FROM tasks WHERE external_id = ? AND kind = 'orchestrator'",
      taskId,
    );
    assert.equal(rows.length, 1, 'task row must exist in DB');
    assert.equal(rows[0]!.status, 'pending', 'task must be pending so idle monitor can recover it');
  });

  it('task is created in DB even when inject fails — idle monitor can wake orch', async () => {
    // Second assertion: inject failure must not prevent task from being actionable.
    // The task must be visible via the pending-tasks query used by orchestrator-idle Check 3.
    const res = await escRequest('POST', '/api/orchestrator/escalate', {
      task: 'Phantom guard — idle monitor recovery path',
    });

    assert.equal(res.status, 200);

    const pendingTasks = query<{ external_id: string }>(
      "SELECT external_id FROM tasks WHERE kind = 'orchestrator' AND status = 'pending'",
    );
    assert.ok(pendingTasks.length >= 1, 'at least one pending task must exist for idle monitor to pick up');
  });

  it('MUTATION-KILL: warn log emitted when inject fails (removing the !nudged warn block turns this RED)', async () => {
    // This test kills the mutation "remove the if (!nudged) { log.warn(...) } block".
    // Without that block, no warn is logged and the assertion below fails → RED.
    // With the block in place, the warn fires and the assertion passes → GREEN.
    await escRequest('POST', '/api/orchestrator/escalate', {
      task: 'Inject-fail warn mutation-kill test',
    });

    const entries = readLogEntries(logDir);
    const warnEntries = entries.filter(
      e => e.level === 'warn' && e.msg.includes('inject failed'),
    );
    assert.ok(
      warnEntries.length > 0,
      `expected a warn log containing 'inject failed' when injectMessage returns false, got: ${JSON.stringify(entries)}`,
    );
  });
});

// ── Reset-on-spawn mutation-kill (#922 facet-b) ───────────────────────────────
//
// When the orchestrator is DEAD and a new escalate call spawns a fresh session,
// the catch branch in the escalate handler (agents row already exists from the dead
// predecessor) must reset agents.last_activity to the spawn timestamp.
//
// Without this reset, a fresh orch inherits the dead predecessor's stale
// last_activity — which is the root cause of the false signal(ii) wedge trigger
// that the started_at guard (facet-b, PR #479) was written to exempt.
//
// MUTATION-KILL PROOF:
//   Revert: remove `last_activity: ts` from the update() call in the escalate
//   handler catch branch (orchestrator.ts ~line 245).
//   Expected: agents.last_activity stays at the seeded stale value → test RED.
//   Restored: agents.last_activity is reset to spawn time → test GREEN.

const RESET_ON_SPAWN_PORT = 19873;

function resetSpawnRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      host: '127.0.0.1',
      port: RESET_ON_SPAWN_PORT,
      path: urlPath,
      method,
      timeout: 5000,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'Connection': 'close',
      },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) as Record<string, unknown> });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: { raw: data } });
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('Escalate handler — reset-on-spawn mutation-kill (#922 facet-b)', { concurrency: 1 }, () => {
  let server: http.Server;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkit-spawn-reset-'));
    _resetConfigForTesting();
    _resetDbForTesting();
    fs.writeFileSync(path.join(tmpDir, 'kithkit.config.yaml'), 'agent:\n  name: test\n');
    loadConfig(tmpDir);
    openDatabase(tmpDir, path.join(tmpDir, 'test.db'));
    initLogger({ logDir: tmpDir, minLevel: 'warn' });

    _setDepsForTesting({
      getOrchestratorState: () => 'dead',
      spawnOrchestratorSession: () => 'orch-reset-spawn-test',
      sendMessage: () => ({ messageId: 1, delivered: false }),
      injectMessage: () => false,
    });

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${RESET_ON_SPAWN_PORT}`);
      handleOrchestratorRoute(req, res, url.pathname)
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
        })
        .catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
    });

    await new Promise<void>((resolve) => server.listen(RESET_ON_SPAWN_PORT, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    _setDepsForTesting(null);
    _resetDbForTesting();
    _resetConfigForTesting();
    _resetLoggerForTesting({ logDir: os.tmpdir(), minLevel: 'info' });
    await new Promise<void>((resolve) => {
      if (server?.listening) {
        server.close(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          resolve();
        });
      } else {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      }
    });
  });

  /**
   * MUTATION-KILL: escalating with orch=DEAD resets agents.last_activity to spawn time.
   *
   * Scenario:
   *   - A dead predecessor left a stale agents row with last_activity = 60 min ago.
   *   - A new escalate call finds orch DEAD, spawns a fresh session, and must reset
   *     last_activity to the spawn timestamp (the catch branch in orchestrator.ts).
   *
   * MUTATION-KILL PROOF:
   *   Revert: remove `last_activity: ts` from the update() call in the catch branch
   *   of the escalate handler (orchestrator.ts, the block starting with
   *   "// Reset last_activity to spawn time (#922 facet-b)").
   *   Expected: agents.last_activity stays at '60-min-ago-stale' → test RED.
   *   Restored: agents.last_activity is reset to ~spawn-time (within 5s of now) → test GREEN.
   */
  it('MUTATION-KILL: escalate with orch=DEAD resets agents.last_activity to spawn time (#922 facet-b)', async () => {
    const staleActivity = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago

    // Pre-seed a stale agents row simulating a dead predecessor whose last_activity is 60 min old.
    // The escalate handler's INSERT will fail (row already exists) and fall into the catch branch,
    // where reset-on-spawn must update last_activity to the fresh spawn timestamp.
    exec(
      `INSERT INTO agents (id, type, profile, status, tmux_session, last_activity, started_at, created_at, updated_at)
       VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'stopped', 'dead-session',
               ?, ?, ?, ?)`,
      staleActivity,
      staleActivity,
      staleActivity,
      staleActivity,
    );

    const beforeSpawn = Date.now();

    const res = await resetSpawnRequest('POST', '/api/orchestrator/escalate', {
      task: 'Reset-on-spawn mutation-kill test task',
    });

    assert.equal(res.status, 202, `expected 202 spawned, got ${res.status}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.status, 'spawned', 'response status should be spawned');

    // The agents row must have last_activity reset to ~spawn time (within 5 seconds of beforeSpawn).
    const rows = query<{ last_activity: string; started_at: string }>(
      "SELECT last_activity, started_at FROM agents WHERE id = 'orchestrator'",
    );
    assert.equal(rows.length, 1, 'agents row must exist');

    const resetActivity = new Date(rows[0]!.last_activity).getTime();
    assert.ok(
      resetActivity >= beforeSpawn - 1000,
      `agents.last_activity must be reset to spawn time (>= ${new Date(beforeSpawn).toISOString()}), ` +
      `got ${rows[0]!.last_activity} — reverting reset-on-spawn makes this RED`,
    );

    assert.ok(
      resetActivity > new Date(staleActivity).getTime(),
      `agents.last_activity (${rows[0]!.last_activity}) must be newer than stale value (${staleActivity}) — ` +
      `reverting reset-on-spawn makes this RED (stale value persists)`,
    );
  });
});
