# Text-to-Speech (Kokoro ONNX)

On-device TTS via the Kokoro ONNX model, served by a persistent Python microservice. No API costs. The daemon manages the worker lifecycle and auto-restarts it on crash.

## Prerequisites

- Python 3.12+
- ~340MB disk space for model files
- `kokoro-onnx` Python package

## Setup

```bash
# Create a dedicated venv
python3.12 -m venv ~/.venvs/kokoro
source ~/.venvs/kokoro/bin/activate

# Install kokoro-onnx
pip install kokoro-onnx

# Download model files (~340MB total)
# kokoro-v1.0.onnx (310MB) + voices-v1.0.bin (27MB)
python - <<'EOF'
from huggingface_hub import hf_hub_download
hf_hub_download(repo_id="hexgrad/Kokoro-82M-ONNX", filename="kokoro-v1.0.onnx", local_dir="~/.models/kokoro")
hf_hub_download(repo_id="hexgrad/Kokoro-82M-ONNX", filename="voices-v1.0.bin", local_dir="~/.models/kokoro")
EOF

# Test synthesis (should produce audio.wav in current directory)
python -c "
from kokoro_onnx import Kokoro
import soundfile as sf
k = Kokoro('~/.models/kokoro/kokoro-v1.0.onnx', '~/.models/kokoro/voices-v1.0.bin')
samples, sr = k.create('Hello from Kithkit.', voice='am_michael', speed=1.0, lang='en-us')
sf.write('audio.wav', samples, sr)
print('OK')
"
```

## Config Snippet

```yaml
channels:
  voice:
    tts:
      engine: kokoro
      venv_path: ~/.venvs/kokoro
      model_path: ~/.models/kokoro/kokoro-v1.0.onnx
      voices_path: ~/.models/kokoro/voices-v1.0.bin
      default_voice: am_michael
      default_speed: 1.0
      worker:
        port: 3848
        startup_timeout_ms: 90000   # model loading can take 30-60s on first run
        health_check_interval_ms: 30000
        max_restart_attempts: 3
```

## Available Voices

| Voice ID    | Gender | Accent  | Character      |
|-------------|--------|---------|----------------|
| am_adam     | M      | American | Neutral        |
| am_michael  | M      | American | Clear, warm    |
| af_bella    | F      | American | Bright         |
| af_sarah    | F      | American | Calm           |
| bf_emma     | F      | British  | Crisp          |
| bm_george   | M      | British  | Authoritative  |
| bm_lewis    | M      | British  | Casual         |

Run `Kokoro.list_voices()` on your installed version for the full list, as it expands with model updates.

## Key Reference Code

### tts-worker.py (Python Microservice)

```python
#!/usr/bin/env python3
"""
Kokoro TTS microservice. Runs on port 3848.
Daemon starts this process and waits for "READY" on stdout before routing requests.
"""
import sys
import json
import struct
import wave
import io
from http.server import HTTPServer, BaseHTTPRequestHandler
from kokoro_onnx import Kokoro

MODEL_PATH = sys.argv[1]
VOICES_PATH = sys.argv[2]
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 3848

kokoro = Kokoro(MODEL_PATH, VOICES_PATH)


def samples_to_wav(samples, sample_rate: int = 24000) -> bytes:
    """Convert float32 numpy samples to 16-bit PCM WAV bytes."""
    pcm = (samples * 32767).astype('int16')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)          # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # suppress access log noise

    def do_POST(self):
        if self.path != '/synthesize':
            self.send_error(404)
            return

        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        text  = body.get('text', '')
        voice = body.get('voice', 'am_michael')
        speed = float(body.get('speed', 1.0))

        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang='en-us')
        wav_bytes = samples_to_wav(samples, sr)

        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(wav_bytes)))
        self.end_headers()
        self.wfile.write(wav_bytes)


server = HTTPServer(('127.0.0.1', PORT), TTSHandler)
print('READY', flush=True)   # daemon scans stdout for this exact string
server.serve_forever()
```

### Daemon-Side Lifecycle (TypeScript)

```typescript
import { spawn, ChildProcess } from 'child_process';

interface TTSWorkerState {
  process: ChildProcess | null;
  ready: boolean;
  restarts: number;
}

const MAX_RESTARTS = 3;
const worker: TTSWorkerState = { process: null, ready: false, restarts: 0 };

async function startTTSWorker(cfg: TTSConfig): Promise<void> {
  const python = `${cfg.venvPath}/bin/python3`;

  worker.process = spawn(python, [
    cfg.workerScript,
    cfg.modelPath,
    cfg.voicesPath,
    String(cfg.port),
  ]);

  await waitForReady(worker.process, cfg.startupTimeoutMs);
  worker.ready = true;
  worker.restarts = 0;

  worker.process.on('exit', (code) => {
    worker.ready = false;
    if (worker.restarts < MAX_RESTARTS) {
      worker.restarts++;
      setTimeout(() => startTTSWorker(cfg), 2000);
    } else {
      console.error(`TTS worker crashed ${MAX_RESTARTS} times — giving up`);
    }
  });
}

async function waitForReady(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TTS worker startup timeout')), timeoutMs);
    let buffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Split by newlines — READY may arrive mid-buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === 'READY') {
          clearTimeout(timer);
          resolve();
        }
      }
    });

    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`TTS worker exited early with code ${code}`));
    });
  });
}
```

## Performance (Apple M4)

| Input length | Synthesis time |
|-------------|---------------|
| Short (~10 words)  | ~0.4s |
| Medium (~40 words) | ~0.9s |
| Long (~120 words)  | ~2.4s |

Performance scales roughly linearly with token count. The model runs on CPU via ONNX Runtime — no GPU/MPS dependency.

## Alternative Engine

**Qwen3-TTS via mlx-audio** — runs on Apple Silicon MLX, different voice characteristics. Slower than Kokoro on equivalent hardware but produces more expressive speech. Drop-in substitute if you configure `engine: qwen3-mlx` and point to the mlx-audio worker script. Not covered in detail here.

## Troubleshooting

**Worker won't start**
Verify the venv path. The daemon uses the absolute path to `python3` inside the venv — it does not activate the venv. Check:
```bash
~/.venvs/kokoro/bin/python3 -c "import kokoro_onnx; print('ok')"
```
If this fails, the package is not installed in the venv.

**Startup timeout (model loading takes 30-60s on first run)**
The ONNX runtime compiles the model graph on first load and caches it. Subsequent starts are faster. Set `startup_timeout_ms: 90000` in config. If it still times out, check available RAM — the model needs ~600MB free.

**Silent / empty audio output**
The worker outputs WAV at **24kHz**. If your audio pipeline resamples to 16kHz without knowing the source rate, the result will be pitched or silent. Pass the sample rate from the HTTP response context — `samples_to_wav` uses `24000` by default, matching Kokoro's output.

**`READY` signal missed / worker marked not-ready despite running**
The `waitForReady` scanner must split by `\n`, not look for exact-length chunks. The reference code above does this correctly. A common mistake is checking `chunk.toString() === 'READY\n'` — this fails when stdout arrives in partial chunks.

**Max restarts exceeded**
The worker exited 3 times in a row. Check stderr for Python tracebacks:
```bash
# Temporarily redirect worker stderr to a file to capture crash output
```
Common causes: model file missing/corrupted, out of memory, port 3848 already in use.

**`ModuleNotFoundError: No module named 'kokoro_onnx'`**
The daemon is calling the system Python instead of the venv Python. Always use the absolute path to the venv binary (`~/.venvs/kokoro/bin/python3`), not `python3` or `python`.
