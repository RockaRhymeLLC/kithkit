#!/usr/bin/env npx tsx
/**
 * Memory Import Script — Imports triaged memories into KKit-BMO database.
 *
 * Reads the triage report and imports approved memories directly into
 * the SQLite database (kithkit.db). Does not require the daemon to be running.
 *
 * Usage:
 *   npx tsx scripts/import-memories.ts [--dry-run] [--limit N]
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ── Config ──────────────────────────────────────────────────

const V1_MEMORIES_DIR = path.join(process.env.HOME!, 'CC4Me-BMO/.claude/state/memory/memories');
const REPORT_PATH = path.join(process.env.HOME!, 'KKit-BMO/scripts/triage-report.json');
const IMPORT_LOG_PATH = path.join(process.env.HOME!, 'KKit-BMO/scripts/import-log.json');
const DB_PATH = path.join(process.env.HOME!, 'KKit-BMO/kithkit.db');

interface TriageResult {
  file: string;
  subject: string;
  v1Category: string;
  triageCategory: string;
  reason: string;
  tags: string[];
  importance: number;
  v2Type: string;
  v2Category: string;
  needsRewrite: string[];
}

interface FrontMatter {
  date?: string;
  category?: string;
  importance?: number;
  subject?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  [key: string]: unknown;
}

// ── Frontmatter Parser ──────────────────────────────────────

function parseFrontMatter(content: string): { meta: FrontMatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlStr = match[1];
  const body = match[2];
  const meta: FrontMatter = {};

  for (const line of yamlStr.split('\n')) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val.startsWith('[')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else if (val === 'true') {
      meta[key] = true;
    } else if (val === 'false') {
      meta[key] = false;
    } else if (/^\d+(\.\d+)?$/.test(val)) {
      meta[key] = parseFloat(val);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }

  return { meta, body };
}

// ── Rewrite Logic ───────────────────────────────────────────

function rewriteContent(body: string): string {
  let rewritten = body;

  // Preserve "CC4Me Network" as a product name before general renames
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

  // Update v1 function names
  rewritten = rewritten.replace(/sendTelegramMessage\(\)/g, 'getTelegramAdapter()?.sendDirect()');
  rewritten = rewritten.replace(/getCredential\(\)/g, 'readKeychain()');
  rewritten = rewritten.replace(/getAgentCommsSecret\(\)/g, "readKeychain('credential-agent-comms-secret')");

  return rewritten;
}

// ── Database ────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure memories table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      category TEXT,
      tags TEXT DEFAULT '[]',
      source TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  return db;
}

// ── Import ──────────────────────────────────────────────────

function importMemory(
  db: Database.Database,
  stmt: Database.Statement,
  file: string,
  triage: TriageResult,
): { ok: boolean; id?: number; error?: string } {
  const content = fs.readFileSync(path.join(V1_MEMORIES_DIR, file), 'utf8');
  const { meta, body } = parseFrontMatter(content);

  let importBody = body.trim();

  // Apply rewrites if needed
  if (triage.triageCategory === 'rewrite') {
    importBody = rewriteContent(importBody);
  }

  // Prepend subject as heading if not already present
  if (meta.subject && !importBody.startsWith('#')) {
    importBody = `# ${meta.subject}\n\n${importBody}`;
  }

  try {
    const result = stmt.run(
      importBody,
      triage.v2Type,
      triage.v2Category,
      JSON.stringify(triage.tags),
      meta.source || 'migrated-v1',
    );
    return { ok: true, id: Number(result.lastInsertRowid) };
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

  if (!fs.existsSync(REPORT_PATH)) {
    console.error('No triage report found. Run triage-memories.ts first.');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  const results = report.results as TriageResult[];

  // Import: keep-as-is, rewrite, credential-ref
  // Skip: stale, skip
  const toImport = results.filter(r =>
    r.triageCategory === 'keep-as-is' ||
    r.triageCategory === 'rewrite' ||
    r.triageCategory === 'credential-ref'
  );

  const toSkip = results.filter(r =>
    r.triageCategory === 'stale' ||
    r.triageCategory === 'skip'
  );

  console.log(`=== Memory Import ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`To import: ${toImport.length}`);
  console.log(`  Keep as-is:     ${toImport.filter(r => r.triageCategory === 'keep-as-is').length}`);
  console.log(`  Rewrite:        ${toImport.filter(r => r.triageCategory === 'rewrite').length}`);
  console.log(`  Credential ref: ${toImport.filter(r => r.triageCategory === 'credential-ref').length}`);
  console.log(`Skipping: ${toSkip.length}`);
  console.log(`  Stale: ${toSkip.filter(r => r.triageCategory === 'stale').length}`);
  console.log(`  Skip:  ${toSkip.filter(r => r.triageCategory === 'skip').length}`);

  if (dryRun) {
    console.log('\nDry run — no changes made.');
    return;
  }

  const db = openDb();
  const stmt = db.prepare(
    'INSERT INTO memories (content, type, category, tags, source) VALUES (?, ?, ?, ?, ?)'
  );

  const batch = toImport.slice(0, limit);
  console.log(`\nProcessing ${batch.length} memories...`);

  const log: Array<{ file: string; ok: boolean; id?: number; error?: string; category: string }> = [];
  let imported = 0;
  let failed = 0;

  // Use a transaction for bulk insert (much faster)
  const insertAll = db.transaction(() => {
    for (let i = 0; i < batch.length; i++) {
      const triage = batch[i];
      const result = importMemory(db, stmt, triage.file, triage);

      log.push({
        file: triage.file,
        ok: result.ok,
        id: result.id,
        error: result.error,
        category: triage.triageCategory,
      });

      if (result.ok) {
        imported++;
      } else {
        failed++;
        console.error(`  FAIL: ${triage.file}: ${result.error}`);
      }

      // Progress every 200
      if ((i + 1) % 200 === 0) {
        console.log(`  ... ${i + 1}/${batch.length} (${imported} imported, ${failed} failed)`);
      }
    }
  });

  insertAll();
  db.close();

  console.log(`\n=== Import Complete ===`);
  console.log(`Imported: ${imported}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Skipped:  ${toSkip.length}`);

  // Write import log
  const importLog = {
    generated: new Date().toISOString(),
    dryRun: false,
    summary: { imported, failed, skipped: toSkip.length },
    entries: log,
    skipped: toSkip.map(r => ({ file: r.file, reason: r.reason })),
  };
  fs.writeFileSync(IMPORT_LOG_PATH, JSON.stringify(importLog, null, 2));
  console.log(`Import log written to ${IMPORT_LOG_PATH}`);
}

main();
