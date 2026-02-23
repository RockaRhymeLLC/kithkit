# Recipe: Voice Integration

End-to-end guide for adding voice capabilities to your Kithkit agent. Voice is **agent-specific** — the kithkit framework provides these recipes and graceful degradation on extension failure, but all voice code lives in your agent repo.

---

## Architecture

Voice in kithkit is a three-component system, all running on-device:

```
Voice Client (macOS menu bar app)
    ↕ HTTP (audio/wav, JSON)
Daemon Voice Extension (your agent repo)
├── STT: whisper-cpp (C++, Homebrew)
├── TTS: Kokoro-ONNX (Python microservice)
└── Voice endpoints: /voice/stt, /voice/speak, /voice/transcribe
```

**Key principle:** The framework handles graceful degradation if voice fails to initialize (PR #7). Everything else — setup, validation, hardening — is your agent's responsibility.

---

## Component Recipes

Follow these in order:

| Step | Recipe | What it sets up |
|------|--------|-----------------|
| 1 | [voice-tts.md](voice-tts.md) | Kokoro TTS — Python venv, model download, TTS worker |
| 2 | [voice-stt.md](voice-stt.md) | Whisper STT — whisper-cpp install, model download |
| 3 | [voice-client.md](voice-client.md) | macOS menu bar app — audio capture, wake word, playback |

Complete each recipe's verification steps before moving to the next.

---

## Quick Start Checklist

### Prerequisites

- [ ] macOS with Homebrew
- [ ] Python 3.12+ (`python3 --version`)
- [ ] Kithkit daemon running (`curl localhost:3847/health`)
- [ ] ~800 MB disk space for models

### Setup (all commands from project root)

```bash
# 1. TTS — Python venv + models
python3 -m venv daemon/src/extensions/voice/.venv
daemon/src/extensions/voice/.venv/bin/pip install kokoro-onnx numpy

mkdir -p models
curl -L -o models/kokoro-v1.0.onnx \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -L -o models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

# 2. STT — whisper-cpp + model
brew install whisper-cpp
curl -L -o models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

# 3. Enable in config
# Set channels.voice.enabled: true in kithkit.config.yaml

# 4. Restart daemon
# (your agent's restart method)
```

### Verification

```bash
# TTS worker health
curl -s http://localhost:3848/health

# Voice status
curl -s http://localhost:3847/voice/status

# TTS round-trip
curl -s -X POST http://localhost:3847/voice/speak \
  -H "Content-Type: application/json" \
  -d '{"text":"Voice integration test."}' -o /tmp/test.wav
file /tmp/test.wav  # Should show: RIFF WAVE audio

# STT round-trip
curl -s -X POST http://localhost:3847/voice/stt --data-binary @/tmp/test.wav
# Should return: {"text": "Voice integration test."}
```

---

## Required Validation in Your Voice Extension

The framework's degraded mode catches crashes, but your extension should fail gracefully **before** crashing. Add these checks to your voice extension's `onInit()`:

```typescript
import { existsSync } from 'node:fs';
import path from 'path';

export async function onInit(projectDir: string): Promise<void> {
  // 1. Check Python venv exists
  const pythonPath = path.join(projectDir, 'daemon/src/extensions/voice/.venv/bin/python3');
  if (!existsSync(pythonPath)) {
    log.warn('Voice: Python venv not found at %s — disabling voice', pythonPath);
    log.warn('Voice: Run the setup steps in docs/recipes/voice-tts.md');
    return;
  }

  // 2. Check model files exist
  const models = ['kokoro-v1.0.onnx', 'voices-v1.0.bin', 'ggml-small.en.bin'];
  for (const model of models) {
    const modelPath = path.join(projectDir, 'models', model);
    if (!existsSync(modelPath)) {
      log.warn('Voice: Missing model %s — disabling voice', model);
      log.warn('Voice: Download instructions in docs/recipes/voice-tts.md');
      return;
    }
  }

  // 3. Check whisper-cpp is installed
  // (Use which/command -v, or try execFileSync with timeout)

  // 4. Spawn TTS worker with error handler
  const proc = spawn(pythonPath, [workerScript], { cwd: projectDir });
  proc.on('error', (err) => {
    log.error('Voice: TTS worker spawn error: %s', err.message);
    // Don't re-throw — framework degraded mode is the backstop
  });

  // 5. Wait for READY signal with timeout
  // (See voice-tts.md reference code for the pattern)
}
```

---

## Config Reference

Minimal voice config in `kithkit.config.yaml`:

```yaml
channels:
  voice:
    enabled: true
    stt:
      engine: whisper-cpp
      model: small.en
      language: en
    tts:
      engine: kokoro
      voice: am_adam
      speed: 1.0
```

Full config options are documented in each component recipe.

---

## Troubleshooting

### Daemon crashes on startup with voice enabled

The Python venv is missing or incomplete. This is the exact scenario from [issue #1](https://github.com/RockaRhymeLLC/kithkit/issues/1). Two layers protect you:

1. **Your extension** should check for the venv before spawning (see validation code above)
2. **The framework** (PR #7) catches uncaught exceptions and enters degraded mode instead of crashing

Fix: create the venv per the TTS recipe, or disable voice in config until ready:

```yaml
channels:
  voice:
    enabled: false
```

### TTS works but STT fails (or vice versa)

The components are independent. Check each one separately using the verification commands above. Common causes:
- STT: `whisper-cli` not on PATH (add `/opt/homebrew/bin` to PATH)
- TTS: Model files missing or corrupted (check file sizes match the recipe)

### Voice client can't connect to daemon

- Verify daemon is running: `curl localhost:3847/health`
- Verify voice endpoints exist: `curl localhost:3847/voice/status`
- Check that voice is enabled in config and the extension initialized successfully

For component-specific troubleshooting, see the individual recipe docs.

---

## What Lives Where

| Component | Location | Owner |
|-----------|----------|-------|
| Degraded mode on extension failure | Framework (`main.ts`) | kithkit (PR #7) |
| Integration recipes (this doc + component docs) | Framework (`docs/recipes/`) | kithkit |
| Voice extension code | Agent repo (`daemon/src/extensions/voice/`) | Your agent |
| TTS worker (`tts-worker.py`) | Agent repo | Your agent |
| Voice client app | Agent repo (`voice-client/`) | Your agent |
| Python venv | Agent repo (`.venv/`) | Your agent |
| Model files | Agent repo (`models/`) | Your agent |
