#!/usr/bin/env npx tsx
/**
 * Todo Import Script — Imports CC4Me v1 todos into KKit-BMO database.
 *
 * Reads JSON todo files from CC4Me v1's .claude/state/todos/ and inserts
 * them into the Kithkit v2 SQLite database (todos + todo_actions tables).
 * Does not require the daemon to be running.
 *
 * Usage:
 *   npx tsx scripts/import-todos.ts [--dry-run] [--limit N]
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ── Config ──────────────────────────────────────────────────

const V1_TODOS_DIR = path.join(process.env.HOME!, 'CC4Me-BMO/.claude/state/todos');
const IMPORT_LOG_PATH = path.join(process.env.HOME!, 'KKit-BMO/scripts/import-todos-log.json');
const DB_PATH = path.join(process.env.HOME!, 'KKit-BMO/kithkit.db');

interface V1Action {
  type: string;
  ts?: string;
  timestamp?: string;
  text?: string;
  note?: string;
  from?: string;
  to?: string;
  files?: string[];
  commits?: string[];
  prs?: string[];
}

interface V1Todo {
  id: number | string;
  title?: string;
  description?: string;
  priority?: string;
  status?: string;
  tags?: string[];
  created?: string;
  updated?: string;
  due?: string | null;
  blocked_reason?: string;
  blockedBy?: unknown[];
  nextStep?: string | null;
  specRef?: string;
  actions?: V1Action[];
}

// ── Status Mapping ──────────────────────────────────────────

function mapStatus(v1Status: string): string {
  switch (v1Status) {
    case 'open': return 'pending';
    case 'in-progress': return 'in_progress';
    case 'blocked': return 'blocked';
    case 'completed': return 'completed';
    default: return 'pending';
  }
}

// ── Rewrite Logic ───────────────────────────────────────────

function rewriteText(text: string): string {
  let rewritten = text;

  // Preserve "CC4Me Network" as a product name
  const networkPlaceholder = '___CC4ME_NETWORK___';
  rewritten = rewritten.replace(/CC4Me Network/g, networkPlaceholder);

  // CC4Me → Kithkit renames
  rewritten = rewritten.replace(/cc4me\.config\.yaml/g, 'kithkit.config.yaml');
  rewritten = rewritten.replace(/CC4Me/g, 'Kithkit');
  rewritten = rewritten.replace(/cc4me/g, 'kithkit');

  // Restore CC4Me Network
  rewritten = rewritten.replace(new RegExp(networkPlaceholder, 'g'), 'CC4Me Network');

  // Update flat file paths
  rewritten = rewritten.replace(/\.claude\/state\/memory\/memories\//g, 'daemon API (POST /api/memory/store)');
  rewritten = rewritten.replace(/\.claude\/state\/todos\//g, 'daemon API (todos)');

  return rewritten;
}

// ── Database ────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      due_date TEXT,
      tags JSON DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS todo_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ── Import ──────────────────────────────────────────────────

function importTodo(
  db: Database.Database,
  todoStmt: Database.Statement,
  actionStmt: Database.Statement,
  v1: V1Todo,
): { ok: boolean; todoId?: number; actionsImported?: number; error?: string } {
  try {
    const title = rewriteText(v1.title || v1.description?.slice(0, 100) || `Todo ${v1.id}`);
    const description = v1.description ? rewriteText(v1.description) : null;
    const priority = v1.priority || 'medium';
    const status = mapStatus(v1.status || 'open');
    const dueDate = v1.due || null;
    const tags = JSON.stringify(v1.tags || []);
    const createdAt = v1.created || new Date().toISOString();
    const updatedAt = v1.updated || createdAt;

    const result = todoStmt.run(
      title,
      description,
      priority,
      status,
      dueDate,
      tags,
      createdAt,
      updatedAt,
    );
    const todoId = Number(result.lastInsertRowid);

    // Import action history
    let actionsImported = 0;
    if (v1.actions && Array.isArray(v1.actions)) {
      for (const action of v1.actions) {
        const actionType = action.type || 'note';
        const timestamp = action.timestamp || action.ts || createdAt;
        const noteText = action.note || action.text || null;

        let oldValue: string | null = null;
        let newValue: string | null = null;

        if (actionType === 'status_change' || actionType === 'status-change') {
          oldValue = action.from || null;
          newValue = action.to || null;
        }

        // Build note with any file/commit/PR references
        let fullNote = noteText ? rewriteText(noteText) : null;
        const refs: string[] = [];
        if (action.files?.length) refs.push(`Files: ${action.files.join(', ')}`);
        if (action.commits?.length) refs.push(`Commits: ${action.commits.join(', ')}`);
        if (action.prs?.length) refs.push(`PRs: ${action.prs.join(', ')}`);
        if (refs.length && fullNote) {
          fullNote += '\n' + refs.join('\n');
        }

        actionStmt.run(todoId, actionType, oldValue, newValue, fullNote, timestamp);
        actionsImported++;
      }
    }

    return { ok: true, todoId, actionsImported };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;

  // Read all todo JSON files
  const files = fs.readdirSync(V1_TODOS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.counter')
    .sort();

  const todos: Array<{ file: string; data: V1Todo }> = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(V1_TODOS_DIR, file), 'utf8');
      const data = JSON.parse(raw) as V1Todo;
      todos.push({ file, data });
    } catch (err) {
      console.error(`  SKIP (parse error): ${file}: ${err}`);
    }
  }

  const completed = todos.filter(t => t.data.status === 'completed').length;
  const active = todos.length - completed;

  console.log(`=== Todo Import ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`Found: ${todos.length} todos (${active} active, ${completed} completed)`);

  if (dryRun) {
    console.log('\nTodos to import:');
    for (const { file, data } of todos.slice(0, limit)) {
      const actions = data.actions?.length || 0;
      console.log(`  [${data.id}] ${data.status?.toUpperCase()} - ${data.title || data.description?.slice(0, 60)} (${actions} actions)`);
    }
    console.log('\nDry run — no changes made.');
    return;
  }

  const db = openDb();
  const todoStmt = db.prepare(
    'INSERT INTO todos (title, description, priority, status, due_date, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const actionStmt = db.prepare(
    'INSERT INTO todo_actions (todo_id, action, old_value, new_value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const batch = todos.slice(0, limit);
  console.log(`\nProcessing ${batch.length} todos...`);

  const log: Array<{ file: string; v1Id: number | string; ok: boolean; v2Id?: number; actions?: number; error?: string }> = [];
  let imported = 0;
  let failed = 0;
  let totalActions = 0;

  const insertAll = db.transaction(() => {
    for (const { file, data } of batch) {
      const result = importTodo(db, todoStmt, actionStmt, data);

      log.push({
        file,
        v1Id: data.id,
        ok: result.ok,
        v2Id: result.todoId,
        actions: result.actionsImported,
        error: result.error,
      });

      if (result.ok) {
        imported++;
        totalActions += result.actionsImported || 0;
      } else {
        failed++;
        console.error(`  FAIL: ${file}: ${result.error}`);
      }
    }
  });

  insertAll();
  db.close();

  console.log(`\n=== Import Complete ===`);
  console.log(`Imported: ${imported} todos (${totalActions} actions)`);
  console.log(`Failed:   ${failed}`);

  // Write import log
  const importLog = {
    generated: new Date().toISOString(),
    dryRun: false,
    summary: { imported, failed, totalActions },
    entries: log,
  };
  fs.writeFileSync(IMPORT_LOG_PATH, JSON.stringify(importLog, null, 2));
  console.log(`Import log written to ${IMPORT_LOG_PATH}`);
}

main();
