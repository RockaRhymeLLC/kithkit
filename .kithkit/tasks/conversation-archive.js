/**
 * conversation-archive — moves conversation_messages rows older than
 * retention_days (default 90) into conversation_messages_archive.
 *
 * Runs monthly (1st of each month at 3am) via the kithkit scheduler.
 * Uses a single db.transaction() so the INSERT...SELECT + DELETE is atomic.
 *
 * Shape A external task loader: exports register(scheduler).
 *
 * NOTE: This task only does useful work when the conversation_persistence
 * feature flag is enabled (features.conversation_persistence: true in
 * kithkit.config.yaml). The task is safe to register regardless — it is a
 * no-op if the table is empty.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getDb(config) {
  // Resolve the DB path: walk up from the tasks dir to the project root.
  const projectRoot = path.resolve(__dirname, '..', '..');
  const dbPath = config?.db_path ?? path.join(projectRoot, 'kithkit.db');
  return new Database(dbPath);
}

async function run(config) {
  const retentionDays = Number(config?.retention_days ?? 90);
  if (isNaN(retentionDays) || retentionDays < 1) {
    throw new Error(`conversation-archive: invalid retention_days: ${config?.retention_days}`);
  }

  const db = getDb(config);

  try {
    db.pragma('journal_mode = WAL');

    const archiveRows = db.transaction(() => {
      // Step 1: copy old rows to archive
      const inserted = db.prepare(`
        INSERT INTO conversation_messages_archive
          (id, direction, channel, sender, recipient, text, ts, chat_id, message_id, metadata, sys_created)
        SELECT id, direction, channel, sender, recipient, text, ts, chat_id, message_id, metadata, sys_created
        FROM conversation_messages
        WHERE ts < datetime('now', ?)
      `).run(`-${retentionDays} days`);

      // Step 2: delete from live table (same WHERE clause, same transaction)
      const deleted = db.prepare(`
        DELETE FROM conversation_messages
        WHERE ts < datetime('now', ?)
      `).run(`-${retentionDays} days`);

      return { inserted: inserted.changes, deleted: deleted.changes };
    });

    const result = archiveRows();
    console.log(`[conversation-archive] Archived ${result.archived ?? result.inserted} rows (retention: ${retentionDays} days)`);
    return result;
  } finally {
    db.close();
  }
}

// ── Registration (Shape A — external task loader) ──────────────

export function register(scheduler) {
  scheduler.registerHandler('conversation-archive', async (ctx) => {
    try {
      await run(ctx.config);
    } catch (err) {
      console.error(`[conversation-archive] Fatal error: ${err?.message ?? err}`);
    }
  });
}
