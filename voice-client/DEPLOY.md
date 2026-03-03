# Voice Client Deployment Guide

Deploy the CC4Me voice client to a target laptop. This guide is written for CC4Me agents to follow autonomously.

## Overview

The voice client is a macOS menu bar app that provides wake-word detection, push-to-talk, and voice interaction. It runs on the user's laptop and connects to the agent's daemon (on a Mac Mini or similar) for STT, LLM processing, and TTS.

**Architecture**: Laptop (voice client) → LAN/tunnel → Mac Mini (daemon with voice server)

## Prerequisites

On the **target laptop** (where the voice client will run):
- macOS 13+ (Ventura or later)
- Python 3.10+ (`brew install python@3.12` if needed)
- Homebrew (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`)
- `rumps` for the menu bar app (installed automatically by install.sh)

On the **agent's machine** (Mac Mini running the daemon):
- Daemon running with voice module enabled (`voice.enabled: true` in cc4me.config.yaml)
- TTS worker running (Kokoro or Qwen3-TTS)
- whisper-cli installed for STT
- Network accessible from the laptop (LAN or Cloudflare tunnel)

## Step-by-Step Deployment

### 1. Prepare the Config

Copy `config.yaml` and customize for the target agent + laptop:

```bash
cp config.yaml config-<agent>.yaml
```

Edit the config:

```yaml
profile:
  agent_name: "<Agent Name>"      # e.g., "R2"
  app_name: "<App Display Name>"  # e.g., "R2 Voice"
  icon_dir: "<icon-dir>"          # e.g., "r2-icons" (relative to voice-client/)

daemon:
  host: "<daemon-ip-or-hostname>" # e.g., "192.168.12.244"
  port: 3847
  tunnel_url: "<tunnel-url>"      # e.g., "https://r2.bmobot.ai" (optional fallback)

client:
  id: "<laptop-id>"               # e.g., "chrissy-mba"
  callback_port: 3849

wake_word:
  model: "<wake-word-model>"      # Path to custom .onnx or pre-trained name
  threshold: 0.5
```

### 2. Create Custom Icons (Optional)

If the agent needs unique icons, create a script like `create_<agent>_icons.py` that generates 4 PNGs:
- `icon_idle.png` — outline/template icon (36x36 @2x retina)
- `icon_active.png` — colored, listening state
- `icon_processing.png` — colored, processing state
- `icon_speaking.png` — colored, speaking state

Place them in a subdirectory (e.g., `r2-icons/`) and reference in config: `icon_dir: "r2-icons"`.

If no custom icons, leave `icon_dir: ""` to use the default BMO icons.

### 3. Transfer Files to Target Laptop

**Option A: SSH/SCP** (preferred)

```bash
# From the agent's machine:
ssh <user>@<laptop-ip> "mkdir -p ~/voice-client"
scp -r voice-client/{bmo_menubar.py,bmo_voice.py,voice_client.py,install.sh,build-app.sh,requirements.txt,sounds/} <user>@<laptop-ip>:~/voice-client/
scp voice-client/config-<agent>.yaml <user>@<laptop-ip>:~/voice-client/config.yaml

# If custom icons:
scp -r voice-client/<icon-dir>/ <user>@<laptop-ip>:~/voice-client/<icon-dir>/

# If custom wake word model:
scp voice-client/<wake-word>.onnx <user>@<laptop-ip>:~/voice-client/
```

**Option B: Agent-comms + base64** (when SSH is unavailable)

Base64-encode each file and send via agent-comms. The receiving agent decodes and writes to disk:

```bash
# Sender:
base64 < voice-client/bmo_voice.py | tr -d '\n'
# Send via agent-comms, receiver decodes:
echo '<base64>' | base64 -d > ~/voice-client/bmo_voice.py
```

This is slow for many files — prefer SSH when possible.

### 4. Install on Target Laptop

SSH into the target laptop (or have the peer agent run these):

```bash
cd ~/voice-client
chmod +x install.sh build-app.sh
./install.sh        # Creates venv, installs dependencies, downloads wake word models
./build-app.sh      # Builds the .app bundle in dist/
```

### 5. Install the App

```bash
cp -r dist/"<App Name>.app" /Applications/
```

### 6. First Launch

1. Open the app from `/Applications/` (or Spotlight)
2. macOS will prompt for **microphone permission** — grant it
3. The menu bar icon appears (idle state)
4. Test with the wake word or push-to-talk key

### 7. Auto-Start (Login Item)

**Option A: System Settings UI**
- System Settings → General → Login Items → Add the app

**Option B: launchd plist** (for agents to do it programmatically)

Create `~/Library/LaunchAgents/com.cc4me.voice-client.<agent>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cc4me.voice-client.<agent></string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/<App Name>.app/Contents/MacOS/<ExecName></string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
```

Load it:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cc4me.voice-client.<agent>.plist
```

## Wake Word Training

Custom wake words require training on Google Colab with a GPU runtime.

### Training Notebook

Use the openWakeWord training notebook: [Google Colab Link](https://colab.research.google.com/drive/1q1oe2zOyZp7UsB3jJiQ1IFn8z5YfjwEb)

### Tips

- Short/unusual wake phrases (like "R2") are harder to train than natural words ("hey BMO")
- Target metrics: Accuracy > 80%, Recall > 50%, FP/hr < 2.0
- Training sequence: 10K steps (main) + 1K steps (fine-tune) + 1K steps (fine-tune)
- Accept "Restart session" after pip installs (numpy binary compatibility)
- If `piper-sample-generator/` is cached, pip installs get skipped → NameError. Fix: `rm -rf piper-sample-generator/`

### Deploying the Model

After training, download the `.onnx` file and place it in the voice-client directory. Update config:

```yaml
wake_word:
  model: "/path/to/hey_<agent>.onnx"  # Absolute path or relative to voice-client/
  threshold: 0.5                       # May need tuning (0.3-0.7)
```

## Daemon-Side Setup

The daemon needs these components for voice to work:

### TTS Worker

The TTS worker (`daemon/src/voice/tts-worker.py`) must be the multi-engine version supporting:
- `--engine kokoro` (fast, recommended)
- `--engine qwen3-tts-mlx` (slower, higher quality fallback)

**Kokoro setup**:
1. Models in `models/`: `kokoro-v1.0.onnx` (310MB) + `voices-v1.0.bin` (27MB)
2. Python venv: `pip install kokoro-onnx` in `daemon/src/voice/.venv/`
3. Config: `voice.tts.engine: kokoro` in cc4me.config.yaml

### STT (whisper-cli)

```bash
brew install whisper-cpp
# Model should be at models/ggml-small.en.bin
```

### Voice Config (cc4me.config.yaml)

```yaml
channels:
  voice:
    enabled: true
    tts:
      engine: kokoro
      voice: am_adam        # Kokoro voice (54 available)
    stt:
      model: models/ggml-small.en.bin
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| App doesn't appear in menu bar | Check `~/Library/Logs/<AppName>.log` for errors |
| Microphone not working | System Settings → Privacy → Microphone → ensure app is allowed |
| Can't reach daemon | Verify daemon IP/hostname from laptop: `curl http://<host>:3847/health` |
| Wake word not detecting | Lower threshold (try 0.3), check mic input level |
| TTS not working | Check TTS worker: `curl http://localhost:3848/health` on daemon machine |
| `.app` won't open from SSH | Expected — LSUIElement apps need GUI context. Open from Finder/Spotlight |
| Push-to-talk not working | System Settings → Privacy → Accessibility → grant permission to the app |

## File Inventory

Files needed on the target laptop:

| File | Purpose |
|------|---------|
| `bmo_menubar.py` | Menu bar app (rumps wrapper) |
| `bmo_voice.py` | Core voice client (wake word, recording, daemon communication) |
| `voice_client.py` | Standalone CLI voice client (alternative to menu bar) |
| `config.yaml` | Agent-specific configuration |
| `install.sh` | Dependency installer |
| `build-app.sh` | .app bundle builder |
| `requirements.txt` | Python dependencies |
| `sounds/` | Audio feedback (chime.wav, listening.wav, error.wav) |
| `<icon-dir>/` | Custom menu bar icons (optional) |
| `<wake-word>.onnx` | Custom wake word model (optional) |
