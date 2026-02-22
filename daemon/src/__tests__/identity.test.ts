/**
 * t-153, t-154, t-155: Identity system
 *
 * Tests identity parsing, starter templates, and role-based prompt generation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIdentity,
  loadIdentity,
  loadIdentityTemplates,
  getPromptForRole,
  IdentityParseError,
} from '../agents/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTemplatesDir(): string {
  return path.resolve(__dirname, '..', '..', '..', 'templates', 'identities');
}

describe('Identity System', { concurrency: 1 }, () => {

  // ── t-153: Identity file parsed correctly ──────────────────

  describe('Identity parser (t-153)', () => {
    it('extracts YAML frontmatter fields and markdown body', () => {
      const content = `---
name: TestBot
style: creative
humor: playful
voice: warm and expressive
traits:
  - imaginative
  - enthusiastic
---

You are a creative partner.

## Communication Style

- Be expressive and warm`;

      const identity = parseIdentity(content);
      assert.equal(identity.fields.name, 'TestBot');
      assert.equal(identity.fields.style, 'creative');
      assert.equal(identity.fields.humor, 'playful');
      assert.equal(identity.fields.voice, 'warm and expressive');
      assert.deepEqual(identity.fields.traits, ['imaginative', 'enthusiastic']);
      assert.ok(identity.body.includes('You are a creative partner.'));
      assert.ok(identity.body.includes('Be expressive and warm'));
    });

    it('applies defaults for optional fields', () => {
      const content = `---
name: MinimalBot
---

Just a bot.`;

      const identity = parseIdentity(content);
      assert.equal(identity.fields.name, 'MinimalBot');
      assert.equal(identity.fields.style, 'default');
      assert.equal(identity.fields.humor, 'none');
      assert.equal(identity.fields.voice, 'neutral');
      assert.equal(identity.fields.traits, undefined);
    });

    it('throws IdentityParseError for missing frontmatter', () => {
      assert.throws(
        () => parseIdentity('Just some text without frontmatter'),
        (err: Error) => {
          assert.ok(err instanceof IdentityParseError);
          assert.ok(err.message.includes('must start with YAML frontmatter'));
          return true;
        },
      );
    });

    it('throws IdentityParseError for unclosed frontmatter', () => {
      assert.throws(
        () => parseIdentity('---\nname: test\nno closing delimiter'),
        (err: Error) => {
          assert.ok(err instanceof IdentityParseError);
          assert.ok(err.message.includes('unclosed frontmatter'));
          return true;
        },
      );
    });

    it('throws IdentityParseError for missing name', () => {
      assert.throws(
        () => parseIdentity('---\nstyle: creative\n---\nbody'),
        (err: Error) => {
          assert.ok(err instanceof IdentityParseError);
          assert.ok(err.message.includes('name'));
          return true;
        },
      );
    });

    it('throws IdentityParseError for invalid YAML', () => {
      assert.throws(
        () => parseIdentity('---\n: broken yaml [[\n---\nbody'),
        (err: Error) => {
          assert.ok(err instanceof IdentityParseError);
          assert.ok(err.message.includes('Invalid YAML'));
          return true;
        },
      );
    });

    it('preserves extra frontmatter fields', () => {
      const content = `---
name: ExtendedBot
style: professional
custom_field: custom_value
another: 42
---

Body.`;

      const identity = parseIdentity(content);
      assert.equal(identity.fields.custom_field, 'custom_value');
      assert.equal(identity.fields.another, 42);
    });

    it('loads identity from real template file', () => {
      const identity = loadIdentity(path.join(getTemplatesDir(), 'professional.md'));
      assert.equal(identity.fields.style, 'professional');
      assert.ok(identity.body.length > 0);
    });

    it('throws for nonexistent file', () => {
      assert.throws(
        () => loadIdentity('/nonexistent/file.md'),
        (err: Error) => {
          assert.ok(err instanceof IdentityParseError);
          assert.ok(err.message.includes('not found'));
          return true;
        },
      );
    });
  });

  // ── t-154: Starter templates have distinct styles ──────────

  describe('Starter templates (t-154)', () => {
    it('loads all 3 templates', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      assert.equal(templates.size, 3, `Expected 3 templates, got ${templates.size}: ${[...templates.keys()].join(', ')}`);
    });

    it('contains professional, creative, and minimal', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      assert.ok(templates.has('professional'), 'Missing professional template');
      assert.ok(templates.has('creative'), 'Missing creative template');
      assert.ok(templates.has('minimal'), 'Missing minimal template');
    });

    it('templates have distinct styles', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      const styles = new Set<string>();
      for (const [, identity] of templates) {
        styles.add(identity.fields.style);
      }
      assert.equal(styles.size, 3, 'Each template should have a unique style');
    });

    it('templates have distinct humor settings', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      const professional = templates.get('professional')!;
      const creative = templates.get('creative')!;
      const minimal = templates.get('minimal')!;

      assert.equal(professional.fields.humor, 'minimal');
      assert.equal(creative.fields.humor, 'playful');
      assert.equal(minimal.fields.humor, 'none');
    });

    it('minimal template is bare-bones', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      const minimal = templates.get('minimal')!;
      const professional = templates.get('professional')!;

      assert.ok(
        minimal.body.length < professional.body.length,
        'Minimal body should be shorter than professional',
      );
      assert.equal(minimal.fields.traits, undefined, 'Minimal should have no traits');
    });

    it('all templates have valid names', () => {
      const templates = loadIdentityTemplates(getTemplatesDir());
      for (const [, identity] of templates) {
        assert.equal(typeof identity.fields.name, 'string');
        assert.ok(identity.fields.name.length > 0);
      }
    });

    it('returns empty map for nonexistent directory', () => {
      const templates = loadIdentityTemplates('/nonexistent/dir');
      assert.equal(templates.size, 0);
    });
  });

  // ── t-155: Identity applied only to comms agent ────────────

  describe('Role-based identity (t-155)', () => {
    const testIdentity = parseIdentity(`---
name: TestBot
style: creative
humor: playful
voice: warm and bubbly
traits:
  - friendly
  - curious
---

You are a friendly test bot.

## Rules
- Be helpful.`);

    it('comms gets full identity (name, style, humor, voice, traits, body)', () => {
      const prompt = getPromptForRole(testIdentity, 'comms');
      assert.ok(prompt.includes('TestBot'), 'Should include name');
      assert.ok(prompt.includes('creative'), 'Should include style');
      assert.ok(prompt.includes('playful'), 'Should include humor');
      assert.ok(prompt.includes('warm and bubbly'), 'Should include voice');
      assert.ok(prompt.includes('friendly'), 'Should include traits');
      assert.ok(prompt.includes('curious'), 'Should include traits');
      assert.ok(prompt.includes('You are a friendly test bot'), 'Should include body');
      assert.ok(prompt.includes('Be helpful'), 'Should include rules');
    });

    it('orchestrator gets role prompt only (no personality)', () => {
      const prompt = getPromptForRole(testIdentity, 'orchestrator');
      assert.ok(prompt.includes('orchestrator'), 'Should mention orchestrator role');
      assert.ok(prompt.includes('structured JSON'), 'Should mention structured output');
      assert.ok(!prompt.includes('TestBot'), 'Should NOT include identity name');
      assert.ok(!prompt.includes('playful'), 'Should NOT include humor');
      assert.ok(!prompt.includes('warm and bubbly'), 'Should NOT include voice');
      assert.ok(!prompt.includes('friendly test bot'), 'Should NOT include personality');
    });

    it('worker gets empty string (no identity)', () => {
      const prompt = getPromptForRole(testIdentity, 'worker');
      assert.equal(prompt, '', 'Worker prompt should be empty');
    });

    it('comms omits default-value fields from prompt', () => {
      const minIdentity = parseIdentity(`---
name: Plain
---

Just plain.`);

      const prompt = getPromptForRole(minIdentity, 'comms');
      assert.ok(prompt.includes('Plain'), 'Should include name');
      assert.ok(!prompt.includes('Communication style: default'), 'Should omit default style');
      assert.ok(!prompt.includes('Humor: none'), 'Should omit none humor');
      assert.ok(!prompt.includes('Voice: neutral'), 'Should omit neutral voice');
      assert.ok(prompt.includes('Just plain.'), 'Should include body');
    });

    it('comms includes traits when present', () => {
      const prompt = getPromptForRole(testIdentity, 'comms');
      assert.ok(prompt.includes('friendly, curious'), 'Should list traits');
    });
  });
});
