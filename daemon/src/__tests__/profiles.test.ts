/**
 * t-134, t-135, t-136: Agent profiles
 *
 * Tests profile parsing, validation, and built-in profile loading.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseProfileContent,
  validateProfile,
  loadProfile,
  loadProfiles,
  ProfileValidationError,
} from '../agents/profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Built-in profiles directory (relative to compiled test location)
function getProfilesDir(): string {
  // From dist/__tests__/ → ../../profiles/
  const fromDist = path.resolve(__dirname, '..', '..', '..', 'profiles');
  // From src/__tests__/ → ../../profiles/
  const fromSrc = path.resolve(__dirname, '..', '..', '..', 'profiles');
  return fromDist;
}

describe('Agent Profiles', { concurrency: 1 }, () => {

  // ── t-134: Profile parser extracts frontmatter and body ────────

  describe('Profile parser (t-134)', () => {
    it('extracts YAML frontmatter and markdown body', () => {
      const content = `---
name: research
description: A research worker
model: sonnet
---

You are a research assistant.

Rules:
- Be thorough.`;

      const { frontmatter, body } = parseProfileContent(content);
      assert.equal(frontmatter.name, 'research');
      assert.equal(frontmatter.description, 'A research worker');
      assert.equal(frontmatter.model, 'sonnet');
      assert.ok(body.includes('You are a research assistant.'));
      assert.ok(body.includes('Be thorough'));
    });

    it('extracts all 7 core fields from frontmatter', () => {
      const content = `---
name: test-profile
description: Test description
tools:
  - Read
  - Glob
disallowedTools:
  - Bash
model: sonnet
permissionMode: bypassPermissions
maxTurns: 15
---

Profile body.`;

      const { frontmatter, body } = parseProfileContent(content);
      assert.equal(frontmatter.name, 'test-profile');
      assert.equal(frontmatter.description, 'Test description');
      assert.deepEqual(frontmatter.tools, ['Read', 'Glob']);
      assert.deepEqual(frontmatter.disallowedTools, ['Bash']);
      assert.equal(frontmatter.model, 'sonnet');
      assert.equal(frontmatter.permissionMode, 'bypassPermissions');
      assert.equal(frontmatter.maxTurns, 15);
      assert.equal(body, 'Profile body.');
    });

    it('ignores unknown frontmatter fields (forward-compatible)', () => {
      const content = `---
name: future-profile
futureField: some-value
anotherFuture: 42
---

Body.`;

      const { frontmatter } = parseProfileContent(content);
      assert.equal(frontmatter.name, 'future-profile');
      assert.equal(frontmatter.futureField, 'some-value');

      // Validate — unknown fields should not cause errors
      const profile = validateProfile(frontmatter, 'Body.');
      assert.equal(profile.name, 'future-profile');
    });

    it('handles content without frontmatter', () => {
      const content = 'Just a plain markdown file.';
      const { frontmatter, body } = parseProfileContent(content);
      assert.deepEqual(frontmatter, {});
      assert.equal(body, 'Just a plain markdown file.');
    });

    it('handles empty body', () => {
      const content = `---
name: no-body
---`;

      const { frontmatter, body } = parseProfileContent(content);
      assert.equal(frontmatter.name, 'no-body');
      assert.equal(body, '');
    });
  });

  // ── t-135: Profile validator catches invalid profiles ──────────

  describe('Profile validator (t-135)', () => {
    it('rejects profile missing name', () => {
      assert.throws(
        () => validateProfile({}, 'body'),
        (err: Error) => {
          assert.ok(err instanceof ProfileValidationError);
          assert.ok(err.message.includes('name is required'));
          return true;
        },
      );
    });

    it('rejects invalid permissionMode', () => {
      assert.throws(
        () => validateProfile({ name: 'test', permissionMode: 'admin' }, 'body'),
        (err: Error) => {
          assert.ok(err instanceof ProfileValidationError);
          assert.ok(err.message.includes('invalid permissionMode'));
          return true;
        },
      );
    });

    it('accepts valid profile and applies defaults', () => {
      const profile = validateProfile({ name: 'minimal' }, 'Body text.');
      assert.equal(profile.name, 'minimal');
      assert.equal(profile.model, 'sonnet', 'Default model should be sonnet');
      assert.equal(profile.permissionMode, 'bypassPermissions', 'Default permissionMode');
      assert.equal(profile.maxTurns, 20, 'Default maxTurns');
      assert.deepEqual(profile.tools, []);
      assert.deepEqual(profile.disallowedTools, []);
      assert.equal(profile.description, '');
      assert.equal(profile.body, 'Body text.');
    });

    it('rejects invalid maxTurns', () => {
      assert.throws(
        () => validateProfile({ name: 'test', maxTurns: -1 }, ''),
        (err: Error) => {
          assert.ok(err instanceof ProfileValidationError);
          assert.ok(err.message.includes('maxTurns'));
          return true;
        },
      );
    });

    it('rejects non-array tools', () => {
      assert.throws(
        () => validateProfile({ name: 'test', tools: 'Read' }, ''),
        (err: Error) => {
          assert.ok(err instanceof ProfileValidationError);
          assert.ok(err.message.includes('tools must be an array'));
          return true;
        },
      );
    });

    it('accepts all valid permission modes', () => {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan']) {
        const profile = validateProfile({ name: 'test', permissionMode: mode }, '');
        assert.equal(profile.permissionMode, mode);
      }
    });

    it('throws ProfileValidationError for invalid YAML', () => {
      assert.throws(
        () => parseProfileContent('---\n: invalid yaml [[\n---\nbody'),
        (err: Error) => {
          assert.ok(err instanceof ProfileValidationError);
          assert.ok(err.message.includes('Invalid YAML'));
          return true;
        },
      );
    });
  });

  // ── t-136: All 6 built-in profiles are valid ───────────────────

  describe('Built-in profiles (t-136)', () => {
    const profilesDir = getProfilesDir();

    it('finds exactly 6 built-in profiles', () => {
      const profiles = loadProfiles(profilesDir);
      assert.equal(profiles.size, 6, `Expected 6 profiles, got ${profiles.size}: ${[...profiles.keys()].join(', ')}`);
    });

    it('loads all expected profile names', () => {
      const profiles = loadProfiles(profilesDir);
      const expected = ['research', 'coding', 'testing', 'email', 'review', 'devils-advocate'];
      for (const name of expected) {
        assert.ok(profiles.has(name), `Missing profile: ${name}`);
      }
    });

    it('research profile has read-only tools', () => {
      const profile = loadProfile(path.join(profilesDir, 'research.md'));
      assert.equal(profile.name, 'research');
      assert.ok(profile.tools.includes('Read'));
      assert.ok(profile.tools.includes('Glob'));
      assert.ok(profile.tools.includes('Grep'));
      assert.ok(profile.disallowedTools.includes('Bash'));
      assert.ok(profile.disallowedTools.includes('Edit'));
      assert.ok(profile.disallowedTools.includes('Write'));
    });

    it('coding profile has edit/write tools', () => {
      const profile = loadProfile(path.join(profilesDir, 'coding.md'));
      assert.equal(profile.name, 'coding');
      assert.ok(profile.tools.includes('Edit'));
      assert.ok(profile.tools.includes('Write'));
      assert.ok(profile.tools.includes('Bash'));
    });

    it('testing profile has bash for test runners', () => {
      const profile = loadProfile(path.join(profilesDir, 'testing.md'));
      assert.equal(profile.name, 'testing');
      assert.ok(profile.tools.includes('Bash'));
      assert.ok(profile.disallowedTools.includes('Edit'));
    });

    it('all built-in profiles default to sonnet model', () => {
      const profiles = loadProfiles(profilesDir);
      for (const [name, profile] of profiles) {
        assert.equal(profile.model, 'sonnet', `${name} should use sonnet model`);
      }
    });

    it('all built-in profiles have non-empty body', () => {
      const profiles = loadProfiles(profilesDir);
      for (const [name, profile] of profiles) {
        assert.ok(profile.body.length > 0, `${name} should have a body`);
      }
    });

    it('all built-in profiles have descriptions', () => {
      const profiles = loadProfiles(profilesDir);
      for (const [name, profile] of profiles) {
        assert.ok(profile.description.length > 0, `${name} should have a description`);
      }
    });
  });
});
