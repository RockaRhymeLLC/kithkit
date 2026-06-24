/**
 * embed-worker.ts — standalone Node.js child process for ONNX inference.
 *
 * Isolates @huggingface/transformers + onnxruntime-node from the main daemon
 * process. The daemon forks this file (compiled to dist/memory/embed-worker.js)
 * via child_process.fork(), communicates over IPC, and never runs ONNX directly.
 *
 * This prevents the native libc++ mutex abort (std::system_error) that fires
 * when child_process.fork() runs in the same process as an active ONNX session
 * (kithkit#469/#471).
 *
 * Protocol:
 *   parent → worker: {type:'embed',id:string,text:string}
 *                  | {type:'embed-batch',id:string,texts:string[]}
 *   worker → parent: {type:'ready'}
 *                  | {type:'result',id:string,data:number[]}     ← plain number[], NOT Float32Array
 *                  | {type:'error',id:string,message:string}
 *
 * Fake mode: set KITHKIT_EMBED_FAKE=1 to return deterministic vectors without
 * loading the model. Used in IPC/lifecycle unit tests.
 */

// Serialization lock — defence in depth: even inside the worker we serialize
// inference calls so the underlying ONNX session is never re-entered.
let _inferLock: Promise<unknown> = Promise.resolve();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;

async function ensureInitialized(): Promise<void> {
  if (_embedder) return;

  if (process.env['KITHKIT_EMBED_FAKE'] === '1') {
    // Fake embedder: return deterministic 384-dim unit vector
    const dim = 384;
    const val = 1 / Math.sqrt(dim);
    _embedder = async (_text: string) => ({
      data: new Float32Array(dim).fill(val),
    });
    return;
  }

  const mod = await import('@huggingface/transformers');
  const pipelineFn = mod.pipeline;
  _embedder = await pipelineFn('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
}

async function runEmbed(text: string): Promise<number[]> {
  await ensureInitialized();

  const run = _inferLock.then(() => _embedder!(text, { pooling: 'mean', normalize: true }));
  _inferLock = run.catch(() => undefined);
  const output = await run;

  // Send as plain number[] — Float32Array does not survive structured-clone over IPC
  return Array.from(output.data as Float32Array);
}

// ── IPC message handler ──────────────────────────────────────

type InboundMessage =
  | { type: 'embed'; id: string; text: string }
  | { type: 'embed-batch'; id: string; texts: string[] };

process.on('message', (msg: InboundMessage) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'embed') {
    const { id, text } = msg;
    runEmbed(text)
      .then((data) => {
        process.send!({ type: 'result', id, data });
      })
      .catch((err: unknown) => {
        process.send!({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      });

  } else if (msg.type === 'embed-batch') {
    const { id, texts } = msg;
    (async () => {
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await runEmbed(text));
      }
      return results;
    })()
      .then((results) => {
        process.send!({ type: 'result', id, data: results });
      })
      .catch((err: unknown) => {
        process.send!({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      });
  }
});

// ── Lifecycle ────────────────────────────────────────────────

// If parent dies, IPC channel closes — exit so we don't become a zombie
process.on('disconnect', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Initialize on startup and signal readiness to the parent
ensureInitialized()
  .then(() => {
    process.send!({ type: 'ready' });
  })
  .catch((err: unknown) => {
    // Report startup failure; parent will see early exit
    process.stderr.write(
      `embed-worker: init failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
