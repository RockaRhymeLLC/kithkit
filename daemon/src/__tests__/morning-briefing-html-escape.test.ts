/**
 * Regression test: morning-briefing HTML escaping
 *
 * Root cause: email-summary senders stored with angle brackets
 * (e.g. "Acuity <scheduling@example.com>") were interpolated raw into
 * Telegram HTML messages. Telegram's parser rejected <scheduling@...> as
 * an unsupported tag → HTTP 400 → briefing never delivered.
 *
 * Fix: escapeHtml() is applied to every interpolated data value.
 * Section headers (<b>...</b>, <i>...</i>) are literal template strings
 * and are NOT passed through escapeHtml, so they remain real HTML tags.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, _resetDbForTesting, exec } from '../core/db.js';
import { getMigrationsDir } from '../core/migrations.js';
import { escapeHtml, gatherEmailSummary } from '../automation/tasks/morning-briefing.js';

describe('morning-briefing HTML escaping', () => {
  it('escapes angle-bracket email address — core bug fix', () => {
    const raw = 'Acuity <scheduling@example.com>';
    const escaped = escapeHtml(raw);
    assert.ok(
      escaped.includes('&lt;scheduling@example.com&gt;'),
      `expected escaped address, got: ${escaped}`,
    );
    assert.ok(
      !escaped.includes('<scheduling@example.com>'),
      'raw angle-bracket address must not appear in output',
    );
  });

  it('section headers stay as real HTML tags — not double-escaped', () => {
    // Section headers are literal strings in the template, not passed through
    // escapeHtml, so they must remain real markup in the final message.
    const emailData = 'From: Acuity <scheduling@example.com>\nSubject: Your appointment';
    const message = `<b>Email</b>\n${escapeHtml(emailData)}`;

    assert.ok(message.includes('<b>Email</b>'), 'section header must be real HTML tag');
    assert.ok(message.includes('&lt;scheduling@example.com&gt;'), 'data must be escaped');
    assert.ok(!message.includes('<scheduling@example.com>'), 'raw address must not appear');
  });

  it('ampersand is escaped first — no double-escaping', () => {
    assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
    // If & were not escaped first, applying < then > then & would produce
    // double-escapes like &amp;lt; for inputs that already contain &lt;
    assert.equal(
      escapeHtml('Tom &amp; Jerry <foo@example.com>'),
      'Tom &amp;amp; Jerry &lt;foo@example.com&gt;',
    );
  });

  it('null and undefined return empty string', () => {
    assert.equal(escapeHtml(null as unknown as string), '');
    assert.equal(escapeHtml(undefined as unknown as string), '');
  });

  it('empty string returns empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  it('plain text with no special chars is returned unchanged', () => {
    assert.equal(escapeHtml('Hello world'), 'Hello world');
  });

  // ── Production-path test: mutation target is escapeHtml() at the call site ──
  //
  // The 6 tests above verify the helper function works in isolation. They would
  // all pass even if someone deleted the escapeHtml() wrapper from the actual
  // call site in gatherEmailSummary (~line 479 of morning-briefing.ts).
  //
  // This nested describe drives the REAL production function with a fixture DB
  // row, so the test FAILS if the escapeHtml() wrapper is removed at the call site.

  describe('gatherEmailSummary — production path (mutation target: escapeHtml at call site)', () => {
    let tmpDir: string;

    before(() => {
      _resetDbForTesting();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kithkit-briefing-escape-'));
      const dbPath = path.join(tmpDir, 'kithkit.db');
      openDatabase(tmpDir, dbPath, getMigrationsDir());
      exec(
        `INSERT INTO task_results (task_name, status, output, started_at) VALUES (?, ?, ?, ?)`,
        'email-check',
        'success',
        'From: Acuity <scheduling@example.com>\nSubject: Your appointment',
        new Date().toISOString(),
      );
    });

    after(() => {
      _resetDbForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('gathers and escapes email data from DB — detects missing escapeHtml at call site', () => {
      const result = gatherEmailSummary();
      assert.ok(
        result.includes('&lt;scheduling@example.com&gt;'),
        `expected escaped address in output, got: ${result}`,
      );
      assert.ok(
        !result.includes('<scheduling@example.com>'),
        `raw angle-bracket address must not appear in output, got: ${result}`,
      );
    });
  });
});
