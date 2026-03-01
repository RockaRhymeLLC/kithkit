# Recipe: Text-to-Speech (Kokoro ONNX)

Set up high-quality, low-latency text-to-speech for your Kithkit agent using Kokoro-ONNX. Synthesis runs entirely on-device with no API costs. A persistent Python microservice handles synthesis; the daemon manages its lifecycle.

---

## Prerequisites

- Python 3.12 or later (`python3 --version`)
- `pip` available in your Python environment
- ONNX model files (downloaded in Setup Steps)
- Kithkit daemon running

---

## Setup Steps

### 1. Create a virtual environment

Create the venv inside the daemon's voice directory to keep it isolated:

```bash
python3 -m venv daemon/src/voice/.venv
```

### 2. Activate the venv

```bash
source daemon/src/voice/.venv/bin/activate
```

You should see `(.venv)` in your shell prompt.

### 3. Install kokoro-onnx

```bash
pip install kokoro-onnx
```

### 4. Create a models directory and download model files

```bash
mkdir -p models
```

Download the ONNX model (310 MB):

```bash
curl -L -o models/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
```

Download the voices bundle (27 MB):

```bash
curl -L -o models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

### 5. Test synthesis manually

```bash
source daemon/src/voice/.venv/bin/activate
pip install soundfile   # required for the manual test below
python3 - <<'EOF'
from kokoro_onnx import Kokoro
import soundfile as sf

kokoro = Kokoro("models/kokoro-v1.0.onnx", "models/voices-v1.0.bin")
samples, sample_rate = kokoro.create("Hello, I am your assistant.", voice="am_adam", speed=1.0)
sf.write("test_output.wav", samples, sample_rate)
print(f"Wrote test_output.wav at {sample_rate} Hz")
EOF
```

Play back `test_output.wav` to verify audio quality.

### 6. Enable TTS in the daemon config

```yaml
channels:
  voice:
    tts:
      engine: kokoro
      voice: am_adam
      speed: 1.0
```

Restart the daemon to start the TTS worker.

---

## Reference Code

### TTS Worker (`daemon/src/voice/tts-worker.py`)

A persistent HTTP microservice on port 3848. The daemon spawns this as a child process and communicates with it over HTTP. Keep library output on stderr so the `READY` signal on stdout is unambiguous.

```python
#!/usr/bin/env python3
"""TTS Worker — persistent HTTP microservice on port 3848."""
import sys
import json
import struct
import io
from http.server import HTTPServer, BaseHTTPRequestHandler

# Redirect library stderr noise before importing heavy deps
import logging
logging.disable(logging.WARNING)

from kokoro_onnx import Kokoro

# Load models at startup (30-60 seconds first run, ~5s subsequently)
MODEL_PATH = "models/kokoro-v1.0.onnx"
VOICES_PATH = "models/voices-v1.0.bin"
kokoro = Kokoro(MODEL_PATH, VOICES_PATH)


def samples_to_wav(samples, sample_rate: int) -> bytes:
    """Convert float32 numpy samples to a WAV byte string."""
    import numpy as np
    pcm = (samples * 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    # WAV header
    data_len = len(pcm)
    buf.write(b'RIFF')
    buf.write(struct.pack('<I', 36 + data_len))
    buf.write(b'WAVE')
    buf.write(b'fmt ')
    buf.write(struct.pack('<IHHIIHH', 16, 1, 1, sample_rate,
                          sample_rate * 2, 2, 16))
    buf.write(b'data')
    buf.write(struct.pack('<I', data_len))
    buf.write(pcm)
    return buf.getvalue()


class TTSHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress HTTP access logs on stdout
        pass

    def do_POST(self):
        if self.path == '/synthesize':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            text = body.get('text', '')
            voice = body.get('voice', 'am_adam')
            speed = float(body.get('speed', 1.0))

            try:
                samples, sample_rate = kokoro.create(text, voice=voice, speed=speed)
                wav_bytes = samples_to_wav(samples, sample_rate)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(wav_bytes)))
                self.end_headers()
                self.wfile.write(wav_bytes)
            except Exception as e:
                print(f"ERROR synthesis failed: {e}", file=sys.stderr, flush=True)
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "engine": "kokoro",
                "model": MODEL_PATH,
            }).encode())

# Signal readiness — daemon watches for this exact string on stdout.
# IMPORTANT: Print AFTER models are loaded, not before.
print("READY port=3848", flush=True)

HTTPServer(('127.0.0.1', 3848), TTSHandler).serve_forever()
```

### Daemon-side TTS lifecycle (`daemon/src/voice/tts.ts`)

```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';

const TTS_PORT = 3848;
const STARTUP_TIMEOUT_MS = 120_000; // model loading can take 60s on first run
const HEALTH_INTERVAL_MS = 30_000;
const MAX_RETRIES = 3;

let worker: ChildProcess | null = null;
let retries = 0;

export async function startTTSWorker(projectDir: string): Promise<void> {
  const venvPython = path.join(projectDir, 'daemon/src/voice/.venv/bin/python3');
  const workerScript = path.join(projectDir, 'daemon/src/voice/tts-worker.py');

  worker = spawn(venvPython, [workerScript], {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Forward stderr to daemon logs
  worker.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[tts-worker] ${chunk}`);
  });

  // Wait for READY signal on stdout.
  // IMPORTANT: Split by newlines — library output can intermix with the signal.
  await waitForReady(worker);

  worker.on('exit', (code) => {
    if (retries < MAX_RETRIES) {
      retries++;
      console.error(`[tts] worker exited (code=${code}), restarting (attempt ${retries})`);
      setTimeout(() => startTTSWorker(projectDir), 2000);
    } else {
      console.error('[tts] worker exceeded max retries — TTS disabled');
    }
  });

  // Periodic health check
  setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${TTS_PORT}/health`);
      if (!res.ok) throw new Error(`health check failed: ${res.status}`);
      retries = 0; // reset on successful health check
    } catch {
      console.error('[tts] health check failed — worker may be unresponsive');
    }
  }, HEALTH_INTERVAL_MS);
}

function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TTS worker startup timeout')), STARTUP_TIMEOUT_MS);
    let buffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Split by newlines to handle interleaved library output
      for (const line of buffer.split('\n')) {
        if (line.trim().startsWith('READY')) {
          clearTimeout(timer);
          resolve();
          return;
        }
      }
    });

    proc.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('TTS worker exited before READY'));
    });
  });
}

export async function synthesize(
  text: string,
  voice: string,
  speed = 1.0
): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${TTS_PORT}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
  });
  if (!res.ok) throw new Error(`TTS synthesis failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
```

---

## Config Snippet

```yaml
channels:
  voice:
    tts:
      engine: kokoro           # kokoro (default) or qwen3-tts-mlx (alternative)
      voice: am_adam           # See voice list below
      speed: 1.0               # 0.5 (slow) to 2.0 (fast), 1.0 = natural

      worker:
        port: 3848
        startup_timeout: 120   # seconds — model loading is slow on first run
        health_interval: 30    # seconds between health pings
        max_retries: 3         # auto-restart attempts before giving up
```

**Available voices** (Kokoro v1.0, selection):

| Voice ID | Style |
|----------|-------|
| `am_adam` | American Male |
| `am_michael` | American Male |
| `am_eric` | American Male |
| `af_bella` | American Female |
| `af_sarah` | American Female |
| `af_nicole` | American Female |
| `bf_emma` | British Female |
| `bm_george` | British Male |

54 voices total — see the kokoro-onnx documentation for the full list.

**Daemon endpoints**:
- `POST /voice/speak` — synthesize text to WAV and return audio
  - Body: `{ "text": "...", "voice": "am_adam", "speed": 1.0 }`
  - Response: `Content-Type: audio/wav` (24 kHz mono)
  - Max text length: 500 characters per request

**Performance** (Apple M4 Mac mini, `small.en` model):

| Utterance length | Synthesis time |
|-----------------|---------------|
| Short (~10 words) | ~0.4 s |
| Medium (~40 words) | ~0.9 s |
| Long (~120 words) | ~2.4 s |

**Alternative engine**: Qwen3-TTS (`mlx-audio`)

```bash
pip install mlx-audio
```

Slower (3-13x) but produces different voice characteristics. Set `engine: qwen3-tts-mlx` in config. Requires Apple Silicon.

---

## Troubleshooting

### Worker process fails to start

Check that the venv Python is executable and the worker script path is correct:

```bash
ls -la daemon/src/voice/.venv/bin/python3
ls daemon/src/voice/tts-worker.py
```

Activate the venv and test the worker directly:

```bash
source daemon/src/voice/.venv/bin/activate
python3 daemon/src/voice/tts-worker.py
# Should print: READY port=3848
```

If it fails, check that `kokoro-onnx` is installed in the venv (not the system Python).

### Startup takes a very long time (or times out)

Model loading takes 30-60 seconds on first use as ONNX Runtime warms up. The default `startup_timeout` is 120 seconds. If you see timeout errors, increase this value or ensure both model files are present and not corrupted:

```bash
ls -lh models/
# Should show:
# kokoro-v1.0.onnx  ~310 MB
# voices-v1.0.bin    ~27 MB
```

Re-download if sizes are wrong.

### No audio output / WAV is silent or corrupted

Kokoro outputs 24 kHz mono float32 samples. Verify your playback code handles this sample rate. The `samples_to_wav()` helper in the reference code produces a correct WAV header. If you are piping raw bytes elsewhere, ensure the consumer expects 24000 Hz.

### stdout parsing misses the READY signal

Library imports (ONNX Runtime, NumPy) print to stdout before the model loads. The reference code splits stdout by newlines and scans each line for the `READY` prefix. Make sure you are not reading stdout as a single chunk. The line will look exactly like:

```
READY port=3848
```

If library output is still interfering, add this before all imports in the worker:

```python
import os, sys
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
sys.stderr = open(os.devnull, 'w')  # redirect library noise
```

Then restore stderr after imports if you want worker errors to surface.

### Worker crashes repeatedly (exceeds max retries)

Check daemon logs for the exit code. Common causes:
- Out of memory — close other applications; the ONNX model requires ~500 MB RAM
- Corrupted model files — re-download both `.onnx` and `.bin` files
- Python version mismatch — venv must be Python 3.12+

### `ModuleNotFoundError: kokoro_onnx`

The daemon is using the system Python, not the venv. Ensure `venvPython` in the daemon code points to the venv's python3 binary, not `/usr/bin/python3`.
