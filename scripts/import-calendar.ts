#!/usr/bin/env npx tsx
/**
 * Calendar Import Script — Imports CC4Me v1 calendar.md into KKit-BMO database.
 *
 * Parses the markdown calendar file and inserts structured events into
 * the Kithkit v2 SQLite database (calendar table). Does not require the
 * daemon to be running.
 *
 * Usage:
 *   npx tsx scripts/import-calendar.ts [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ── Config ──────────────────────────────────────────────────

const V1_CALENDAR_PATH = path.join(process.env.HOME!, 'CC4Me-BMO/.claude/state/calendar.md');
const IMPORT_LOG_PATH = path.join(process.env.HOME!, 'KKit-BMO/scripts/import-calendar-log.json');
const DB_PATH = path.join(process.env.HOME!, 'KKit-BMO/kithkit.db');

interface CalendarEntry {
  date: string;       // YYYY-MM-DD
  time: string | null; // HH:MM or null for all-day
  title: string;
  allDay: boolean;
  todoRef: number | null;
  source: string;
}

// ── Parser ──────────────────────────────────────────────────

function parseCalendar(content: string): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  let currentDate: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Date header: ### 2026-02-15
    const dateMatch = trimmed.match(/^###\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      continue;
    }

    // Skip non-entry lines
    if (!currentDate || !trimmed.startsWith('- ')) continue;

    const entryText = trimmed.slice(2).trim();

    // Skip completed items (✅)
    if (entryText.startsWith('✅')) continue;

    // Extract todo reference [todo:id]
    let todoRef: number | null = null;
    const todoMatch = entryText.match(/\[todo:(\d+)\]/);
    if (todoMatch) {
      todoRef = parseInt(todoMatch[1]);
    }

    // Extract time: "HH:MM - description" or "HH:MM - description"
    const timeMatch = entryText.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(.+)$/);

    let time: string | null = null;
    let title: string;

    if (timeMatch) {
      // Pad hour to 2 digits
      const [h, m] = timeMatch[1].split(':');
      time = `${h.padStart(2, '0')}:${m}`;
      title = timeMatch[2];
    } else {
      title = entryText;
    }

    // Clean up title — remove todo ref
    title = title.replace(/\s*\[todo:\d+\]\s*/, '').trim();

    // Remove emoji indicators for cleaner storage (keep the text)
    title = title.replace(/^[⚠️🔴🟡🟢✅❌]+\s*/, '').trim();

    // Rewrite CC4Me → Kithkit references
    title = title.replace(/CC4Me/g, 'Kithkit').replace(/cc4me/g, 'kithkit');

    entries.push({
      date: currentDate,
      time,
      title,
      allDay: time === null,
      todoRef,
      source: 'migrated-v1',
    });
  }

  return entries;
}

// ── Database ────────────────────────────────────────────────

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      all_day INTEGER DEFAULT 0,
      source TEXT,
      todo_ref INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ── Main ────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (!fs.existsSync(V1_CALENDAR_PATH)) {
    console.error('No calendar.md found at', V1_CALENDAR_PATH);
    process.exit(1);
  }

  const content = fs.readFileSync(V1_CALENDAR_PATH, 'utf8');
  const entries = parseCalendar(content);

  console.log(`=== Calendar Import ${dryRun ? '(DRY RUN)' : ''} ===`);
  console.log(`Found: ${entries.length} calendar entries`);
  console.log(`  With time:  ${entries.filter(e => e.time).length}`);
  console.log(`  All-day:    ${entries.filter(e => e.allDay).length}`);
  console.log(`  Todo refs:  ${entries.filter(e => e.todoRef).length}`);

  if (dryRun) {
    console.log('\nEntries to import:');
    for (const entry of entries) {
      const timeStr = entry.time || 'all-day';
      const refStr = entry.todoRef ? ` [todo:${entry.todoRef}]` : '';
      console.log(`  ${entry.date} ${timeStr.padEnd(7)} ${entry.title}${refStr}`);
    }
    console.log('\nDry run — no changes made.');
    return;
  }

  const db = openDb();
  const stmt = db.prepare(
    'INSERT INTO calendar (title, description, start_time, end_time, all_day, source, todo_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const log: Array<{ date: string; title: string; ok: boolean; id?: number; error?: string }> = [];
  let imported = 0;
  let failed = 0;

  const insertAll = db.transaction(() => {
    for (const entry of entries) {
      try {
        // Build start_time as ISO datetime
        const startTime = entry.time
          ? `${entry.date}T${entry.time}:00`
          : `${entry.date}T00:00:00`;

        const result = stmt.run(
          entry.title,
          null, // description
          startTime,
          null, // end_time
          entry.allDay ? 1 : 0,
          entry.source,
          entry.todoRef,
          new Date().toISOString(),
        );

        log.push({ date: entry.date, title: entry.title, ok: true, id: Number(result.lastInsertRowid) });
        imported++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.push({ date: entry.date, title: entry.title, ok: false, error });
        failed++;
        console.error(`  FAIL: ${entry.date} - ${entry.title}: ${error}`);
      }
    }
  });

  insertAll();
  db.close();

  console.log(`\n=== Import Complete ===`);
  console.log(`Imported: ${imported}`);
  console.log(`Failed:   ${failed}`);

  // Write import log
  const importLog = {
    generated: new Date().toISOString(),
    dryRun: false,
    summary: { imported, failed },
    entries: log,
  };
  fs.writeFileSync(IMPORT_LOG_PATH, JSON.stringify(importLog, null, 2));
  console.log(`Import log written to ${IMPORT_LOG_PATH}`);
}

main();
