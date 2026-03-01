/**
 * TTS (Text-to-Speech) — multi-engine persistent Python worker.
 *
 * Supports:
 *   - kokoro: Kokoro-82M via ONNX (~0.6-1s, good quality)
 *   - qwen3-tts-mlx: Qwen3-TTS via MLX (~2-5s, higher quality)
 *
 * Manages the tts-worker.py lifecycle (start, health-check, restart)
 * and provides synthesize() to convert text to WAV audio.
 *
 * Ported from CC4Me v1 daemon/src/voice/tts.ts
 * Changes for v2: config injected via init(), not loadConfig() global.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createLogger } from '../../core/logger.js';
const log = createLogger('tts');
const WORKER_PORT = 3848;
const MAX_RETRIES = 3;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 120_000; // Model loading can be slow first time
const SYNTHESIZE_TIMEOUT_MS = 60_000;
let worker = null;
let workerReady = false;
let retryCount = 0;
let healthTimer = null;
let startupResolve = null;
let synthesizing = false;
// ── Config (injected via init) ───────────────────────────────
let _projectDir = '';
let _engine = 'kokoro';
let _modelId = 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16';
let _voice = '';
/**
 * Initialize the TTS module with config values.
 * Call this before startWorker().
 */
export function initTTS(projectDir, engine = 'kokoro', voice = '', modelId) {
    _projectDir = projectDir;
    _engine = engine;
    _voice = voice;
    if (modelId)
        _modelId = modelId;
    log.info('TTS initialized', { projectDir, engine, voice });
}
/**
 * Get the path to the tts-worker.py script.
 */
function getWorkerScript() {
    return path.join(_projectDir, 'daemon', 'src', 'extensions', 'voice', 'tts-worker.py');
}
/**
 * Start the TTS worker process.
 */
export function startWorker() {
    return new Promise((resolve, reject) => {
        if (worker && workerReady) {
            resolve();
            return;
        }
        const script = getWorkerScript();
        const modelsDir = path.join(_projectDir, 'models');
        log.info('Starting TTS worker', { script, engine: _engine, port: WORKER_PORT });
        const pythonBin = path.join(_projectDir, 'daemon', 'src', 'extensions', 'voice', '.venv', 'bin', 'python3');
        const args = [
            script,
            '--port', String(WORKER_PORT),
            '--engine', _engine,
            '--models-dir', modelsDir,
        ];
        // Pass model ID for qwen3-tts-mlx engine
        if (_engine === 'qwen3-tts-mlx') {
            args.push('--model', _modelId);
        }
        worker = spawn(pythonBin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        startupResolve = resolve;
        // Watch stdout for READY signal
        worker.stdout?.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const raw of lines) {
                const line = raw.trim();
                if (!line)
                    continue;
                if (line.startsWith('READY')) {
                    log.info('TTS worker ready', { line });
                    workerReady = true;
                    retryCount = 0;
                    startHealthChecks();
                    if (startupResolve) {
                        startupResolve();
                        startupResolve = null;
                    }
                }
            }
        });
        // Log stderr
        worker.stderr?.on('data', (data) => {
            const line = data.toString().trim();
            if (line)
                log.debug('TTS worker', { msg: line });
        });
        // Handle crash
        worker.on('exit', (code) => {
            log.warn('TTS worker exited', { code, retryCount });
            workerReady = false;
            worker = null;
            stopHealthChecks();
            if (startupResolve) {
                startupResolve = null;
                reject(new Error(`TTS worker exited during startup with code ${code}`));
                return;
            }
            // Auto-restart if under retry limit
            if (retryCount < MAX_RETRIES) {
                retryCount++;
                log.info('Restarting TTS worker', { attempt: retryCount });
                startWorker().catch((err) => {
                    log.error('TTS worker restart failed', { error: err.message });
                });
            }
            else {
                log.error('TTS worker max retries reached, giving up');
            }
        });
        // Startup timeout
        setTimeout(() => {
            if (!workerReady && startupResolve) {
                log.error('TTS worker startup timeout');
                startupResolve = null;
                stopWorker();
                reject(new Error('TTS worker startup timed out'));
            }
        }, STARTUP_TIMEOUT_MS);
    });
}
/**
 * Stop the TTS worker process.
 */
export function stopWorker() {
    stopHealthChecks();
    if (worker) {
        log.info('Stopping TTS worker');
        worker.kill('SIGTERM');
        worker = null;
        workerReady = false;
    }
}
/**
 * Check if the worker is running and healthy.
 */
async function checkHealth() {
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: WORKER_PORT,
            path: '/health',
            method: 'GET',
            timeout: HEALTH_CHECK_TIMEOUT_MS,
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                resolve(res.statusCode === 200);
            });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}
function startHealthChecks() {
    if (healthTimer)
        return;
    healthTimer = setInterval(async () => {
        if (synthesizing)
            return; // Don't health-check during synthesis — worker is single-threaded
        const healthy = await checkHealth();
        if (!healthy && workerReady) {
            log.warn('TTS worker health check failed');
            workerReady = false;
            // The exit handler will trigger restart
            if (worker)
                worker.kill('SIGTERM');
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}
function stopHealthChecks() {
    if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
    }
}
/**
 * Check if the TTS worker is ready to accept synthesis requests.
 */
export function isWorkerReady() {
    return workerReady;
}
/**
 * Synthesize text to WAV audio.
 *
 * @param text - Text to synthesize
 * @returns Buffer containing WAV audio data
 * @throws Error if worker not running or synthesis fails
 */
export function synthesize(text) {
    return new Promise((resolve, reject) => {
        if (!workerReady) {
            return reject(new Error('TTS worker is not running'));
        }
        const body = JSON.stringify({ text, voice: _voice });
        synthesizing = true;
        const req = http.request({
            hostname: '127.0.0.1',
            port: WORKER_PORT,
            path: '/synthesize',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: SYNTHESIZE_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                synthesizing = false;
                const data = Buffer.concat(chunks);
                if (res.statusCode !== 200) {
                    try {
                        const err = JSON.parse(data.toString());
                        reject(new Error(err.error || 'Synthesis failed'));
                    }
                    catch {
                        reject(new Error(`Synthesis failed with status ${res.statusCode}`));
                    }
                    return;
                }
                const elapsed = res.headers['x-synthesis-time-ms'];
                log.info('TTS synthesis complete', {
                    chars: text.length,
                    audioBytes: data.length,
                    elapsed: elapsed ? `${elapsed}ms` : 'unknown',
                });
                resolve(data);
            });
        });
        req.on('error', (err) => { synthesizing = false; reject(new Error(`TTS request failed: ${err.message}`)); });
        req.on('timeout', () => { synthesizing = false; req.destroy(); reject(new Error('TTS request timed out')); });
        req.end(body);
    });
}
// ── Testing ─────────────────────────────────────────────────
export function _resetForTesting() {
    stopWorker();
    _projectDir = '';
    _engine = 'kokoro';
    _voice = '';
    retryCount = 0;
}
//# sourceMappingURL=tts.js.map