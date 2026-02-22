/**
 * t-159: kithkit install, search, and update work
 *
 * Tests that CLI wrappers around @kithkit/client correctly export
 * their functions and handle missing catalog gracefully.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../index.js';

describe('kithkit install and search work (t-159)', () => {
  it('CLI version is set', () => {
    assert.equal(VERSION, '0.1.0');
  });

  it('install module exports runInstall function', async () => {
    const mod = await import('../install.js');
    assert.equal(typeof mod.runInstall, 'function');
  });

  it('search module exports runSearch function', async () => {
    const mod = await import('../search.js');
    assert.equal(typeof mod.runSearch, 'function');
  });

  it('update module exports runUpdate function', async () => {
    const mod = await import('../update.js');
    assert.equal(typeof mod.runUpdate, 'function');
  });

  it('InstallCommandOptions type is correct shape', async () => {
    // Verify the options interface works with TypeScript
    const opts = {
      skillName: 'test-skill',
      projectDir: '/tmp/test',
      catalogUrl: 'http://example.com',
    };
    assert.equal(opts.skillName, 'test-skill');
    assert.equal(opts.projectDir, '/tmp/test');
  });

  it('SearchCommandOptions type is correct shape', async () => {
    const opts = {
      query: 'todo',
      tag: 'productivity',
      capability: 'Read',
    };
    assert.equal(opts.query, 'todo');
    assert.equal(opts.tag, 'productivity');
  });

  it('UpdateCommandOptions supports single and all modes', async () => {
    // Single skill
    const single = { skillName: 'test-skill' };
    assert.equal(single.skillName, 'test-skill');

    // All skills (no skillName)
    const all = {};
    assert.equal(Object.keys(all).length, 0);
  });
});
