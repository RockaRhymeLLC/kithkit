/**
 * Regression test for #586 — stale state-path bug.
 *
 * After migration, the authoritative session state moved from .claude/state/
 * to .kithkit/state/. Both SessionStart and PreCompact hooks must reference
 * .kithkit/hooks/ scripts (which use STATE_DIR=.kithkit/state) — not the
 * stale .claude/hooks/ scripts (which use STATE_DIR=.claude/state).
 *
 * Root cause (pre-fix):
 *   - .claude/settings.json SessionStart → .claude/hooks/session-start.sh
 *     (uses .claude/state — stale)
 *   - .claude/settings.json PreCompact → .claude/hooks/pre-compact.sh
 *     (uses .claude/state — stale; fires second and wins after a sync
 *     appended the stale entry after the correct .kithkit entry)
 *
 * Fix:
 *   - .kithkit/settings.json now registers SessionStart → .kithkit/hooks/session-start.sh
 *     (makes future syncs propagate the correct entry as the source)
 *   - .claude/settings.json SessionStart → .kithkit/hooks/session-start.sh
 *   - .claude/settings.json PreCompact → .kithkit/hooks/pre-compact.sh
 *
 * These tests FAIL against the unfixed config (pre-#586 committed state):
 *   - SessionStart in .claude/settings.json pointed to .claude/hooks/session-start.sh
 *   - PreCompact in .claude/settings.json only referenced .claude/hooks/pre-compact.sh
 *   - .kithkit/settings.json had no SessionStart entry at all
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve project root from compiled location: daemon/dist/__tests__/ → project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface SettingsJson {
  hooks?: Record<string, HookEntry[]>;
}

/** Flatten all command strings from an array of HookEntry objects. */
function extractCommands(entries: HookEntry[]): string[] {
  return entries.flatMap((entry) =>
    (entry.hooks ?? []).map((h) => h.command),
  );
}

// Load both settings files once at module scope so parse errors surface early.
const claudeSettingsPath = path.join(PROJECT_ROOT, '.claude', 'settings.json');
const kithkitSettingsPath = path.join(PROJECT_ROOT, '.kithkit', 'settings.json');

const claudeSettings = JSON.parse(
  fs.readFileSync(claudeSettingsPath, 'utf8'),
) as SettingsJson;

const kithkitSettings = JSON.parse(
  fs.readFileSync(kithkitSettingsPath, 'utf8'),
) as SettingsJson;

describe('settings-hooks regression (#586) — stale state-path', () => {
  // ── .claude/settings.json — SessionStart ────────────────────────────────

  describe('.claude/settings.json SessionStart hooks', () => {
    it('has at least one SessionStart hook registered', () => {
      const sessionStart = claudeSettings.hooks?.['SessionStart'] ?? [];
      assert.ok(
        sessionStart.length > 0,
        '.claude/settings.json must have at least one SessionStart hook',
      );
    });

    it('no SessionStart hook references the stale .claude/hooks/session-start.sh', () => {
      const sessionStart = claudeSettings.hooks?.['SessionStart'] ?? [];
      const commands = extractCommands(sessionStart);
      const stale = commands.find((cmd) =>
        cmd.includes('.claude/hooks/session-start.sh'),
      );
      assert.equal(
        stale,
        undefined,
        `SessionStart must not register .claude/hooks/session-start.sh ` +
          `(that script uses STATE_DIR=.claude/state — stale post-migration). ` +
          `Found: ${stale}`,
      );
    });

    it('at least one SessionStart hook references the authoritative .kithkit/hooks/session-start.sh', () => {
      const sessionStart = claudeSettings.hooks?.['SessionStart'] ?? [];
      const commands = extractCommands(sessionStart);
      const correct = commands.find((cmd) =>
        cmd.includes('.kithkit/hooks/session-start.sh'),
      );
      assert.ok(
        correct !== undefined,
        `SessionStart must register .kithkit/hooks/session-start.sh ` +
          `(uses STATE_DIR=.kithkit/state — the authoritative post-migration path). ` +
          `Registered commands: ${commands.join(', ')}`,
      );
    });
  });

  // ── .claude/settings.json — PreCompact ──────────────────────────────────

  describe('.claude/settings.json PreCompact hooks', () => {
    it('no PreCompact hook references the stale .claude/hooks/pre-compact.sh', () => {
      const preCompact = claudeSettings.hooks?.['PreCompact'] ?? [];
      const commands = extractCommands(preCompact);
      const stale = commands.find((cmd) =>
        cmd.includes('.claude/hooks/pre-compact.sh'),
      );
      assert.equal(
        stale,
        undefined,
        `PreCompact must not register .claude/hooks/pre-compact.sh ` +
          `(that script uses STATE_DIR=.claude/state — stale post-migration, ` +
          `and it fires second after a sync-appended duplicate, overwriting ` +
          `the correct .kithkit/state instruction). Found: ${stale}`,
      );
    });

    it('at least one PreCompact hook references the authoritative .kithkit/hooks/pre-compact.sh', () => {
      const preCompact = claudeSettings.hooks?.['PreCompact'] ?? [];
      const commands = extractCommands(preCompact);
      const correct = commands.find((cmd) =>
        cmd.includes('.kithkit/hooks/pre-compact.sh'),
      );
      assert.ok(
        correct !== undefined,
        `PreCompact must register .kithkit/hooks/pre-compact.sh. ` +
          `Registered commands: ${commands.join(', ')}`,
      );
    });
  });

  // ── .kithkit/settings.json — authoritative source ───────────────────────

  describe('.kithkit/settings.json — authoritative source registrations', () => {
    it('registers SessionStart → .kithkit/hooks/session-start.sh', () => {
      const sessionStart = kithkitSettings.hooks?.['SessionStart'] ?? [];
      const commands = extractCommands(sessionStart);
      const correct = commands.find((cmd) =>
        cmd.includes('.kithkit/hooks/session-start.sh'),
      );
      assert.ok(
        correct !== undefined,
        `.kithkit/settings.json must register SessionStart → .kithkit/hooks/session-start.sh ` +
          `so that future sync runs propagate the correct hook as a source entry, ` +
          `preventing the stale .claude/ entry from surviving as a destination-only append.`,
      );
    });

    it('has no hooks referencing .claude/hooks/session-start.sh', () => {
      const allEntries = Object.values(kithkitSettings.hooks ?? {}).flat() as HookEntry[];
      const commands = extractCommands(allEntries);
      const stale = commands.find((cmd) =>
        cmd.includes('.claude/hooks/session-start.sh'),
      );
      assert.equal(
        stale,
        undefined,
        `.kithkit/settings.json must not reference .claude/hooks/session-start.sh: ` +
          `found ${stale}`,
      );
    });
  });

  // ── Cross-file: sync stability ───────────────────────────────────────────

  describe('sync stability — fixed config survives a merge', () => {
    /**
     * Simulate what mergeSettings() would produce when the daemon runs
     * POST /api/sync/claude with our fixed files. Verify the stale entries
     * do not re-appear in the merged output.
     *
     * We inline a simplified merge here to avoid importing the compiled
     * daemon module (which would require a full build and db init).
     */
    it('simulated sync does not re-introduce stale session-start.sh', () => {
      // Simplified merge: source hooks first, then dst-only hooks appended
      function simpleMergeHookEvent(
        srcEntries: HookEntry[],
        dstEntries: HookEntry[],
      ): string[] {
        const srcCmds = new Set(extractCommands(srcEntries));
        const extra = dstEntries.filter((e) =>
          extractCommands([e]).every((c) => !srcCmds.has(c)),
        );
        return extractCommands([...srcEntries, ...extra]);
      }

      const srcSessionStart =
        (kithkitSettings.hooks?.['SessionStart'] ?? []) as HookEntry[];
      const dstSessionStart =
        (claudeSettings.hooks?.['SessionStart'] ?? []) as HookEntry[];

      const merged = simpleMergeHookEvent(srcSessionStart, dstSessionStart);

      // After merge, stale script must not appear
      const stale = merged.find((cmd) =>
        cmd.includes('.claude/hooks/session-start.sh'),
      );
      assert.equal(
        stale,
        undefined,
        `After a simulated sync, .claude/hooks/session-start.sh must not appear ` +
          `in the merged SessionStart hooks. Merged: ${merged.join(', ')}`,
      );

      // Authoritative script must still be present
      const correct = merged.find((cmd) =>
        cmd.includes('.kithkit/hooks/session-start.sh'),
      );
      assert.ok(
        correct !== undefined,
        `After a simulated sync, .kithkit/hooks/session-start.sh must remain ` +
          `in the merged SessionStart hooks. Merged: ${merged.join(', ')}`,
      );
    });

    it('simulated sync does not re-introduce stale pre-compact.sh', () => {
      function simpleMergeHookEvent(
        srcEntries: HookEntry[],
        dstEntries: HookEntry[],
      ): string[] {
        const srcCmds = new Set(extractCommands(srcEntries));
        const extra = dstEntries.filter((e) =>
          extractCommands([e]).every((c) => !srcCmds.has(c)),
        );
        return extractCommands([...srcEntries, ...extra]);
      }

      const srcPreCompact =
        (kithkitSettings.hooks?.['PreCompact'] ?? []) as HookEntry[];
      const dstPreCompact =
        (claudeSettings.hooks?.['PreCompact'] ?? []) as HookEntry[];

      const merged = simpleMergeHookEvent(srcPreCompact, dstPreCompact);

      // Stale entry must not appear after merge
      const stale = merged.find((cmd) =>
        cmd.includes('.claude/hooks/pre-compact.sh'),
      );
      assert.equal(
        stale,
        undefined,
        `After a simulated sync, .claude/hooks/pre-compact.sh must not appear ` +
          `in the merged PreCompact hooks. Merged: ${merged.join(', ')}`,
      );

      // Authoritative entry must still be present
      const correct = merged.find((cmd) =>
        cmd.includes('.kithkit/hooks/pre-compact.sh'),
      );
      assert.ok(
        correct !== undefined,
        `After a simulated sync, .kithkit/hooks/pre-compact.sh must remain ` +
          `in the merged PreCompact hooks. Merged: ${merged.join(', ')}`,
      );
    });
  });
});
