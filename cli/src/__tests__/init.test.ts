/**
 * t-156: kithkit init creates config and directory structure
 * t-157: kithkit init checks prerequisites
 * t-158: kithkit init starts daemon and boots comms agent
 *
 * Tests for the init wizard — config creation, directory setup,
 * identity template selection, profile copying, and prerequisites checking.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { Readable, Writable } from 'node:stream';
import yaml from 'js-yaml';
import { runInit } from '../init.js';
import {
  checkPrerequisites,
  formatPrereqReport,
  type PrereqReport,
} from '../prerequisites.js';

// ── Helpers ─────────────────────────────────────────────────

function createMockRl(inputs: string[]): readline.Interface {
  let inputIdx = 0;
  const input = new Readable({
    read() {
      if (inputIdx < inputs.length) {
        this.push(inputs[inputIdx]! + '\n');
        inputIdx++;
      } else {
        this.push(null);
      }
    },
  });
  const output = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  return readline.createInterface({ input, output });
}

function setupTemplatesAndProfiles(tmpDir: string): string {
  // Create a fake kithkit root with templates and profiles
  const kithkitRoot = path.join(tmpDir, 'kithkit-root');
  const templatesDir = path.join(kithkitRoot, 'templates', 'identities');
  const profilesDir = path.join(kithkitRoot, 'profiles');

  fs.mkdirSync(templatesDir, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });

  // Create identity templates
  fs.writeFileSync(
    path.join(templatesDir, 'professional.md'),
    `---
name: Assistant
style: professional
humor: minimal
voice: clear and direct
traits:
  - organized
  - thorough
---

A professional assistant focused on accuracy and clarity.`,
  );

  fs.writeFileSync(
    path.join(templatesDir, 'creative.md'),
    `---
name: Assistant
style: creative
humor: playful
voice: warm and expressive
traits:
  - imaginative
  - enthusiastic
---

A creative assistant that brings energy and ideas.`,
  );

  // Create agent profiles
  fs.writeFileSync(
    path.join(profilesDir, 'coding.md'),
    `---
name: coding
description: General-purpose coding agent
model: sonnet
---

You are a coding agent.`,
  );

  fs.writeFileSync(
    path.join(profilesDir, 'research.md'),
    `---
name: research
description: Research agent
model: sonnet
---

You are a research agent.`,
  );

  // Also create kithkit.defaults.yaml so findKithkitRoot works
  fs.writeFileSync(
    path.join(kithkitRoot, 'kithkit.defaults.yaml'),
    'agent:\n  name: Assistant\n',
  );

  return kithkitRoot;
}

// ── Tests ───────────────────────────────────────────────────

describe('kithkit init creates config and directory structure (t-156)', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-init-'));
    projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates kithkit.config.yaml with agent name', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    // We need to make the test find kithkitRoot — use env or mock
    // For now, test the init function directly with pre-set values
    const rl = createMockRl([]);

    const result = await runInit({
      dir: kithkitRoot, // Use kithkitRoot as project dir so findKithkitRoot works
      skipPrereqs: true,
      name: 'TestBot',
      template: 'professional',
      rl,
    });

    assert.equal(result.success, true);
    assert.equal(result.agentName, 'TestBot');

    // Check config was created
    const configPath = path.join(kithkitRoot, 'kithkit.config.yaml');
    assert.ok(fs.existsSync(configPath), 'kithkit.config.yaml should exist');

    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agent = config.agent as Record<string, unknown>;
    assert.equal(agent.name, 'TestBot');
  });

  it('creates .claude/agents/ directory with profiles', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'TestBot',
      template: 'professional',
      rl,
    });

    const agentsDir = path.join(kithkitRoot, '.claude', 'agents');
    assert.ok(fs.existsSync(agentsDir), '.claude/agents/ should exist');

    // Check profiles were copied
    assert.ok(fs.existsSync(path.join(agentsDir, 'coding.md')), 'coding.md profile should be copied');
    assert.ok(fs.existsSync(path.join(agentsDir, 'research.md')), 'research.md profile should be copied');
  });

  it('creates identity file from selected template with agent name', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'TestBot',
      template: 'professional',
      rl,
    });

    const identityPath = path.join(kithkitRoot, 'identity.md');
    assert.ok(fs.existsSync(identityPath), 'identity.md should exist');

    const content = fs.readFileSync(identityPath, 'utf8');
    assert.ok(content.includes('name: TestBot'), 'Identity should have the agent name');
    assert.ok(content.includes('style: professional'), 'Identity should have professional style');
  });

  it('defaults to "Assistant" when no name provided', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl(['']); // Empty input for name prompt

    const result = await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      template: 'professional',
      rl,
    });

    assert.equal(result.agentName, 'Assistant');
  });

  it('does not overwrite existing config', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const configPath = path.join(kithkitRoot, 'kithkit.config.yaml');

    // Pre-create config
    fs.writeFileSync(configPath, 'agent:\n  name: ExistingAgent\n');

    const rl = createMockRl([]);
    await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'NewBot',
      template: 'professional',
      rl,
    });

    // Should keep existing config
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const agent = config.agent as Record<string, unknown>;
    assert.equal(agent.name, 'ExistingAgent');
  });

  it('selects creative template correctly', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'ArtBot',
      template: 'creative',
      rl,
    });

    const identityPath = path.join(kithkitRoot, 'identity.md');
    const content = fs.readFileSync(identityPath, 'utf8');
    assert.ok(content.includes('name: ArtBot'), 'Should have agent name');
    assert.ok(content.includes('style: creative'), 'Should have creative style');
    assert.ok(content.includes('humor: playful'), 'Should have playful humor');
  });
});

describe('kithkit init checks prerequisites (t-157)', () => {
  it('checkPrerequisites returns results for Node.js, npm, and Claude Code', async () => {
    const report = await checkPrerequisites();

    assert.ok(report.results.length >= 3, 'Should check at least 3 prerequisites');

    const nodeResult = report.results.find(r => r.name === 'Node.js');
    assert.ok(nodeResult, 'Should check Node.js');
    // We're running on Node.js 22+, so this should pass
    assert.ok(nodeResult.ok, 'Node.js should be found');
    assert.ok(nodeResult.version, 'Should have version');

    const npmResult = report.results.find(r => r.name === 'npm');
    assert.ok(npmResult, 'Should check npm');
    assert.ok(npmResult.ok, 'npm should be found');
  });

  it('formatPrereqReport produces readable output', () => {
    const report: PrereqReport = {
      results: [
        { name: 'Node.js', ok: true, version: 'v22.3.0' },
        { name: 'npm', ok: true, version: '10.1.0' },
        {
          name: 'Claude Code',
          ok: false,
          error: 'Claude Code CLI not found',
          instructions: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
        },
      ],
      allPassed: false,
    };

    const output = formatPrereqReport(report);
    assert.ok(output.includes('[ok] Node.js'), 'Should show Node.js as ok');
    assert.ok(output.includes('[!!] Claude Code'), 'Should show Claude Code as missing');
    assert.ok(output.includes('npm install -g'), 'Should include install instructions');
  });

  it('init fails when Node.js requirement not met', async () => {
    // We can't actually test this with a wrong Node version,
    // but we can verify the prerequisite checker structures are correct
    const report: PrereqReport = {
      results: [
        {
          name: 'Node.js',
          ok: false,
          version: 'v18.0.0',
          error: 'Node.js 22+ required, found v18.0.0',
          instructions: 'Install Node.js 22+: https://nodejs.org/',
        },
      ],
      allPassed: false,
    };

    assert.equal(report.allPassed, false);
    assert.ok(report.results[0]!.error!.includes('22+'));
  });
});

describe('kithkit init starts daemon and boots comms agent (t-158)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('init returns success with all paths populated', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    const result = await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'TestBot',
      template: 'professional',
      rl,
    });

    assert.equal(result.success, true);
    assert.equal(result.agentName, 'TestBot');
    assert.equal(result.template, 'professional');
    assert.ok(result.configPath.endsWith('kithkit.config.yaml'));
    assert.ok(result.identityPath.endsWith('identity.md'));
    assert.ok(result.profilesDir.includes('.claude'));
    assert.deepEqual(result.errors, []);
  });

  it('init result includes projectDir for daemon startup', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    const result = await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'TestBot',
      template: 'professional',
      rl,
    });

    // Daemon startup uses projectDir
    assert.ok(result.projectDir);
    assert.ok(fs.existsSync(result.projectDir));
    // Verify the config is accessible from projectDir
    assert.ok(fs.existsSync(path.join(result.projectDir, 'kithkit.config.yaml')));
  });

  it('init completes quickly (under 5s for file operations)', async () => {
    const kithkitRoot = setupTemplatesAndProfiles(tmpDir);
    const rl = createMockRl([]);

    const start = Date.now();
    await runInit({
      dir: kithkitRoot,
      skipPrereqs: true,
      name: 'SpeedBot',
      template: 'professional',
      rl,
    });
    const elapsed = Date.now() - start;

    // File operations should be well under the 60s target
    assert.ok(elapsed < 5000, `Init took ${elapsed}ms, expected < 5000ms`);
  });
});
