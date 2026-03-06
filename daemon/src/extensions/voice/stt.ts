/**
 * STT (Speech-to-Text) — whisper.cpp wrapper.
 *
 * Accepts a WAV file path, invokes whisper-cli with Metal acceleration
 * and greedy decoding (beam_size=1 — required on M4, see whisper.cpp #3493),
 * and returns the transcribed text.
 *
 * Ported from CC4Me v1 daemon/src/voice/stt.ts
 * Changes for v2: config injected via init(), not loadConfig() global.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';

const log = createLogger('stt');

const WHISPER_CLI = loadConfig().tools?.whisper_cli_path ?? '/opt/homebrew/bin/whisper-cli';
const TRANSCRIBE_TIMEOUT_MS = 30_000; // 30s max for any transcription

/**
 * Known whisper hallucination patterns.
 * Whisper often produces these when given silent or near-silent audio.
 * Checked after transcription — if the result matches, treat as silence.
 */
const HALLUCINATION_PATTERNS = new Set([
  'you', 'you.', 'the', 'the.', 'i', 'a', 'bye', 'bye.',
  'bye bye', 'bye bye.', 'bye-bye', 'bye-bye.',
  'thank you', 'thank you.', 'thanks', 'thanks.',
  'thank you for watching', 'thank you for watching.',
  'thanks for watching', 'thanks for watching.',
  'thanks for listening', 'thanks for listening.',
  'subscribe', 'subscribe.',
  'so', 'oh', 'uh', 'um', 'hmm', 'hm',
]);

/**
 * Check if a transcription result is likely a whisper hallucination.
 * Returns true if the text should be discarded.
 */
export function isHallucination(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (!cleaned) return true;
  if (HALLUCINATION_PATTERNS.has(cleaned)) return true;
  // Single character or just punctuation/symbols
  if (cleaned.length <= 2) return true;
  // Music notation hallucinations
  if (/^[♪🎵🎶\s()]+$/.test(cleaned)) return true;
  if (/^\(.*music.*\)$/i.test(cleaned)) return true;
  return false;
}

// ── Config (injected via init) ───────────────────────────────

let _modelPath: string | null = null;
let _language = 'en';

/**
 * Initialize the STT module with config values.
 * Call this before any transcribe() calls.
 */
export function initSTT(projectDir: string, model = 'small.en', language = 'en'): void {
  _modelPath = path.join(projectDir, 'models', `ggml-${model}.bin`);
  _language = language;
  log.info('STT initialized', { model: _modelPath, language });
}

/**
 * Transcribe a WAV file to text using whisper.cpp.
 *
 * @param wavPath - Absolute path to a WAV audio file
 * @returns Transcribed text (trimmed, no timestamps)
 * @throws Error if whisper-cli not found, model missing, or transcription fails
 */
export function transcribe(wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Validate inputs
    if (!fs.existsSync(wavPath)) {
      return reject(new Error(`Audio file not found: ${wavPath}`));
    }

    if (!fs.existsSync(WHISPER_CLI)) {
      return reject(new Error(
        `whisper-cli not found at ${WHISPER_CLI}. Install via: brew install whisper-cpp`
      ));
    }

    if (!_modelPath) {
      return reject(new Error('STT not initialized — call initSTT() first'));
    }

    if (!fs.existsSync(_modelPath)) {
      return reject(new Error(
        `Whisper model not found at ${_modelPath}. Download from https://huggingface.co/ggerganov/whisper.cpp`
      ));
    }

    const args = [
      '-m', _modelPath,
      '-f', wavPath,
      '-l', _language,
      '--beam-size', '1',       // Greedy decoding — required on M4 (whisper.cpp #3493)
      '--no-timestamps',
      '--no-prints',            // Suppress model loading info, only output text
    ];

    const startTime = Date.now();

    execFile(WHISPER_CLI, args, { timeout: TRANSCRIBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      const elapsed = Date.now() - startTime;

      if (err) {
        log.error('Transcription failed', {
          error: err.message,
          stderr: stderr?.trim(),
          elapsed: `${elapsed}ms`,
        });
        return reject(new Error(`Transcription failed: ${err.message}`));
      }

      // Clean up output: trim whitespace, remove any stray newlines
      const text = stdout.trim();

      log.info('Transcription complete', {
        elapsed: `${elapsed}ms`,
        chars: text.length,
        preview: text.slice(0, 80),
      });

      resolve(text);
    });
  });
}

// ── Testing ─────────────────────────────────────────────────

export function _resetForTesting(): void {
  _modelPath = null;
  _language = 'en';
}
