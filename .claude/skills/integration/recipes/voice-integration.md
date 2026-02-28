# Voice Integration Overview

Voice integration adds a fully on-device voice pipeline to Kithkit. All three components run locally — no cloud STT or TTS services required.

---

## Architecture

```
User speaks
    |
    v
[ Voice Client ]  ──────────────────────────────────────────────────────────
  macOS menu bar app                                                         |
  - Wake word detection (openWakeWord) or PTT key                           |
  - Audio capture (sounddevice)                                              |
  - Silence detection                                                        |
    |                                                                        |
    | POST /api/voice/transcribe (raw audio bytes)                          |
    v                                                                        |
[ STT — whisper-cpp ]  ─────────────────────────────────────────────────   |
  Daemon extension                                                           |
  - Runs whisper.cpp via subprocess                                          |
  - Returns transcript text                                                  |
    |                                                                       |
    | transcript text                                                       |
    v                                                                       |
  Daemon routes to comms agent → Claude responds                            |
    |                                                                       |
    | response text                                                         |
    v                                                                       |
[ TTS — Kokoro-ONNX ]  ─────────────────────────────────────────────────  |
  Daemon extension                                                           |
  - Runs Python + Kokoro ONNX model                                         |
  - Returns WAV audio bytes                                                  |
    |                                                                       |
    | WAV audio (chunked)                                                   |
    v                                                                       |
[ Voice Client ]  ──────────────────────────────────────────────────────  |
  - Plays audio via sounddevice                                              |
  - Status icon updates (idle / listening / speaking)                        |
```

All three components are independent services. They communicate only through the daemon's HTTP API.

---

## Component Recipe Order

Install and validate in this order — each layer depends on the one before it:

1. **TTS (Kokoro-ONNX)** — `recipes/tts-kokoro.md`
   - Requires: Python 3.12+ venv, `kokoro-onnx` package, ONNX model files
   - Validates independently: `GET /api/tts/health`

2. **STT (whisper-cpp)** — `recipes/stt-whisper.md`
   - Requires: compiled `whisper-cpp` binary, `.gguf` model file
   - Validates independently: `POST /api/voice/transcribe` with a test WAV

3. **Voice Client** — `recipes/voice-client.md`
   - Requires: daemon running with both STT and TTS healthy, Python deps
   - Validates: full round-trip speak → transcript → response → audio playback

Do not attempt to set up the Voice Client before both STT and TTS are confirmed healthy.

---

## Quick Start Checklist

```bash
# 1. Set up Python venv (shared by TTS and Voice Client)
python3.12 -m venv ~/.kithkit/voice-venv
source ~/.kithkit/voice-venv/bin/activate
pip install kokoro-onnx sounddevice numpy requests pyyaml rumps openwakeword

# 2. Download Kokoro ONNX model files
mkdir -p ~/.kithkit/models/kokoro
curl -L -o ~/.kithkit/models/kokoro/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v1.0.onnx
curl -L -o ~/.kithkit/models/kokoro/voices.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/voices.bin

# 3. Build whisper.cpp
git clone https://github.com/ggerganov/whisper.cpp ~/.kithkit/whisper.cpp
cd ~/.kithkit/whisper.cpp && make -j$(sysctl -n hw.ncpu)

# 4. Download whisper model (base.en recommended for speed)
bash ~/.kithkit/whisper.cpp/models/download-ggml-model.sh base.en

# 5. Add voice config to kithkit.config.yaml (see Config Reference below)

# 6. Reload daemon config
curl -s -X POST http://localhost:3847/api/config/reload

# 7. Verify all components (see Verification Commands below)

# 8. Launch Voice Client
source ~/.kithkit/voice-venv/bin/activate
python3 ~/.kithkit/voice-client/client.py
```

---

## Verification Commands

### TTS Health Check

```bash
curl -s http://localhost:3847/api/tts/health | jq .
# Expected: { "status": "ok", "model": "kokoro-v1.0", "voices": [...] }
```

### Voice (STT) Status

```bash
curl -s http://localhost:3847/api/voice/status | jq .
# Expected: { "status": "ready", "model": "base.en", "binary": "/path/to/main" }
```

### TTS Round-Trip

```bash
curl -s -X POST http://localhost:3847/api/tts/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, voice integration is working.", "voice": "af_sky"}' \
  -o /tmp/tts-test.wav

# Play it
afplay /tmp/tts-test.wav
```

### STT Round-Trip

```bash
# Record 3 seconds of audio (requires SoX)
rec -r 16000 -c 1 -b 16 /tmp/stt-test.wav trim 0 3

# Transcribe
curl -s -X POST http://localhost:3847/api/voice/transcribe \
  -H "Content-Type: audio/wav" \
  --data-binary @/tmp/stt-test.wav | jq .
# Expected: { "transcript": "...", "duration_ms": ... }
```

---

## Required Validation in Extension onInit

The voice extension must validate all dependencies before registering its routes. A missing component should disable the extension cleanly, not crash the daemon.

```typescript
import { existsSync, accessSync, constants } from 'fs';
import { execFileSync } from 'child_process';

export async function onInit(daemon: DaemonContext) {
  const cfg = daemon.config.channels?.voice;
  if (!cfg?.enabled) {
    daemon.logger.info('voice', 'Voice extension disabled in config');
    return;
  }

  const errors: string[] = [];

  // 1. Python venv
  const venvPython = cfg.python_venv;
  if (!existsSync(venvPython)) {
    errors.push(`Python venv not found: ${venvPython}`);
  }

  // 2. Kokoro ONNX model files
  const kokoroModel = cfg.tts.model_path;
  const kokoroVoices = cfg.tts.voices_path;
  if (!existsSync(kokoroModel)) errors.push(`Kokoro model not found: ${kokoroModel}`);
  if (!existsSync(kokoroVoices)) errors.push(`Kokoro voices not found: ${kokoroVoices}`);

  // 3. whisper-cpp binary
  const whisperBin = cfg.stt.binary_path;
  if (!existsSync(whisperBin)) {
    errors.push(`whisper.cpp binary not found: ${whisperBin}`);
  } else {
    try {
      accessSync(whisperBin, constants.X_OK);
    } catch {
      errors.push(`whisper.cpp binary not executable: ${whisperBin}`);
    }
  }

  // 4. whisper model file
  const whisperModel = cfg.stt.model_path;
  if (!existsSync(whisperModel)) errors.push(`Whisper model not found: ${whisperModel}`);

  if (errors.length > 0) {
    daemon.logger.error('voice', 'Voice extension disabled due to missing dependencies:');
    for (const e of errors) daemon.logger.error('voice', `  - ${e}`);
    // Do NOT throw — let daemon continue without voice
    return;
  }

  // All checks passed — register routes
  registerVoiceRoutes(daemon);
  registerTtsRoutes(daemon);
  daemon.logger.info('voice', 'Voice extension initialized successfully');
}
```

---

## Config Reference

```yaml
channels:
  voice:
    enabled: true
    python_venv: /Users/bmo/.kithkit/voice-venv/bin/python3

    tts:
      enabled: true
      model_path: /Users/bmo/.kithkit/models/kokoro/kokoro-v1.0.onnx
      voices_path: /Users/bmo/.kithkit/models/kokoro/voices.bin
      default_voice: af_sky
      sample_rate: 24000
      speed: 1.0

    stt:
      enabled: true
      binary_path: /Users/bmo/.kithkit/whisper.cpp/main
      model_path: /Users/bmo/.kithkit/whisper.cpp/models/ggml-base.en.bin
      language: en
      threads: 4

    client:
      # These are read by the Voice Client, not the daemon
      daemon_url: http://127.0.0.1:3847
      wake_word:
        enabled: true
        model: hey_mycroft   # or path to custom .tflite
        threshold: 0.7
      ptt:
        enabled: false
        key: F13              # function key for PTT
      audio:
        sample_rate: 16000
        channels: 1
        silence_threshold: 0.01
        silence_duration_s: 1.5
      chime:
        listen_start: /Users/bmo/.kithkit/sounds/listen-start.wav
        listen_end: /Users/bmo/.kithkit/sounds/listen-end.wav
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Daemon crashes on startup after adding voice config | Missing Python venv or model files; exception propagating from `onInit` | Ensure `onInit` uses the guard pattern above (log errors, return early, do not throw). Check daemon logs for the specific missing path. |
| TTS health returns `error` | Kokoro model load failed (wrong path, corrupt download) | Re-download model files; verify SHA if provided. Run `python3 -c "import kokoro_onnx"` in the venv to check the package itself. |
| STT transcription fails | whisper.cpp binary missing execute permission or wrong model format | Run `chmod +x` on the binary. Confirm model is `.gguf` format (not `.bin` from older repos). |
| Voice Client can't connect to daemon | Wrong `daemon_url` or daemon not running | `curl http://127.0.0.1:3847/health` from the same machine. Check client config `daemon_url`. |
| TTS works, STT doesn't (or vice versa) | Components are independent — one can fail without affecting the other | Check each extension's health endpoint separately. Restart just the affected component's process. |
| Everything works in test, silent in production | System audio output device changed | Check macOS Sound settings. Voice Client uses the default output device — switch to the correct one. |
