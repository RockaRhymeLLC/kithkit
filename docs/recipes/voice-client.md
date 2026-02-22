# Recipe: Voice Client (macOS Menu Bar App)

Set up a macOS menu bar voice client for your Kithkit agent. The client handles audio capture, wake word detection, push-to-talk, and audio playback. It communicates with the daemon's voice endpoints over HTTP.

---

## Prerequisites

- macOS 13 or later
- Python 3.12 or later
- Kithkit daemon running with STT and TTS enabled (see `voice-stt.md` and `voice-tts.md`)
- Microphone access granted to Terminal (System Settings > Privacy & Security > Microphone)

---

## Setup Steps

### 1. Install Python dependencies

```bash
pip install sounddevice numpy requests pyyaml rumps
```

- `sounddevice` — cross-platform audio I/O (preferred over pyaudio on macOS)
- `numpy` — audio buffer manipulation
- `requests` — HTTP calls to the daemon
- `pyyaml` — config file parsing
- `rumps` — macOS menu bar / status item

For wake word detection (optional but recommended):

```bash
pip install openwakeword
```

### 2. Create the voice client directory

```bash
mkdir -p voice-client
```

### 3. Create the client config file

Create `voice-client/config.yaml` (see Config Snippet below for full reference).

### 4. Run the client directly (for testing)

```bash
python3 voice-client/client.py
```

A status icon should appear in the menu bar. Verify microphone access, then try push-to-talk.

### 5. (Optional) Train a custom wake word

See the "Wake Word Training" section below for how to create a personalized wake phrase using openWakeWord and Google Colab.

### 6. (Optional) Build a .app wrapper for Login Items

See the "macOS .app Wrapper" section below. Login Items give the client menu bar access and auto-start on login without the limitations of launchd.

---

## Architecture

```
Menu Bar App (Python / rumps)
├── Audio Input Thread (sounddevice InputStream)
│   ├── Wake Word Detection (openWakeWord)
│   └── Push-to-Talk (keyboard listener via pynput)
├── Recording State Machine
│   ├── IDLE → wake word / PTT → RECORDING
│   ├── RECORDING → silence timeout → PROCESSING
│   └── PROCESSING → POST /voice/transcribe → PLAYING
├── Audio Output (sounddevice OutputStream)
│   └── Plays WAV received from daemon
└── Status Icon + Menu
    ├── State: Idle / Listening / Thinking / Speaking
    ├── Toggle wake word
    ├── Toggle mute
    └── Quit
```

---

## Reference Code

### Client config (`voice-client/config.yaml`)

```yaml
# Daemon connection
daemon_url: "http://localhost:3847"
client_id: "voice-client-1"
client_port: 7331             # Local port this client listens on for daemon callbacks

# Audio settings
audio:
  sample_rate: 16000          # Must match STT engine expectation (whisper-cpp: 16kHz)
  channels: 1                 # Mono
  chunk_size: 1024            # Samples per callback — lower = more responsive, higher = more stable
  silence_threshold: 0.01     # RMS threshold below which audio is considered silence
  silence_timeout: 1.5        # Seconds of silence before ending recording

# Wake word detection
wake_word:
  enabled: true
  model: "voice-client/hey_assistant.onnx"   # Path to .onnx model file
  threshold: 0.5              # 0.0-1.0; higher = fewer false positives

# Push-to-talk
ptt:
  enabled: true
  key: "right_cmd"            # Options: right_cmd, right_ctrl, right_shift, right_alt, f13

# Chime / confirmation flow
chime:
  enabled: true
  timeout: 5                  # Seconds to listen for confirmation before timing out
  confirmation_phrases:
    - "yeah"
    - "yes"
    - "what's up"
    - "go ahead"
    - "sure"
  rejection_phrases:
    - "not now"
    - "later"
    - "no"
    - "busy"
    - "stop"

# Sound effects
sounds:
  wake: "voice-client/sounds/wake.wav"         # Played when wake word detected
  end_of_speech: "voice-client/sounds/eos.wav" # Played when recording stops
  error: "voice-client/sounds/error.wav"       # Played on failure
```

### Client registration with daemon (`voice-client/client.py`, excerpt)

```python
import requests
import socket
import threading
import time

DAEMON_URL = "http://localhost:3847"
CLIENT_ID = "voice-client-1"
CLIENT_PORT = 7331


def get_local_ip() -> str:
    """Get LAN IP for daemon callbacks."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def register_with_daemon():
    """Register this client with the daemon. Call at startup and periodically."""
    local_ip = get_local_ip()
    payload = {
        "clientId": CLIENT_ID,
        "callbackUrl": f"http://{local_ip}:{CLIENT_PORT}",
    }
    try:
        resp = requests.post(f"{DAEMON_URL}/voice/register", json=payload, timeout=5)
        resp.raise_for_status()
        print(f"[voice-client] registered at {payload['callbackUrl']}")
    except Exception as e:
        print(f"[voice-client] registration failed: {e}")


def start_heartbeat(interval: int = 30):
    """Re-register periodically — daemon marks clients stale after 60s."""
    def loop():
        while True:
            time.sleep(interval)
            register_with_daemon()
    t = threading.Thread(target=loop, daemon=True)
    t.start()
```

### Full voice pipeline (`voice-client/client.py`, excerpt)

```python
import sounddevice as sd
import numpy as np
import requests
import io
import wave

SAMPLE_RATE = 16000
SILENCE_THRESHOLD = 0.01
SILENCE_TIMEOUT = 1.5  # seconds


def record_until_silence(max_seconds: int = 30) -> bytes:
    """Record audio from the microphone until silence is detected."""
    frames = []
    silence_frames = 0
    silence_limit = int(SAMPLE_RATE / 1024 * SILENCE_TIMEOUT)

    def callback(indata, frame_count, time_info, status):
        nonlocal silence_frames
        frames.append(indata.copy())
        rms = float(np.sqrt(np.mean(indata ** 2)))
        if rms < SILENCE_THRESHOLD:
            silence_frames += 1
        else:
            silence_frames = 0

    with sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype='float32',
        blocksize=1024,
        callback=callback,
    ):
        max_frames = int(SAMPLE_RATE / 1024 * max_seconds)
        while len(frames) < max_frames:
            if silence_frames >= silence_limit:
                break
            sd.sleep(50)

    # Convert float32 frames to 16-bit PCM WAV bytes
    audio = np.concatenate(frames, axis=0)
    pcm = (audio * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def send_to_daemon(wav_bytes: bytes) -> dict:
    """
    POST audio to /voice/transcribe.
    Daemon handles: STT → inject to Claude → wait → TTS → respond.
    Returns dict with 'audio' (WAV bytes), 'transcription', 'response_text'.
    """
    resp = requests.post(
        f"{DAEMON_URL}/voice/transcribe",
        data=wav_bytes,
        headers={"Content-Type": "audio/wav"},
        timeout=60,
    )
    resp.raise_for_status()
    return {
        "audio": resp.content,
        "transcription": resp.headers.get("X-Transcription", ""),
        "response_text": resp.headers.get("X-Response-Text", ""),
    }


def play_audio(wav_bytes: bytes):
    """Play a WAV audio response through the default output device."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, 'rb') as wf:
        rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767
    sd.play(samples, samplerate=rate, blocking=True)


def voice_pipeline():
    """Full round-trip: record → daemon → play response."""
    wav = record_until_silence()
    result = send_to_daemon(wav)
    if result["audio"]:
        play_audio(result["audio"])
```

### Daemon-initiated notification flow (chime)

```python
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

class ChimeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress HTTP logs

    def do_POST(self):
        if self.path == '/chime':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            text = body.get('text', '')
            chime_type = body.get('type', 'info')  # info, reminder, alert

            self.send_response(200)
            self.end_headers()

            # Play chime sound, then listen for confirmation
            play_chime_sound(chime_type)
            confirmed = listen_for_confirmation(timeout=5)

            if confirmed:
                # Trigger TTS via daemon and play
                resp = requests.post(f"{DAEMON_URL}/voice/speak",
                                     json={"text": text}, timeout=30)
                if resp.ok:
                    play_audio(resp.content)
            else:
                # Daemon falls back to Telegram
                pass

        elif self.path == '/play':
            # Daemon sends pre-synthesized WAV directly
            wav = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            self.send_response(200)
            self.end_headers()
            play_audio(wav)

def start_callback_server(port: int = 7331):
    server = HTTPServer(('0.0.0.0', port), ChimeHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
```

---

## Wake Word Training

To use a custom wake phrase (e.g., "Hey Assistant"), train an openWakeWord model using the Google Colab notebook provided by the openWakeWord project.

**Workflow:**

1. Open the [openWakeWord training notebook](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb) in Google Colab
2. Set your target phrase (e.g., `target_phrase = "hey assistant"`)
3. The notebook generates synthetic training audio with Piper TTS, then trains the model
4. Recommended training sequence: 10,000 steps + 1,000 steps + 1,000 steps
5. Download the resulting `.onnx` file and place it at the path in your config

**Tuning tips:**
- Default threshold (`0.5`) works for most environments; increase to `0.7` if you experience false positives
- Retrain with more steps if recall is poor (too many missed activations)
- Single-syllable phrases trigger more false positives than multi-syllable phrases

---

## macOS .app Wrapper

A `.app` wrapper lets you add the voice client to Login Items so it starts automatically on login with full GUI access (required for the menu bar).

### Why .app and not launchd?

launchd `LaunchAgents` do not get access to `WindowServer` — they cannot draw in the menu bar. Login Items run in the user's GUI session and have full access.

### Minimal .app structure

```
VoiceClient.app/
└── Contents/
    ├── Info.plist
    ├── MacOS/
    │   └── launcher        # Shell script
    └── Resources/
```

**Info.plist** (key entries):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>VoiceClient</string>
    <key>CFBundleIdentifier</key>
    <string>com.yourname.voiceclient</string>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>LSUIElement</key>
    <true/>              <!-- Hides from Dock, shows only in menu bar -->
    <key>NSMicrophoneUsageDescription</key>
    <string>Voice client needs microphone access to listen for your commands.</string>
</dict>
</plist>
```

**MacOS/launcher** (shell script — do NOT use `exec`):

```bash
#!/bin/bash
# Do not use exec here — exec replaces the shell with Python,
# which kills the .app bundle's GUI identity.
cd /path/to/your/project
/path/to/python3 voice-client/client.py
```

```bash
chmod +x VoiceClient.app/Contents/MacOS/launcher
```

### Sign after any file changes

Copying files into a signed `.app` invalidates its code signature. macOS will silently refuse to launch it. Always re-sign:

```bash
codesign --force --sign - VoiceClient.app
```

### Add to Login Items

System Settings > General > Login Items > click "+" > select `VoiceClient.app`

### Never kill the voice app remotely

If you kill the process via SSH, the user must manually reopen it from Finder or Login Items. There is no reliable way to relaunch a GUI session app from a non-GUI context (launchd `open` fails with error -10669). Handle errors gracefully within the app instead of relying on external process management.

---

## Config Snippet

Daemon-side voice channel config (`kithkit.config.yaml`):

```yaml
channels:
  voice:
    enabled: true

    wake_word:
      engine: openwakeword
      phrase: "Hey Assistant"

    client:
      listen_after_response: 3      # Seconds to stay in "listening" state after TTS ends
      chime_timeout: 5              # Seconds to wait for user confirmation after chime
      confirmation_phrases:
        - "yeah"
        - "yes"
        - "what's up"
        - "go ahead"
        - "sure"
      rejection_phrases:
        - "not now"
        - "later"
        - "no"
        - "busy"
        - "stop"

    # Daemon-initiated voice interactions (chimes)
    initiation:
      calendar_reminders: true
      urgent_emails: true
      todo_nudges: false
```

**Daemon endpoints the client uses:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/voice/register` | POST | Register client and callback URL |
| `/voice/transcribe` | POST | Send WAV, receive transcription + TTS response |
| `/voice/speak` | POST | Text-only TTS request (for chime confirmations) |

**Callback endpoints the daemon calls on the client:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/chime` | POST | Daemon initiates voice interaction (reminder, alert) |
| `/play` | POST | Daemon sends pre-synthesized WAV to play |

---

## Troubleshooting

### No menu bar icon appears

The app must be launched from a GUI session. Check your launch method:

- Finder double-click: works
- Login Items (System Settings): works
- Spotlight: works
- `open VoiceClient.app` from Terminal: works if Terminal has GUI access
- SSH remote launch via `open`: FAILS (error -10669)
- launchd LaunchAgent: FAILS (no WindowServer access)

If launched correctly and the icon still does not appear, check that `LSUIElement` is `true` in Info.plist (hides the Dock icon but keeps the menu bar icon).

### Microphone permission denied

The system will only prompt once. If you denied the permission:

1. System Settings > Privacy & Security > Microphone
2. Find your app or Terminal in the list and enable it
3. Restart the app

If the app is unsigned or improperly launched, macOS may not prompt at all. Ensure the `.app` is properly signed and launched from a GUI context.

### Daemon not receiving audio

Check that the client registered successfully. Look for the registration log message on startup:

```
[voice-client] registered at http://192.168.x.x:7331
```

Verify the daemon is reachable:

```bash
curl http://localhost:3847/health
```

Check that the daemon has the `/voice/transcribe` endpoint enabled (requires STT and TTS both configured and running).

### Wake word triggers too often (false positives)

Increase the threshold in `config.yaml`:

```yaml
wake_word:
  threshold: 0.7   # up from 0.5
```

Retrain the model with harder negative examples if false positives persist at high thresholds.

### Wake word never triggers (misses activations)

Lower the threshold:

```yaml
wake_word:
  threshold: 0.35
```

Check that the `.onnx` model file path is correct and the file is not corrupted. Test detection directly:

```python
from openwakeword.model import Model
model = Model(wakeword_models=["voice-client/hey_assistant.onnx"])
# Feed audio chunks and check model.predict() output
```

### Push-to-talk key not detected

PTT uses `pynput` for keyboard listening. If the key is not registered:

1. Grant Accessibility access to Terminal (or your .app) in System Settings > Privacy & Security > Accessibility
2. Supported modifier keys: `right_cmd`, `right_ctrl`, `right_shift`, `right_alt`
3. Test that the key listener fires with a print statement before wiring it to recording

### Audio playback distorted or at wrong speed

Kokoro TTS outputs 24 kHz mono audio. Ensure your `play_audio()` function uses the sample rate from the WAV header (`wf.getframerate()`) rather than hardcoding 16000. The daemon's STT endpoint expects 16 kHz input, but TTS output is 24 kHz — these are different.

### Client stops receiving daemon chimes after a while

The daemon marks registered clients as stale after 60 seconds without a heartbeat. Start the heartbeat thread (see reference code) with a 30-second interval to keep the registration alive.
