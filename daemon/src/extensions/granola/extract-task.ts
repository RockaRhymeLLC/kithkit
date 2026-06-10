/**
 * Granola Extract Task — scans notes needing candidate extraction and processes them.
 *
 * Triggered by the needs-extraction list: notes with summary content but no candidate
 * todos yet. This is phase-offset from granola-sync (runs at :07, :22, :37, :52) to
 * allow sync to ingest first, then extraction runs a few minutes later.
 *
 * Pattern replaces the old isNew-gated inline extraction in scheduler.ts.
 * Backfill is automatic: any note with content but no candidates will be picked up.
 * Re-extraction: DELETE FROM granola_candidate_todos WHERE note_id = '<id>';
 *               next granola-extract cycle will re-process.
 */

import { createLogger } from '../../core/logger.js';
import { listNotesNeedingExtraction, insertCandidate } from './store.js';
import { extractActionItems } from './extraction.js';
import type { Scheduler } from '../../automation/scheduler.js';
import type { GranolaConfig } from './config.js';
import type { NoteRow } from './store.js';
import type { GranolaNote } from './client.js';

const log = createLogger('granola-extract');

const MAX_BATCH = 5;

/** Convert a stored NoteRow to the GranolaNote shape expected by extractActionItems. */
function rowToNote(row: NoteRow): GranolaNote {
  let attendees: GranolaNote['attendees'];
  if (row.attendees_json) {
    try {
      attendees = JSON.parse(row.attendees_json) as GranolaNote['attendees'];
    } catch {
      attendees = undefined;
    }
  }

  return {
    id: row.note_id,
    title: row.title,
    summary_markdown: row.summary_markdown ?? undefined,
    summary_text: row.summary_text ?? undefined,
    web_url: row.web_url ?? undefined,
    calendar_event_id: row.calendar_event_id ?? undefined,
    event_title: row.event_title ?? undefined,
    scheduled_start_time: row.scheduled_start_time ?? undefined,
    scheduled_end_time: row.scheduled_end_time ?? undefined,
    organiser: row.organiser ?? undefined,
    attendees,
    owner_email: row.owner_email ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ExtractResult {
  processed: number;
  candidates: number;
  errors: number;
  skipped: number;
}

export async function runExtraction(config: GranolaConfig): Promise<ExtractResult> {
  const result: ExtractResult = { processed: 0, candidates: 0, errors: 0, skipped: 0 };

  if (!config.extraction_enabled) {
    log.debug('Granola extraction skipped — extraction_enabled is false');
    return result;
  }

  const notes = listNotesNeedingExtraction(MAX_BATCH);
  if (notes.length === 0) {
    log.debug('Granola extract: no notes needing extraction');
    return result;
  }

  log.info('Granola extract: processing notes', { count: notes.length });

  for (const row of notes) {
    try {
      const note = rowToNote(row);

      // Safety check — should not occur given the SQL filter, but guard anyway
      if (!note.summary_markdown) {
        log.warn('Granola extract: skipping note with no summary_markdown', { noteId: row.note_id });
        result.skipped++;
        continue;
      }

      const candidates = await extractActionItems(note, config.extraction_model);
      for (const c of candidates) {
        insertCandidate(c);
        result.candidates++;
      }

      result.processed++;
      log.debug('Granola extract: processed note', {
        noteId: row.note_id,
        title: row.title,
        candidates: candidates.length,
      });
    } catch (err) {
      log.error('Granola extract: error processing note', {
        noteId: row.note_id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }

  log.info('Granola extract complete', result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Returns the extract handler function for use with the scheduler task infrastructure.
 */
export function createExtractHandler(config: GranolaConfig): () => Promise<void> {
  return async () => {
    if (!config.enabled) {
      log.debug('Granola extract skipped — extension disabled');
      return;
    }
    await runExtraction(config);
  };
}

export const EXTRACT_TASK_NAME = 'granola-extract';

export function register(scheduler: Scheduler, config: GranolaConfig): void {
  const handler = createExtractHandler(config);
  scheduler.registerHandler(EXTRACT_TASK_NAME, async () => { await handler(); });
  log.info('Granola extract handler registered', { task: EXTRACT_TASK_NAME });
}
