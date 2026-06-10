/**
 * Granola extraction — uses Claude to extract action items from meeting notes.
 */

import crypto from 'node:crypto';
import { askClaude } from '../../core/claude-api.js';
import { createLogger } from '../../core/logger.js';
import type { GranolaNote, GranolaAttendee } from './client.js';
import type { Candidate } from './store.js';

const log = createLogger('granola-extraction');

const SYSTEM_PROMPT =
  'You are an assistant that extracts action items from meeting notes. ' +
  'Return ONLY a JSON array of objects with these fields: ' +
  '{"text": string, "owner_guess": string|null, "due_date_guess": string|null, "confidence": number}. ' +
  'due_date_guess must be ISO-8601 date or null. confidence is 0-1. ' +
  'Do not include items that are already complete or purely informational. ' +
  'Do not include any explanation or markdown — only the raw JSON array.';

interface ExtractedItem {
  text: string;
  owner_guess?: string | null;
  due_date_guess?: string | null;
  confidence?: number | null;
}

function dedupHash(noteId: string, text: string): string {
  return crypto.createHash('sha256').update(noteId + '\x00' + text).digest('hex');
}

function attendeeNames(attendees?: GranolaAttendee[]): string {
  if (!attendees || attendees.length === 0) return 'unknown';
  return attendees.map(a => a.name ?? a.email.split('@')[0]).join(', ');
}

export async function extractActionItems(
  note: GranolaNote,
  model = 'claude-sonnet-4-6',
): Promise<Candidate[]> {
  const userPrompt = [
    `Meeting: ${note.title}`,
    note.scheduled_start_time ? `Date: ${note.scheduled_start_time.slice(0, 10)}` : '',
    note.attendees ? `Attendees: ${attendeeNames(note.attendees)}` : '',
    '',
    note.summary_markdown
      ? `Notes:\n${note.summary_markdown}`
      : note.summary_text
        ? `Notes:\n${note.summary_text}`
        : '(No notes available)',
  ].filter(Boolean).join('\n');

  const response = await askClaude(userPrompt, {
    model,
    maxTokens: 1024,
    system: SYSTEM_PROMPT,
  });

  if (!response) {
    log.error('Claude extraction returned null', { noteId: note.id });
    return [];
  }

  // Parse JSON — strip markdown fences if Claude added them
  let raw = response.content.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  let items: ExtractedItem[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      log.error('Extraction result is not an array', { noteId: note.id });
      return [];
    }
    items = parsed as ExtractedItem[];
  } catch (err) {
    log.error('Failed to parse extraction JSON', {
      noteId: note.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const candidates: Candidate[] = [];
  for (const item of items) {
    if (!item.text || typeof item.text !== 'string') continue;
    const confidence = typeof item.confidence === 'number' ? item.confidence : 0.5;
    if (confidence < 0.3) continue;

    candidates.push({
      note_id: note.id,
      text: item.text.trim(),
      owner_guess: item.owner_guess ?? null,
      due_date_guess: item.due_date_guess ?? null,
      confidence,
      state: 'suggested',
      dedup_hash: dedupHash(note.id, item.text.trim()),
    });
  }

  return candidates;
}
