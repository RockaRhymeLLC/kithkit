/**
 * Granola sync scheduler — polls Granola API, upserts notes, extracts candidates.
 */

import { createLogger } from '../../core/logger.js';
import { listNotes, getNoteDetail } from './client.js';
import { upsertNote, getSyncState, updateSyncState } from './store.js';
import type { GranolaConfig } from './config.js';
import type { NoteDetail } from './client.js';

const log = createLogger('granola-scheduler');

export interface SyncResult {
  new: number;
  updated: number;
  errors: number;
}

export async function syncNotes(config: GranolaConfig): Promise<SyncResult> {
  const result: SyncResult = { new: 0, updated: 0, errors: 0 };

  const syncState = getSyncState();
  const updatedAfter = syncState.last_updated_after ?? undefined;

  let cursor: string | undefined;
  let maxUpdatedAt = updatedAfter ?? '';
  let pageCount = 0;
  const MAX_PAGES = 100;

  try {
    do {
      const page = await listNotes(config.api_base_url, {
        updated_after: updatedAfter,
        cursor,
        limit: 50,
      });

      if (!page) {
        log.warn('Granola sync: listNotes returned null — aborting this cycle');
        result.errors++;
        updateSyncState({
          last_sync_at: new Date().toISOString(),
          last_sync_status: 'error',
          last_error: 'listNotes returned null',
        });
        return result;
      }

      for (const stub of page.notes) {
        try {
          // Minimum 200ms between detail calls (Granola 5 req/s sustained limit)
          await new Promise(r => setTimeout(r, 200));

          const detail = await getNoteDetail(config.api_base_url, stub.id);
          if (!detail) {
            log.warn('Granola sync: getNoteDetail returned null — skipping note', { noteId: stub.id });
            result.errors++;
            continue;
          }

          const isNew = upsertNote(detail);
          if (isNew) {
            result.new++;
          } else {
            result.updated++;
          }

          // Track cursor advancement
          if (detail.updated_at > maxUpdatedAt) {
            maxUpdatedAt = detail.updated_at;
          }

          // Note: candidate extraction is handled separately by the granola-extract task.
        } catch (err) {
          log.error('Error processing note', {
            noteId: stub.id,
            error: err instanceof Error ? err.message : String(err),
          });
          result.errors++;
        }
      }

      cursor = page.cursor;
      pageCount++;
      if (pageCount >= MAX_PAGES) {
        log.warn('Granola sync: hit MAX_PAGES limit', { pages: pageCount });
        break;
      }
    } while (cursor);

    // Advance cursor only on full success (no errors)
    if (result.errors === 0 && maxUpdatedAt) {
      updateSyncState({
        last_updated_after: maxUpdatedAt,
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'ok',
        last_error: null,
      });
    } else if (result.errors > 0) {
      // Partial failure — don't advance cursor to allow retry
      updateSyncState({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'error',
        last_error: `${result.errors} note(s) failed to process`,
      });
    } else {
      updateSyncState({
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'ok',
        last_error: null,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Granola sync fatal error', { error: msg });
    updateSyncState({
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'error',
      last_error: msg,
    });
    result.errors++;
  }

  log.info('Granola sync complete', result as unknown as Record<string, unknown>);
  return result;
}

/**
 * Returns the sync handler function for use with the scheduler task infrastructure.
 * Exported as a named handler that the task registry can call.
 */
export function createSyncHandler(config: GranolaConfig): () => Promise<void> {
  return async () => {
    if (!config.enabled) {
      log.debug('Granola sync skipped — extension disabled');
      return;
    }
    await syncNotes(config);
  };
}
