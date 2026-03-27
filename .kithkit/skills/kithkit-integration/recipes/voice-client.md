# Voice Client (macOS Menu Bar App)

A lightweight macOS menu bar app that handles audio input/output, wake word detection, and push-to-talk. Communicates with the Kithkit daemon over HTTP — no direct Claude API calls.

---

## Architecture

```
Menu Bar App (rumps)
    |
    +── Audio Input Thread ─── sounddevice InputStream
    |       |
    |       +── Wake Word Engine (openWakeWord) ── passive listening
    |       +── PTT Key Monitor ─────────────────── optional
    |       |
    |       v
    |   Recording State Machine:
    |       IDLE ──wakeword/PTT──> RECORDING ──silence/PTT-release──> SENDING
    |                                                                      |
    |                                               POST /api/voice/transcribe
    |                                                                      |
    |                                               POST /api/send (transcript)
    |                                                                      v
    +── Audio Output Thread ──────────────────── POST /api/tts/synthesize
    |       |                                                              |
    |       v                                                              |
    |   sounddevice OutputStream (WAV playback)  <──────────── WAV bytes
    |
    +── Status Icon ──── IDLE / LISTENING / SPEAKING / ERROR
    |
    +── Daemon Heartbeat ──── GET /api/voice/client-status (every 30s)
    +── ChimeHandler ──────── plays chime sounds on state transitions
```

---

## Prerequisites

- macOS 13 (Ventura) or later
- Python 3.12+
- Kithkit daemon running with STT and TTS extensions healthy
- Microphone permission granted to Terminal (or the .app bundle)

---

## Setup

### Install Python Dependencies

```bash
source ~/.kithkit/voice-venv/bin/activate

pip install \
  sounddevice \
  numpy \
  requests \
  pyyaml \
  rumps \
  openwakeword

# Verify
python3 -c "import sounddevice, rumps, openwakeword; print('OK')"
```

### Download openWakeWord Base Model

```bash
python3 -c "
import openwakeword
openwakeword.utils.download_models()
print('Models downloaded')
"
```

### Place Client Script

```bash
mkdir -p ~/.kithkit/voice-client
# Copy client.py to ~/.kithkit/voice-client/client.py
# (see Reference Code below)
```

---

## Client Config Reference

The client reads from `kithkit.config.yaml` (via daemon's config API) or a local `client-config.yaml`. All fields under `channels.voice.client`:

```yaml
channels:
  voice:
    client:
      daemon_url: http://127.0.0.1:3847

      # Audio input
      audio:
        sample_rate: 16000       # Hz — must match STT model expectation
        channels: 1              # Mono
        dtype: int16             # Raw format for whisper
        chunk_size: 512          # Frames per callback
        silence_threshold: 0.01  # RMS below this = silence
        silence_duration_s: 1.5  # Seconds of silence before stopping record

      # Wake word
      wake_word:
        enabled: true
        model: hey_mycroft        # Built-in: hey_mycroft, hey_jarvis, alexa
                                  # Or path to custom .tflite model
        threshold: 0.7            # Detection confidence (0.0–1.0)
        cooldown_s: 2.0           # Minimum seconds between triggers

      # Push-to-talk (mutually exclusive with wake_word in practice)
      ptt:
        enabled: false
        key: F13                  # macOS key name

      # Chime sounds (optional)
      chime:
        listen_start: ~/.kithkit/sounds/listen-start.wav
        listen_end: ~/.kithkit/sounds/listen-end.wav
        error: ~/.kithkit/sounds/error.wav

      # Heartbeat
      heartbeat_interval_s: 30
      heartbeat_timeout_s: 90    # Daemon marks client stale after this
```

---

## Reference Code

### Client Registration + Heartbeat

```python
import requests
import threading
import time
import socket

DAEMON_URL = "http://127.0.0.1:3847"
CLIENT_ID = socket.gethostname()

def register_with_daemon() -> None:
    """Register this client with the daemon on startup."""
    resp = requests.post(f"{DAEMON_URL}/api/voice/client-register", json={
        "client_id": CLIENT_ID,
        "capabilities": ["microphone", "speaker", "wake_word"],
    }, timeout=5)
    resp.raise_for_status()

def start_heartbeat(interval_s: int = 30) -> threading.Thread:
    """Send periodic heartbeat so daemon knows client is alive."""
    def _loop():
        while True:
            try:
                requests.post(f"{DAEMON_URL}/api/voice/client-heartbeat", json={
                    "client_id": CLIENT_ID,
                    "state": _current_state,
                }, timeout=5)
            except Exception as e:
                print(f"Heartbeat failed: {e}")
            time.sleep(interval_s)

    t = threading.Thread(target=_loop, daemon=True)
    t.start()
    return t

_current_state = "idle"
```

### record_until_silence

```python
import numpy as np
import sounddevice as sd
from collections import deque

SAMPLE_RATE = 16000
CHANNELS = 1
SILENCE_THRESHOLD = 0.01
SILENCE_DURATION_S = 1.5
CHUNK_SIZE = 512  # frames per callback

def record_until_silence() -> bytes:
    """
    Record audio until SILENCE_DURATION_S of silence is detected.
    Returns raw int16 PCM bytes (16kHz mono).
    """
    frames: list[np.ndarray] = []
    silence_chunks = 0
    chunks_per_second = SAMPLE_RATE / CHUNK_SIZE
    silence_chunk_limit = int(SILENCE_DURATION_S * chunks_per_second)
    stop_event = threading.Event()

    def callback(indata: np.ndarray, frame_count: int, time_info, status):
        nonlocal silence_chunks
        if status:
            print(f"Audio status: {status}")

        chunk = indata.copy()
        frames.append(chunk)

        # RMS energy for silence detection
        rms = float(np.sqrt(np.mean(chunk.astype(np.float32) ** 2))) / 32768.0
        if rms < SILENCE_THRESHOLD:
            silence_chunks += 1
            if silence_chunks >= silence_chunk_limit:
                stop_event.set()
        else:
            silence_chunks = 0  # reset on any sound

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype='int16',
        blocksize=CHUNK_SIZE,
        callback=callback,
    ):
        stop_event.wait(timeout=30)  # max 30s recording

    audio = np.concatenate(frames, axis=0)
    return audio.tobytes()
```

### send_to_daemon

```python
import io
import wave

def pcm_to_wav(pcm: bytes, sample_rate: int = 16000, channels: int = 1) -> bytes:
    """Wrap raw int16 PCM in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)  # int16 = 2 bytes
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()

def send_to_daemon(pcm: bytes) -> str:
    """Send audio to STT endpoint, return transcript."""
    wav_bytes = pcm_to_wav(pcm)
    resp = requests.post(
        f"{DAEMON_URL}/api/voice/transcribe",
        data=wav_bytes,
        headers={"Content-Type": "audio/wav"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["transcript"]
```

### play_audio

```python
def play_audio(wav_bytes: bytes) -> None:
    """Play WAV audio through the default output device."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, 'rb') as wf:
        sample_rate = wf.getframerate()
        channels = wf.getnchannels()
        frames = wf.readframes(wf.getnframes())

    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels)

    sd.play(audio, samplerate=sample_rate, blocking=True)
```

### voice_pipeline — Main State Machine

```python
def voice_pipeline(chime: 'ChimeHandler') -> None:
    """Full turn: record -> transcribe -> send -> TTS -> play."""
    global _current_state

    chime.play('listen_start')
    _current_state = 'listening'

    try:
        pcm = record_until_silence()
        chime.play('listen_end')
        _current_state = 'processing'

        transcript = send_to_daemon(pcm)
        if not transcript.strip():
            _current_state = 'idle'
            return

        # Send transcript to comms via daemon
        requests.post(f"{DAEMON_URL}/api/send", json={
            "message": transcript,
            "channels": ["voice"],
            "source": "voice_client",
        }, timeout=10)

        # Wait for TTS response
        _current_state = 'speaking'
        resp = requests.post(
            f"{DAEMON_URL}/api/tts/synthesize",
            json={"text": "<pending>"},  # daemon fills from comms response
            timeout=60,
        )
        if resp.ok and resp.headers.get('Content-Type', '').startswith('audio/'):
            play_audio(resp.content)

    except Exception as e:
        chime.play('error')
        print(f"Voice pipeline error: {e}")
    finally:
        _current_state = 'idle'
```

### ChimeHandler — Daemon-Initiated Notifications

```python
import os

class ChimeHandler:
    """Plays chime sounds and handles daemon-pushed audio notifications."""

    def __init__(self, cfg: dict):
        self.sounds = {
            'listen_start': cfg.get('listen_start', ''),
            'listen_end': cfg.get('listen_end', ''),
            'error': cfg.get('error', ''),
        }

    def play(self, name: str) -> None:
        path = self.sounds.get(name, '')
        if path and os.path.exists(path):
            try:
                with wave.open(path, 'rb') as wf:
                    frames = wf.readframes(wf.getnframes())
                    rate = wf.getframerate()
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                sd.play(audio, samplerate=rate, blocking=False)
            except Exception as e:
                print(f"Chime error ({name}): {e}")

    def poll_daemon_notifications(self) -> None:
        """
        Poll daemon for outbound voice notifications (e.g. timer alarms,
        comms-initiated alerts). Daemon queues these at /api/voice/notifications.
        """
        try:
            resp = requests.get(
                f"{DAEMON_URL}/api/voice/notifications",
                params={"client_id": CLIENT_ID},
                timeout=5,
            )
            if not resp.ok:
                return
            for note in resp.json().get("notifications", []):
                if note.get("type") == "audio" and note.get("wav_b64"):
                    import base64
                    wav_bytes = base64.b64decode(note["wav_b64"])
                    play_audio(wav_bytes)
                    requests.delete(
                        f"{DAEMON_URL}/api/voice/notifications/{note['id']}",
                        timeout=5,
                    )
        except Exception:
            pass
```

---

## Wake Word Training with openWakeWord

Use this when the built-in wake words are not suitable. Training runs in Google Colab (free tier is sufficient).

```
1. Record 10–30 positive samples of your wake phrase (WAV, 16kHz mono, ~1s each)
2. Upload to Colab: https://colab.research.google.com/drive/...openWakeWord-training
3. Set TARGET_PHRASE in Colab config
4. Run all cells — generates a .tflite model file
5. Download the .tflite, place at ~/.kithkit/models/wake/<phrase>.tflite
6. Update config:
     wake_word:
       model: /Users/bmo/.kithkit/models/wake/hey_bmo.tflite
       threshold: 0.6   # start lower for custom models
```

openWakeWord docs: https://github.com/dscripka/openWakeWord

---

## macOS .app Wrapper

Wrap the client in a proper .app bundle so it can be added to Login Items and appears as a named app in the Dock/Activity Monitor.

### Info.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Kithkit Voice</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIdentifier</key>
  <string>com.kithkit.voice-client</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>KithkitVoice</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <!-- LSUIElement=true → no Dock icon, menu bar only -->
  <key>NSMicrophoneUsageDescription</key>
  <string>Kithkit Voice requires microphone access for voice input.</string>
</dict>
</plist>
```

### Launcher Script

```bash
#!/usr/bin/env bash
# KithkitVoice.app/Contents/MacOS/launcher
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="/Users/bmo/.kithkit/voice-venv/bin/python3"
CLIENT_SCRIPT="/Users/bmo/.kithkit/voice-client/client.py"

exec "$VENV_PYTHON" "$CLIENT_SCRIPT" >> /tmp/kithkit-voice.log 2>&1
```

### Build and Sign

```bash
APP_PATH="$HOME/Applications/KithkitVoice.app"
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

# Copy files
cp Info.plist "$APP_PATH/Contents/"
cp launcher "$APP_PATH/Contents/MacOS/"
chmod +x "$APP_PATH/Contents/MacOS/launcher"

# Ad-hoc codesign (no Apple Developer account needed for personal use)
codesign --force --deep --sign - "$APP_PATH"

# Add to Login Items via osascript
osascript -e "
  tell application \"System Events\"
    make new login item at end of login items \
      with properties {path:\"$APP_PATH\", hidden:true}
  end tell
"
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No menu bar icon after launch | `rumps` requires a GUI session; SSH sessions won't show menu bar | Launch from a terminal opened in a GUI session (not SSH). For .app, launch from Finder or Login Items. |
| Microphone permission denied | macOS requires explicit mic permission per app | Open System Settings > Privacy & Security > Microphone. Grant access to Terminal or the .app bundle. |
| Daemon not receiving audio | `daemon_url` wrong, or `Content-Type: audio/wav` missing | Test: `curl -s -X POST http://127.0.0.1:3847/api/voice/transcribe -H "Content-Type: audio/wav" --data-binary @test.wav`. Check client logs at `/tmp/kithkit-voice.log`. |
| Wake word fires constantly or never | Threshold mistuned | Start at 0.5 for custom models, 0.7 for built-ins. Increase to reduce false positives; decrease if it never triggers. Check ambient noise RMS vs `silence_threshold`. |
| PTT key not detected | macOS accessibility permission not granted | System Settings > Privacy & Security > Accessibility — add Terminal or the .app. Without this, global key monitoring is blocked. |
| Audio playback rate mismatch (chipmunk/slow voice) | `play_audio` uses TTS `sample_rate` but wav header says different | Always read `wf.getframerate()` from the WAV header rather than hardcoding a rate. Kokoro outputs 24kHz; confirm client passes that to `sd.play`. |
| Client heartbeat stale / daemon shows client offline | Client crashed silently, or heartbeat interval too long | Check `/tmp/kithkit-voice.log`. Reduce `heartbeat_interval_s`. Add a crash-restart wrapper in the launcher script (`while true; do python3 client.py; sleep 2; done`). |
