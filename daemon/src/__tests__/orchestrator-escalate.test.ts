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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskFields } from '../api/orchestrator.js';

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
