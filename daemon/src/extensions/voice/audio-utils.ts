/**
 * Audio utilities — temp file management for voice processing.
 *
 * Incoming audio is written to temp files for whisper-cli to process,
 * then cleaned up after transcription completes.
 *
 * Ported from CC4Me v1 daemon/src/voice/audio-utils.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createLogger } from '../../core/logger.js';

const log = createLogger('audio-utils');

const TEMP_PREFIX = 'kithkit-voice-';

/**
 * Save audio data to a temp file. Returns the absolute path.
 */
export function saveTempAudio(buffer: Buffer, extension = '.wav'): string {
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${TEMP_PREFIX}${id}${extension}`;
  const filepath = path.join(os.tmpdir(), filename);
  fs.writeFileSync(filepath, buffer);
  log.debug('Saved temp audio', { filepath, bytes: buffer.length });
  return filepath;
}

/**
 * Delete a temp audio file. Safe to call even if file doesn't exist.
 */
export function cleanupTemp(filepath: string): void {
  try {
    fs.unlinkSync(filepath);
    log.debug('Cleaned up temp file', { filepath });
  } catch {
    // File already gone or never existed — that's fine
  }
}

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const CONVERT_TIMEOUT_MS = 15_000; // 15s max for any conversion

/**
 * Convert any audio file to 16kHz mono WAV suitable for whisper-cli.
 * Uses ffmpeg. Returns the path to the new WAV file (caller must clean up).
 */
export function convertToWav(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Input audio file not found: ${inputPath}`));
    }

    const id = crypto.randomBytes(8).toString('hex');
    const outputPath = path.join(os.tmpdir(), `${TEMP_PREFIX}converted-${id}.wav`);

    const args = [
      '-i', inputPath,
      '-ar', '16000',   // 16kHz sample rate (whisper-cli expects this)
      '-ac', '1',        // Mono
      '-f', 'wav',       // WAV format
      '-y',              // Overwrite output
      outputPath,
    ];

    execFile(FFMPEG, args, { timeout: CONVERT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        log.error('Audio conversion failed', {
          error: err.message,
          stderr: stderr?.trim().slice(-200),
        });
        return reject(new Error(`Audio conversion failed: ${err.message}`));
      }

      log.info('Converted audio to WAV', { input: inputPath, output: outputPath });
      resolve(outputPath);
    });
  });
}
