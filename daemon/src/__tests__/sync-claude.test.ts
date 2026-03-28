/**
 * Tests for sync-claude.ts settings.json merge logic.
 *
 * Verifies the three merge rules:
 *   1. Source top-level keys win over destination.
 *   2. Destination-only top-level keys are preserved (e.g. `permissions`).
 *   3. Hook event arrays are merged: source hooks first, then destination-only hooks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings } from '../api/sync-claude.js';

// ── helpers ────────────────────────────────────────────────────────────────

function hookEntry(command: string, extra: Record<string, unknown> = {}) {
  return { ...extra, hooks: [{ type: 'command', command }] };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('mergeSettings', () => {
  it('source top-level keys win over destination', () => {
    const src = { statusLine: { type: 'command', command: 'new.sh' } };
    const dst = { statusLine: { type: 'command', command: 'old.sh' } };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    assert.deepStrictEqual(result['statusLine'], src.statusLine);
  });

  it('preserves destination-only top-level keys (permissions block)', () => {
    const src = { statusLine: { type: 'command', command: 'status.sh' } };
    const dst = {
      permissions: {
        allow: ['.*'],
        deny: [],
        defaultMode: 'bypassPermissions',
      },
    };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    assert.deepStrictEqual(result['permissions'], dst.permissions);
    assert.deepStrictEqual(result['statusLine'], src.statusLine);
  });

  it('source hooks are kept when destination has no hooks for that event', () => {
    const src = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
      },
    };
    const dst = {};
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    const hooks = result['hooks'] as Record<string, unknown[]>;
    assert.ok(Array.isArray(hooks['Stop']));
    assert.strictEqual(hooks['Stop'].length, 1);
  });

  it('destination-only hooks survive sync (instance-specific hooks preserved)', () => {
    const src = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
      },
    };
    const dst = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
        SessionStart: [hookEntry('/kithkit/hooks/session-start.sh')],
        PreToolUse: [hookEntry('/kithkit/hooks/branch-guard.sh')],
      },
    };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    const hooks = result['hooks'] as Record<string, unknown[]>;

    // Stop: no duplication — source already has the command
    assert.strictEqual(hooks['Stop'].length, 1);

    // SessionStart: destination-only event — preserved
    assert.ok(Array.isArray(hooks['SessionStart']));
    assert.strictEqual(hooks['SessionStart'].length, 1);

    // PreToolUse: destination-only event — preserved
    assert.ok(Array.isArray(hooks['PreToolUse']));
    assert.strictEqual(hooks['PreToolUse'].length, 1);
  });

  it('source hooks come first, destination-only hooks are appended', () => {
    const src = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
      },
    };
    const dst = {
      hooks: {
        Stop: [
          hookEntry('/kithkit/hooks/notify-response.sh'),
          hookEntry('/kithkit/hooks/memory-extraction.sh'),
        ],
      },
    };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    const hooks = result['hooks'] as Record<string, unknown[]>;
    const stop = hooks['Stop'] as Array<{ hooks: Array<{ command: string }> }>;

    // memory-extraction comes from source (first), notify-response appended from dst
    assert.strictEqual(stop.length, 2);
    assert.strictEqual(stop[0].hooks[0].command, '/kithkit/hooks/memory-extraction.sh');
    assert.strictEqual(stop[1].hooks[0].command, '/kithkit/hooks/notify-response.sh');
  });

  it('no duplicate hooks when source and destination have the same command', () => {
    const src = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
      },
    };
    const dst = {
      hooks: {
        Stop: [hookEntry('/kithkit/hooks/memory-extraction.sh')],
      },
    };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    const hooks = result['hooks'] as Record<string, unknown[]>;
    assert.strictEqual(hooks['Stop'].length, 1);
  });

  it('full integration: permissions preserved, source hooks win, instance hooks appended', () => {
    const src = {
      statusLine: { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/scripts/context-monitor-statusline.sh' },
      hooks: {
        PreCompact: [hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/pre-compact.sh', { timeout: 10 })],
        Stop: [hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/memory-extraction.sh', { async: true, timeout: 120 })],
      },
    };
    const dst = {
      permissions: {
        allow: ['.*'],
        deny: [],
        defaultMode: 'bypassPermissions',
      },
      hooks: {
        PreCompact: [hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/pre-compact.sh', { timeout: 10 })],
        Stop: [
          hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/notify-response.sh', { timeout: 15 }),
          hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/memory-extraction.sh', { async: true, timeout: 120 }),
        ],
        SessionStart: [hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/session-start.sh', { timeout: 10 })],
        UserPromptSubmit: [
          hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/memory-context.py', { timeout: 5 }),
          hookEntry('"$CLAUDE_PROJECT_DIR"/.kithkit/hooks/set-channel.sh', { timeout: 5 }),
        ],
      },
    };
    const result = mergeSettings(
      src as Record<string, unknown>,
      dst as Record<string, unknown>,
    );
    const hooks = result['hooks'] as Record<string, unknown[]>;

    // permissions preserved from dst
    assert.deepStrictEqual(result['permissions'], dst.permissions);

    // statusLine updated from src
    assert.deepStrictEqual(result['statusLine'], src.statusLine);

    // PreCompact: no dup
    assert.strictEqual(hooks['PreCompact'].length, 1);

    // Stop: src memory-extraction first, dst notify-response appended
    assert.strictEqual(hooks['Stop'].length, 2);
    const stop = hooks['Stop'] as Array<{ hooks: Array<{ command: string }> }>;
    assert.ok(stop[0].hooks[0].command.includes('memory-extraction'));
    assert.ok(stop[1].hooks[0].command.includes('notify-response'));

    // SessionStart: dst-only event preserved
    assert.strictEqual(hooks['SessionStart'].length, 1);

    // UserPromptSubmit: dst-only event preserved (both hooks)
    assert.strictEqual(hooks['UserPromptSubmit'].length, 2);
  });
});
