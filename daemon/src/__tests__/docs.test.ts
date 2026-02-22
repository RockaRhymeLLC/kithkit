/**
 * t-174 — Documentation completeness check
 *
 * Verify all framework documentation files exist and cover required sections.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kithkitRoot = path.resolve(__dirname, '..', '..', '..');

function readDoc(relativePath: string): string {
  const fullPath = path.join(kithkitRoot, relativePath);
  assert.ok(fs.existsSync(fullPath), `${relativePath} must exist`);
  return fs.readFileSync(fullPath, 'utf-8');
}

describe('Documentation completeness (t-174)', () => {
  it('CLAUDE.md has all 4 required sections and no identity/personality content', () => {
    const content = readDoc('.claude/CLAUDE.md');

    // Required sections
    assert.ok(content.includes('## Platform Usage'), 'must have Platform Usage section');
    assert.ok(content.includes('## Directives'), 'must have Directives section');
    assert.ok(content.includes('## Rules of Engagement'), 'must have Rules of Engagement section');
    assert.ok(content.includes('## Quality Standards'), 'must have Quality Standards section');

    // Must NOT contain identity/personality (that's in identity.md)
    assert.ok(!content.includes('## Personality'), 'must NOT have Personality section');
    assert.ok(!content.includes('## Identity'), 'must NOT have Identity section');

    // Should reference the identity file
    assert.ok(content.includes('identity'), 'should reference identity file');
  });

  it('API reference covers all daemon HTTP endpoints', () => {
    const content = readDoc('docs/api-reference.md');

    // Core endpoints
    const endpoints = [
      'GET /health',
      'GET /status',
      'POST /api/agents/spawn',
      'GET /api/agents',
      'DELETE /api/agents',
      'GET /api/todos',
      'POST /api/todos',
      'PUT /api/todos',
      'DELETE /api/todos',
      'GET /api/calendar',
      'POST /api/calendar',
      'POST /api/messages',
      'GET /api/messages',
      'POST /api/send',
      'POST /api/memory/store',
      'POST /api/memory/search',
      'GET /api/memory',
      'DELETE /api/memory',
      'GET /api/config',
      'PUT /api/config',
      'GET /api/feature-state',
      'PUT /api/feature-state',
      'GET /api/usage',
      'GET /api/tasks',
      'POST /api/tasks',
      'POST /api/config/reload',
    ];

    for (const endpoint of endpoints) {
      assert.ok(
        content.includes(endpoint),
        `API reference must document: ${endpoint}`,
      );
    }
  });

  it('agent profiles doc covers format and all built-in profiles', () => {
    const content = readDoc('docs/agent-profiles.md');

    // Format documentation
    assert.ok(content.includes('name'), 'must document name field');
    assert.ok(content.includes('description'), 'must document description field');
    assert.ok(content.includes('tools'), 'must document tools field');
    assert.ok(content.includes('disallowedTools'), 'must document disallowedTools field');
    assert.ok(content.includes('model'), 'must document model field');
    assert.ok(content.includes('permissionMode'), 'must document permissionMode field');
    assert.ok(content.includes('maxTurns'), 'must document maxTurns field');

    // Built-in profiles
    const profiles = ['research', 'coding', 'testing', 'email', 'review', 'devils-advocate'];
    for (const profile of profiles) {
      assert.ok(
        content.includes(profile),
        `must document built-in profile: ${profile}`,
      );
    }
  });

  it('getting started guide walks through kithkit init to first working agent', () => {
    const content = readDoc('docs/getting-started.md');

    // Prerequisites
    assert.ok(content.includes('Node.js'), 'must mention Node.js prerequisite');
    assert.ok(content.includes('Claude Code'), 'must mention Claude Code prerequisite');

    // Init command
    assert.ok(content.includes('npx kithkit init'), 'must show init command');

    // Daemon interaction
    assert.ok(content.includes('/health'), 'must show health check');

    // Step-by-step flow
    assert.ok(content.includes('kithkit.config.yaml'), 'must mention config file');
    assert.ok(content.includes('identity.md'), 'must mention identity file');
  });

  it('README has project overview, quick start, and architecture diagram', () => {
    const content = readDoc('README.md');

    // Project overview
    assert.ok(content.includes('Kithkit'), 'must have project name');
    assert.ok(content.includes('framework'), 'must describe what it is');

    // Quick start
    assert.ok(content.includes('Quick Start'), 'must have Quick Start section');
    assert.ok(content.includes('npx kithkit init'), 'must show init command');

    // Architecture diagram
    assert.ok(content.includes('Architecture'), 'must have Architecture section');
    assert.ok(content.includes('Comms'), 'must show Comms in architecture');
    assert.ok(content.includes('Daemon'), 'must show Daemon in architecture');
    assert.ok(content.includes('Orchestrator'), 'must show Orchestrator in architecture');
    assert.ok(content.includes('Worker'), 'must show Workers in architecture');
  });
});
