/**
 * embed-client.ts — daemon-side supervisor + IPC client for the embed worker.
 *
 * Forks dist/memory/embed-worker.js as a child process, supervises it (restart
 * on death with exponential backoff + crash-storm cooldown), and exposes
 * embed() / embedBatch() with request-id-based IPC dispatch.
 *
 * Public API:
 *   startEmbedWorker(projectDir)  — fork & await ready
 *   stopEmbedWorker()             — SIGTERM + cleanup
 *   embed(text)                   — returns Float32Array[384]
 *   embedBatch(texts)             — returns Float32Array[]
 *   isEmbedWorkerReady()          — true if worker is up and ready
 *   _resetForTesting()            — stop + reset all state (test use only)
 *
 * Crash-storm guard: if the worker crashes more than MAX_RAPID_CRASHES times
 * within RAPID_CRASH_WINDOW_MS, new requests are rejected fast (with
 * COOLDOWN_MS delay before attempting another restart) to avoid tight fork loops.
 */

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('embed-client');

// ── Timeouts / limits ────────────────────────────────────────

const STARTUP_TIMEOUT_MS = 120_000;   // model download on first run can be slow
const REQUEST_TIMEOUT_MS = 30_000;    // per-embed timeout
const QUEUE_MAX = 100;                // max buffered requests while not-ready
const QUEUE_WAIT_TIMEOUT_MS = 10_000; // reject queued requests if worker not ready within this time (#513)
const BACKOFF_INITIAL_MS = 250;
const BACKOFF_CAP_MS = 30_000;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 60_000;
const COOLDOWN_MS = 15_000;           // pause before next restart after storm

// ── State ────────────────────────────────────────────────────

let _child: ChildProcess | null = null;
let _ready = false;
let _projectDir = '';

// Monotonic request id
let _nextId = 0;

type PendingEntry = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const _pending = new Map<string, PendingEntry>();

// Buffered requests while starting up
type QueuedRequest = {
  msg: object;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  waitTimer: ReturnType<typeof setTimeout>; // bounded queue-wait timeout (#513)
};
const _queue: QueuedRequest[] = [];

// Restart backoff state
let _backoffMs = BACKOFF_INITIAL_MS;
let _restartTimer: ReturnType<typeof setTimeout> | null = null;

// Set to true by stopEmbedWorker() to prevent auto-restart after intentional stop
let _stopped = false;

// Crash-storm tracking
const _crashTimestamps: number[] = [];
let _inCooldown = false;

// Startup promise (used during initial fork)
let _startupResolve: (() => void) | null = null;
let _startupReject: ((err: Error) => void) | null = null;

// Startup timeout handle — must be cancelable so _resetForTesting() doesn't leak timers
let _startupTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

// ── IPC message type ─────────────────────────────────────────

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: string; data: number[] | number[][] }
  | { type: 'error'; id: string; message: string };

// ── Helpers ──────────────────────────────────────────────────

function rejectAllPending(reason: string): void {
  for (const [, entry] of _pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  _pending.clear();
}

function flushQueue(): void {
  while (_queue.length > 0 && _ready && _child) {
    const req = _queue.shift()!;
    clearTimeout(req.waitTimer); // cancel the queue-wait timeout
    dispatchToWorker(req.msg, req.resolve, req.reject);
  }
}

function dispatchToWorker(
  msg: object,
  resolve: (data: unknown) => void,
  reject: (err: Error) => void,
): void {
  const id = String(_nextId++);
  const timer = setTimeout(() => {
    if (_pending.has(id)) {
      _pending.delete(id);
      reject(new Error('embed request timed out'));
    }
  }, REQUEST_TIMEOUT_MS);

  _pending.set(id, { resolve, reject, timer });
  _child!.send({ ...msg, id });
}

function isCrashStorm(): boolean {
  const now = Date.now();
  // Remove timestamps older than the window
  while (_crashTimestamps.length > 0 && _crashTimestamps[0]! < now - RAPID_CRASH_WINDOW_MS) {
    _crashTimestamps.shift();
  }
  return _crashTimestamps.length >= MAX_RAPID_CRASHES;
}

// ── Restart logic ────────────────────────────────────────────

function scheduleRestart(): void {
  if (_stopped) return;
  if (_restartTimer) return;

  _crashTimestamps.push(Date.now());

  if (isCrashStorm()) {
    if (!_inCooldown) {
      _inCooldown = true;
      log.error('embed-worker: crash storm detected — cooling down', {
        crashes: _crashTimestamps.length,
        cooldownMs: COOLDOWN_MS,
      });
    }
    _restartTimer = setTimeout(() => {
      _restartTimer = null;
      _inCooldown = false;
      _crashTimestamps.length = 0;  // reset after cooldown
      log.info('embed-worker: cooldown elapsed, attempting restart');
      doRestart();
    }, COOLDOWN_MS);
    return;
  }

  log.info('embed-worker: scheduling restart', { backoffMs: _backoffMs });
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    doRestart();
  }, _backoffMs);

  // Exponential backoff
  _backoffMs = Math.min(_backoffMs * 2, BACKOFF_CAP_MS);
}

function doRestart(): void {
  if (_stopped) return;
  if (_child) {
    // already being restarted — defensive guard
    return;
  }
  log.info('embed-worker: restarting');
  forkWorker().catch((err) => {
    log.error('embed-worker: restart failed', { error: err instanceof Error ? err.message : String(err) });
    scheduleRestart();
  });
}

// ── Fork ─────────────────────────────────────────────────────

function getWorkerScript(): string {
  // Compiled output lives beside this file: dist/memory/embed-worker.js
  return path.join(_projectDir, 'daemon', 'dist', 'memory', 'embed-worker.js');
}

function forkWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = getWorkerScript();

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // propagate fake mode for testing
    if (process.env['KITHKIT_EMBED_FAKE']) {
      childEnv['KITHKIT_EMBED_FAKE'] = process.env['KITHKIT_EMBED_FAKE'];
    }

    log.info('embed-worker: forking', { script });

    let localReady = false;

    const child = fork(script, [], {
      // Use ignore for all stdio — no pipe handles to keep the event loop alive.
      // Communication happens exclusively via IPC (process.send/process.on('message')).
      // The worker sends errors via IPC as {type:'error'} on startup failure.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: childEnv,
    });

    _child = child;

    // Unref the child so it doesn't prevent the parent process from exiting
    // if stopEmbedWorker() is called. The IPC channel keeps the child alive
    // as long as we're listening; disconnect() in stopEmbedWorker() releases it.
    child.unref();

    child.on('error', (err) => {
      log.error('embed-worker: spawn error', { error: err.message });
      _child = null;
      _ready = false;
      if (!localReady) {
        reject(err);
      }
    });

    child.on('message', (msg: WorkerMessage) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ready') {
        localReady = true;
        _ready = true;
        _backoffMs = BACKOFF_INITIAL_MS; // reset backoff on successful start
        log.info('embed-worker: ready');
        // Resolve startup promise (used by startEmbedWorker)
        if (_startupResolve) {
          _startupResolve();
          _startupResolve = null;
          _startupReject = null;
        }
        resolve();
        flushQueue();
        return;
      }

      const id = (msg as { type: string; id?: string }).id;
      if (!id) return;
      const entry = _pending.get(id);
      if (!entry) return;
      _pending.delete(id);
      clearTimeout(entry.timer);

      if (msg.type === 'result') {
        entry.resolve(msg.data);
      } else if (msg.type === 'error') {
        entry.reject(new Error(msg.message));
      }
    });

    child.on('exit', (code) => {
      log.warn('embed-worker: exited', { code });
      _child = null;
      _ready = false;

      // Reject in-flight requests
      rejectAllPending('embed-worker exited unexpectedly');

      // Reject queued requests during crash-storm cooldown
      if (isCrashStorm()) {
        for (const req of _queue) {
          clearTimeout(req.waitTimer);
          req.reject(new Error('embed-worker: crash storm cooldown'));
        }
        _queue.length = 0;
      }

      if (!localReady) {
        // Failed during startup
        reject(new Error(`embed-worker exited during startup with code ${code}`));
        return;
      }

      // Auto-restart
      scheduleRestart();
    });

    // Startup timeout — stored globally so _resetForTesting() can cancel it
    _startupTimeoutHandle = setTimeout(() => {
      _startupTimeoutHandle = null;
      if (!localReady) {
        log.error('embed-worker: startup timed out');
        child.kill('SIGTERM');
        _child = null;
        reject(new Error('embed-worker startup timed out'));
      }
    }, STARTUP_TIMEOUT_MS);
  });
}

// ── Public API ───────────────────────────────────────────────

/**
 * Fork the embed worker and await its ready signal.
 * projectDir must be the kithkit project root (so we can locate daemon/dist/).
 */
export function startEmbedWorker(projectDir: string): Promise<void> {
  _projectDir = projectDir;
  _stopped = false; // allow restarts after a fresh start
  return new Promise((resolve, reject) => {
    _startupResolve = resolve;
    _startupReject = reject;
    forkWorker().catch(reject);
  });
}

/**
 * Stop the embed worker and cancel all pending/queued requests.
 */
export function stopEmbedWorker(): void {
  _stopped = true;
  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }
  if (_startupTimeoutHandle) {
    clearTimeout(_startupTimeoutHandle);
    _startupTimeoutHandle = null;
  }
  rejectAllPending('embed-worker stopped');
  for (const req of _queue) {
    clearTimeout(req.waitTimer);
    req.reject(new Error('embed-worker stopped'));
  }
  _queue.length = 0;
  if (_child) {
    log.info('embed-worker: stopping');
    const c = _child;
    _child = null;
    // Remove all listeners to prevent the message handler from re-reffing the IPC channel.
    // This is critical: child.on('message', ...) keeps a ref count even after child.unref().
    c.removeAllListeners();
    // Disconnect IPC channel (child gets 'disconnect' event → process.exit(0)).
    // Do this BEFORE kill so the disconnect event is delivered if child is still alive.
    try { c.disconnect(); } catch { /* already disconnected — child already exited */ }
    // Unref the IPC channel handle directly (Node 22+ exposes subprocess.channel)
    try {
      const chan = (c as unknown as { channel?: { unref?: () => void } }).channel;
      if (chan?.unref) chan.unref();
    } catch { /* ignore */ }
    // Unref so the parent doesn't wait for the child to exit.
    c.unref();
    c.kill('SIGTERM');
  }
  _ready = false;
}

/**
 * Generate a 384-dim embedding for a single text string.
 */
export function embed(text: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (_ready && _child) {
      dispatchToWorker(
        { type: 'embed', text },
        (data) => resolve(new Float32Array(data as number[])),
        reject,
      );
    } else if (_inCooldown) {
      reject(new Error('embed-worker: crash storm cooldown — rejecting request'));
    } else if (_queue.length >= QUEUE_MAX) {
      reject(new Error('embed-worker: request queue full'));
    } else {
      // Queue the request with a bounded wait timeout (#513).
      // If the worker is not ready within QUEUE_WAIT_TIMEOUT_MS, reject with
      // 'embed-worker: request queue full' so the existing #510 keyword fallback fires.
      let queueEntry: QueuedRequest;
      const waitTimer = setTimeout(() => {
        const idx = _queue.indexOf(queueEntry);
        if (idx !== -1) {
          _queue.splice(idx, 1);
          reject(new Error('embed-worker: request queue full'));
        }
      }, QUEUE_WAIT_TIMEOUT_MS);
      queueEntry = {
        msg: { type: 'embed', text },
        resolve: (data) => resolve(new Float32Array(data as number[])),
        reject,
        waitTimer,
      };
      _queue.push(queueEntry);
    }
  });
}

/**
 * Generate embeddings for multiple texts.
 */
export function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const doSend = () => {
      dispatchToWorker({ type: 'embed-batch', texts }, (data) => {
        const arrays = (data as number[][]).map((arr) => new Float32Array(arr));
        resolve(arrays);
      }, reject);
    };

    if (_ready && _child) {
      doSend();
    } else if (_inCooldown) {
      reject(new Error('embed-worker: crash storm cooldown — rejecting request'));
    } else if (_queue.length >= QUEUE_MAX) {
      reject(new Error('embed-worker: request queue full'));
    } else {
      let queueEntry: QueuedRequest;
      const waitTimer = setTimeout(() => {
        const idx = _queue.indexOf(queueEntry);
        if (idx !== -1) {
          _queue.splice(idx, 1);
          reject(new Error('embed-worker: request queue full'));
        }
      }, QUEUE_WAIT_TIMEOUT_MS);
      queueEntry = {
        msg: { type: 'embed-batch', texts },
        resolve: (data) => {
          const arrays = (data as number[][]).map((arr) => new Float32Array(arr));
          resolve(arrays);
        },
        reject,
        waitTimer,
      };
      _queue.push(queueEntry);
    }
  });
}

/**
 * Returns true if the embed worker is running and ready.
 */
export function isEmbedWorkerReady(): boolean {
  return _ready;
}

// ── Testing ──────────────────────────────────────────────────

/**
 * Full reset for testing — stops worker, clears all state.
 */
export function _resetForTesting(): void {
  stopEmbedWorker(); // clears _startupTimeoutHandle, _restartTimer, pending, sets _stopped=true
  // NOTE: _stopped remains true — startEmbedWorker() will clear it when actually restarting.
  // This prevents race where deferred exit-event fires scheduleRestart() after reset.
  _backoffMs = BACKOFF_INITIAL_MS;
  _nextId = 0;
  _crashTimestamps.length = 0;
  _inCooldown = false;
  _projectDir = '';
  _startupResolve = null;
  _startupReject = null;
}
