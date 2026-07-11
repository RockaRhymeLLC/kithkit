/**
 * Tests for the Worker-Output Review Chain (issue #680; see PR description for provenance).
 *
 * Three-tier review chain:
 *   Worker tier  — reviewDirective prepended in lifecycle.ts startWorker
 *   Orchestrator tier — review gate section in buildOrchestratorPrompt (orchestrator.ts)
 *   Comms tier   — standing rule in CLAUDE.md (governance doc)
 *
 * Mutation-kill demonstration:
 *   Removing the reviewDirective or the review gate section makes these tests RED.
 *   The tests assert content DISTINCT from defaults/early-returns — not vacuous.
 *
 * Path convention: tests run from dist/__tests__/ but read .ts source files
 * from src/ using '../../src' relative to the compiled file location.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve to daemon/src/ from daemon/dist/__tests__/ at runtime.
// Path chain: dist/__tests__/ -> dist/ -> daemon/ -> src/
const distTestsDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(distTestsDir, '..', '..', 'src');

// ── Anchor B: Worker tier (lifecycle.ts) ──────────────────────

describe('Review chain — Worker tier (lifecycle.ts reviewDirective)', () => {
  it('startWorker composes prompt as modePrefix + reviewDirective + req.prompt', () => {
    const src = fs.readFileSync(
      path.join(srcDir, 'agents', 'lifecycle.ts'),
      'utf8',
    );

    // The reviewDirective constant must exist and be non-empty
    assert.ok(
      src.includes('const reviewDirective ='),
      'lifecycle.ts must define reviewDirective constant',
    );

    // The directive must instruct workers to structure output for review
    assert.ok(
      src.includes('REVIEWABLE by the orchestrator'),
      'reviewDirective must tell workers to structure output as REVIEWABLE',
    );

    // The directive must cover the key output categories
    assert.ok(
      src.includes('Diffs or file paths'),
      'reviewDirective must mention diffs/file paths for code changes',
    );
    assert.ok(
      src.includes('Exact build/test results'),
      'reviewDirective must require exact build/test results',
    );
    assert.ok(
      src.includes('PR/issue URLs'),
      'reviewDirective must require PR/issue URLs',
    );

    // The directive must instruct STOP before irreversible steps when gate is set
    assert.ok(
      src.includes('STOP before that step'),
      'reviewDirective must instruct workers to STOP before irreversible steps when gate is set',
    );

    // The single prompt-composition point must include all three parts in order:
    // modePrefix + reviewDirective + req.prompt
    const compositionMatch = src.match(
      /const promptWithMode\s*=\s*modePrefix\s*\+\s*reviewDirective\s*\+\s*req\.prompt/,
    );
    assert.ok(
      compositionMatch !== null,
      'prompt must be composed as modePrefix + reviewDirective + req.prompt (single composition point)',
    );
  });

  it('lifecycle.ts has exactly one prompt-composition point (no bypass path)', () => {
    const src = fs.readFileSync(
      path.join(srcDir, 'agents', 'lifecycle.ts'),
      'utf8',
    );
    // Count occurrences of the reviewDirective assignment
    const directiveCount = (src.match(/const reviewDirective\s*=/g) ?? []).length;
    assert.equal(directiveCount, 1, 'reviewDirective must be defined exactly once');

    // Count occurrences of promptWithMode assignment
    const compositionCount = (src.match(/const promptWithMode\s*=/g) ?? []).length;
    assert.equal(compositionCount, 1, 'There must be exactly one prompt-composition point');
  });
});

// ── Anchor A: Orchestrator tier (orchestrator.ts review gate) ──

describe('Review chain — Orchestrator tier (buildOrchestratorPrompt review gate)', () => {
  it('buildOrchestratorPrompt contains the Worker Output Review Gate section', () => {
    const src = fs.readFileSync(
      path.join(srcDir, 'api', 'orchestrator.ts'),
      'utf8',
    );

    assert.ok(
      src.includes('## Worker Output Review Gate (STANDING RULE)'),
      'orchestrator.ts must include Worker Output Review Gate section header',
    );

    // Must instruct INDEPENDENT verification — not relay verbatim
    assert.ok(
      src.includes('INDEPENDENTLY review'),
      'review gate must instruct orchestrator to INDEPENDENTLY review worker output',
    );
    assert.ok(
      src.includes('Do NOT relay the worker'),
      'review gate must forbid relaying worker self-report verbatim',
    );

    // Must require posting a worker_review activity entry using the stage field
    assert.ok(
      src.includes('"worker_review"'),
      'review gate must reference worker_review stage convention',
    );

    // Must use the correct task activity API field (message, not event_type)
    assert.ok(
      src.includes('"message"'),
      'review gate activity entry must use "message" field (not "event_type" which belongs to agent activity)',
    );
    assert.ok(
      !src.includes('"event_type":"worker_review"'),
      'review gate must NOT use event_type field for task activity (wrong API shape)',
    );
  });

  it('buildOrchestratorPrompt uses configured daemon port (not hardcoded :3847)', () => {
    const src = fs.readFileSync(
      path.join(srcDir, 'api', 'orchestrator.ts'),
      'utf8',
    );

    // Must extract port from config
    assert.ok(
      src.includes('cfg.daemon.port'),
      'buildOrchestratorPrompt must read daemon port from config (not hardcode 3847)',
    );

    // Must use daemonUrl template variable
    assert.ok(
      src.includes('${daemonUrl}'),
      'review gate section must use ${daemonUrl} template variable, not hardcoded URL',
    );

    // Review gate section must NOT contain hardcoded localhost:3847
    const fnStart = src.indexOf('async function buildOrchestratorPrompt');
    assert.ok(fnStart >= 0, 'buildOrchestratorPrompt must exist');
    const fnBody = src.slice(fnStart);
    const reviewGateStart = fnBody.indexOf('## Worker Output Review Gate');
    assert.ok(reviewGateStart >= 0, 'review gate section must exist in buildOrchestratorPrompt');
    const reviewGateEnd = fnBody.indexOf("'Context management:", reviewGateStart);
    const reviewGateSection = fnBody.slice(reviewGateStart, reviewGateEnd);
    assert.ok(
      !reviewGateSection.includes('localhost:3847'),
      'review gate section must not contain hardcoded localhost:3847',
    );
  });

  it('buildOrchestratorPrompt interpolates profile list (not hardcoded names)', () => {
    const src = fs.readFileSync(
      path.join(srcDir, 'api', 'orchestrator.ts'),
      'utf8',
    );

    // Must load profiles from registry
    assert.ok(
      src.includes('loadProfiles('),
      'buildOrchestratorPrompt must call loadProfiles() to get the actual profile set',
    );

    // Must use profileList template variable in Available profiles line
    assert.ok(
      src.includes('${profileList}'),
      'Available profiles line must use ${profileList} template variable',
    );

    // Must NOT hardcode the fixed set in Available profiles line
    const fnStart = src.indexOf('async function buildOrchestratorPrompt');
    const fnBody = src.slice(fnStart);
    assert.ok(
      !fnBody.includes("'- Available profiles: research (read-only exploration), coding (implementation), testing (test running)'"),
      'Available profiles line must not hardcode the fixed research/coding/testing set',
    );
  });
});

// ── Anchor C: Comms tier (CLAUDE.md standing rule) ────────────

describe('Review chain — Comms tier (CLAUDE.md standing rule)', () => {
  it('.kithkit/CLAUDE.md contains Worker-Output Review Gate standing rule', () => {
    // Navigate from daemon/dist/__tests__/ to repo root (5 levels up)
    const repoRoot = path.resolve(distTestsDir, '..', '..', '..', '..', '..');
    const claudePath = path.join(repoRoot, '.kithkit', 'CLAUDE.md');

    if (!fs.existsSync(claudePath)) {
      // Skip if not in the expected location (e.g. CI without project files)
      return;
    }

    const content = fs.readFileSync(claudePath, 'utf8');

    assert.ok(
      content.includes('Worker-Output Review Gate (Standing Rule'),
      '.kithkit/CLAUDE.md must contain Worker-Output Review Gate standing rule heading',
    );

    assert.ok(
      content.includes('Three-tier review chain') || content.includes('three-tier review chain'),
      '.kithkit/CLAUDE.md standing rule must describe three-tier review chain',
    );

    assert.ok(
      content.includes('worker_review'),
      '.kithkit/CLAUDE.md standing rule must reference worker_review stage convention',
    );

    assert.ok(
      content.includes('Explicitly out of scope') || content.includes('out of scope'),
      '.kithkit/CLAUDE.md standing rule must include the out-of-scope carve-out',
    );
  });

  it('.claude/CLAUDE.md mirrors the Worker-Output Review Gate standing rule', () => {
    const repoRoot = path.resolve(distTestsDir, '..', '..', '..', '..', '..');
    const claudePath = path.join(repoRoot, '.claude', 'CLAUDE.md');

    if (!fs.existsSync(claudePath)) {
      return;
    }

    const content = fs.readFileSync(claudePath, 'utf8');

    assert.ok(
      content.includes('Worker-Output Review Gate (Standing Rule'),
      '.claude/CLAUDE.md must mirror the Worker-Output Review Gate standing rule',
    );
  });
});
