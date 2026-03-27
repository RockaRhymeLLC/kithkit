/**
 * Voice Extension — HTTP endpoint handlers and lifecycle for /voice/* routes.
 *
 * Handles client registration, status queries, transcription (STT),
 * synthesis (TTS), and daemon-initiated voice notifications (chime flow).
 *
 * Ported from CC4Me v1 daemon/src/voice/voice-server.ts
 * Changes for v2:
 * - Config injected (not loadConfig() global)
 * - Routes registered via registerRoute() in the extension system
 * - STT/TTS modules initialized with explicit config
 */

import http from 'node:http';
import { createLogger } from '../../core/logger.js';
import { getProjectDir, loadConfig } from '../../core/config.js';
import { registerRoute } from '../../core/route-registry.js';
import { registerCheck } from '../../core/extended-status.js';
import { injectText } from '../../core/session-bridge.js';
import type { VoiceConfig } from '../config.js';
import {
  registerClient,
  unregisterClient,
  getRegistryStatus,
  isVoiceAvailable,
  sendChime,
  sendAudioToClient,
  startPruner,
  stopPruner,
} from './voice-client-registry.js';
import { transcribe, isHallucination, initSTT } from './stt.js';
import { saveTempAudio, cleanupTemp } from './audio-utils.js';
import { synthesize, startWorker, stopWorker, initTTS, isWorkerReady } from './tts.js';
import {
  registerVoicePending,
  clearVoicePending,
  isVoicePending,
  getChannel,
  setChannel,
  startTypingIndicator,
  getLastActiveChannel,
} from '../comms/channel-router.js';

const log = createLogger('voice-server');

const MAX_AUDIO_BYTES = loadConfig().voice?.max_audio_bytes ?? 10 * 1024 * 1024;
const MAX_TTS_CHARS = loadConfig().voice?.max_tts_chars ?? 500;
const VOICE_RESPONSE_TIMEOUT_MS = loadConfig().voice?.response_timeout_ms ?? 30_000;

// ── State ────────────────────────────────────────────────────

let _enabled = false;

// ── Body parsers ─────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<string> {
  // Check for pre-buffered body from main.ts metrics middleware
  const rawBody = (req as unknown as Record<string, unknown>)._rawBody;
  if (rawBody instanceof Buffer) {
    return Promise.resolve(rawBody.toString());
  }
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });
}

function parseRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  // Check for pre-buffered body from main.ts metrics middleware
  const rawBody = (req as unknown as Record<string, unknown>)._rawBody;
  if (rawBody instanceof Buffer) {
    if (rawBody.length > maxBytes) {
      return Promise.reject(new Error('PAYLOAD_TOO_LARGE'));
    }
    return Promise.resolve(rawBody);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function getClientIp(req: http.IncomingMessage): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';
}

function checkVoiceEnabled(res: http.ServerResponse): boolean {
  if (!_enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Voice subsystem is disabled' }));
    return false;
  }
  return true;
}

// ── Route Handlers ──────────────────────────────────────────

async function handleRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  const body = await parseBody(req);
  try {
    const data = JSON.parse(body) as { callbackUrl?: string; clientId?: string };
    if (!data.clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "'clientId' is required" }));
      return true;
    }

    const ip = getClientIp(req);
    registerClient(data.clientId, data.callbackUrl || '', ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
  return true;
}

async function handleUnregister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  const body = await parseBody(req);
  try {
    const data = JSON.parse(body) as { clientId?: string };
    if (!data.clientId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "'clientId' is required" }));
      return true;
    }
    const removed = unregisterClient(data.clientId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, removed }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
  return true;
}

async function handleStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  const status = getRegistryStatus();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status));
  return true;
}

async function handleSTT(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  let audioBuffer: Buffer;
  try {
    audioBuffer = await parseRawBody(req, MAX_AUDIO_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large (max 10MB)' }));
      return true;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read request body' }));
    return true;
  }

  if (audioBuffer.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty audio body' }));
    return true;
  }

  if (audioBuffer.length < 12 ||
      audioBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
      audioBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid audio format — expected WAV' }));
    return true;
  }

  let tempPath: string | null = null;
  try {
    tempPath = saveTempAudio(audioBuffer);
    const text = await transcribe(tempPath);
    cleanupTemp(tempPath);
    tempPath = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: text.trim() }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('STT-only error', { error: msg });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  } finally {
    if (tempPath) cleanupTemp(tempPath);
  }
  return true;
}

async function handleTranscribe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  if (isVoicePending()) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Another voice request is in progress' }));
    return true;
  }

  let audioBuffer: Buffer;
  try {
    audioBuffer = await parseRawBody(req, MAX_AUDIO_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large (max 10MB)' }));
      return true;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read request body' }));
    return true;
  }

  if (audioBuffer.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty audio body' }));
    return true;
  }

  if (audioBuffer.length < 12 ||
      audioBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
      audioBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid audio format — expected WAV' }));
    return true;
  }

  let tempPath: string | null = null;
  try {
    tempPath = saveTempAudio(audioBuffer);
    const sttText = await transcribe(tempPath);
    cleanupTemp(tempPath);
    tempPath = null;

    if (!sttText.trim() || isHallucination(sttText)) {
      log.info('Voice pipeline: discarding hallucination/silence', { text: sttText });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: sttText.trim(), note: 'Hallucination or silence — discarded' }));
      return true;
    }

    log.info('Voice pipeline: STT complete', { text: sttText });

    let channel = getChannel();
    if (channel === 'terminal' || channel === 'silent') {
      // Route voice response to the last active text channel instead of hardcoding telegram
      const lastActive = getLastActiveChannel();
      setChannel(lastActive);
      channel = lastActive;
      log.info('Voice input: channel was terminal/silent, switched to last active channel', { lastActive });
    }

    if (channel === 'voice') {
      const responseText = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearVoicePending();
          reject(new Error('Claude did not respond within 30 seconds'));
        }, VOICE_RESPONSE_TIMEOUT_MS);

        registerVoicePending((text: string) => {
          clearTimeout(timeout);
          resolve(text);
        });

        const injected = injectText(`[Voice] ${sttText}`);
        if (!injected) {
          clearTimeout(timeout);
          clearVoicePending();
          reject(new Error('Failed to inject text into Claude session'));
        }
      });

      log.info('Voice pipeline: Claude responded', { chars: responseText.length });

      const ttsInput = responseText.length > MAX_TTS_CHARS
        ? responseText.substring(0, MAX_TTS_CHARS - 3) + '...'
        : responseText;
      const responseAudio = await synthesize(ttsInput);

      log.info('Voice pipeline: TTS complete', {
        responseChars: responseText.length,
        ttsChars: ttsInput.length,
        audioBytes: responseAudio.length,
      });

      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'X-Transcription': encodeURIComponent(sttText),
        'X-Response-Text': encodeURIComponent(responseText),
        'Content-Length': String(responseAudio.length),
      });
      res.end(responseAudio);
    } else {
      if (channel === 'telegram' || channel === 'telegram-verbose') {
        startTypingIndicator();
      }

      const injected = injectText(`[Voice → ${channel}] ${sttText}`);
      if (!injected) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to inject text into Claude session' }));
        return true;
      }

      log.info('Voice pipeline: text injected, response via channel', { text: sttText, channel });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: sttText, responseChannel: channel }));
    }
  } catch (err) {
    clearVoicePending();
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Voice pipeline error', { error: msg });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  } finally {
    if (tempPath) cleanupTemp(tempPath);
  }
  return true;
}

async function handleSpeak(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  const body = await parseBody(req);
  try {
    const data = JSON.parse(body) as { text?: string };
    if (!data.text?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "'text' is required and must be non-empty" }));
      return true;
    }

    const text = data.text.trim();
    if (text.length > MAX_TTS_CHARS) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Text too long (${text.length} chars, max ${MAX_TTS_CHARS})` }));
      return true;
    }

    const audioBuffer = await synthesize(text);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(audioBuffer.length),
    });
    res.end(audioBuffer);
  } catch (err) {
    log.error('Speak endpoint error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'TTS failed' }));
  }
  return true;
}

async function handleNotify(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _pathname: string,
  _searchParams: URLSearchParams,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (!checkVoiceEnabled(res)) return true;

  const body = await parseBody(req);
  try {
    const data = JSON.parse(body) as { text?: string; type?: string };
    if (!data.text?.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "'text' is required" }));
      return true;
    }

    const result = await sendVoiceNotification(
      data.text.trim(),
      data.type || 'notification',
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }));
  }
  return true;
}

// ── Voice notification ───────────────────────────────────────

export interface VoiceNotificationResult {
  delivered: boolean;
  method: 'voice' | 'fallback';
  reason?: string;
}

export async function sendVoiceNotification(
  text: string,
  type: string = 'notification',
): Promise<VoiceNotificationResult> {
  if (!isVoiceAvailable()) {
    log.info('Voice notification: no client connected, falling back', { type });
    return { delivered: false, method: 'fallback', reason: 'No voice client connected' };
  }

  log.info('Voice notification: sending chime', { type, textChars: text.length });
  const chimeResult = await sendChime(text, type);

  if (chimeResult.status !== 'confirmed') {
    log.info('Voice notification: chime not confirmed, falling back', {
      status: chimeResult.status, type,
    });
    return {
      delivered: false,
      method: 'fallback',
      reason: `Client ${chimeResult.status}: ${chimeResult.error || 'no confirmation'}`,
    };
  }

  try {
    const ttsText = text.length > MAX_TTS_CHARS
      ? text.substring(0, MAX_TTS_CHARS - 3) + '...'
      : text;
    const audioBuffer = await synthesize(ttsText);
    log.info('Voice notification: TTS complete', { chars: ttsText.length, audioBytes: audioBuffer.length });

    const played = await sendAudioToClient(audioBuffer);
    if (played) {
      log.info('Voice notification: delivered via voice', { type });
      return { delivered: true, method: 'voice' };
    } else {
      log.warn('Voice notification: audio push failed, falling back', { type });
      return { delivered: false, method: 'fallback', reason: 'Audio push to client failed' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Voice notification: TTS failed, falling back', { error: msg, type });
    return { delivered: false, method: 'fallback', reason: `TTS error: ${msg}` };
  }
}

// ── Lifecycle ────────────────────────────────────────────────

/**
 * Initialize the voice extension.
 * Registers all /voice/* routes and starts the STT/TTS subsystems.
 */
export async function initVoice(config: VoiceConfig): Promise<void> {
  _enabled = config.enabled;

  if (!_enabled) {
    log.info('Voice is disabled in config');
    // Still register routes so they return 503 cleanly
    registerVoiceRoutes();
    registerVoiceHealthCheck();
    return;
  }

  const projectDir = getProjectDir();

  // Initialize STT
  initSTT(
    projectDir,
    config.stt?.model ?? 'small.en',
    config.stt?.language ?? 'en',
  );

  // Initialize TTS
  initTTS(
    projectDir,
    config.tts?.engine ?? 'kokoro',
    config.tts?.voice ?? '',
  );

  // Register all voice routes
  registerVoiceRoutes();
  registerVoiceHealthCheck();

  // Start client pruner
  startPruner();

  // Start TTS worker (async, don't block server startup)
  startWorker().catch((err) => {
    log.error('TTS worker failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info('Voice extension initialized', {
    stt: config.stt?.model ?? 'small.en',
    tts: config.tts?.engine ?? 'kokoro',
    voice: config.tts?.voice ?? '(default)',
  });
}

/**
 * Register all /voice/* routes with the route registry.
 */
function registerVoiceRoutes(): void {
  registerRoute('/voice/register', handleRegister);
  registerRoute('/voice/unregister', handleUnregister);
  registerRoute('/voice/status', handleStatus);
  registerRoute('/voice/stt', handleSTT);
  registerRoute('/voice/transcribe', handleTranscribe);
  registerRoute('/voice/speak', handleSpeak);
  registerRoute('/voice/notify', handleNotify);
}

/**
 * Register voice health check with extended-status.
 */
function registerVoiceHealthCheck(): void {
  registerCheck('voice', () => ({
    ok: _enabled,
    message: _enabled
      ? `Voice enabled, TTS worker ${isWorkerReady() ? 'ready' : 'not ready'}, ${isVoiceAvailable() ? 'client connected' : 'no clients'}`
      : 'Voice disabled',
  }));
}

/**
 * Shut down the voice extension.
 */
export function stopVoice(): void {
  stopPruner();
  stopWorker();
  _enabled = false;
  log.info('Voice extension shut down');
}

// ── Testing ─────────────────────────────────────────────────

export function _isEnabled(): boolean {
  return _enabled;
}

export function _resetForTesting(): void {
  _enabled = false;
}
