#!/usr/bin/env python3
"""
Marvbot Voice Client — macOS menu bar push-to-talk app.

Hold Right Cmd to speak. Audio is sent to the daemon for transcription (STT),
the response is synthesized (TTS), and played back through speakers.

Status icon in the menu bar shows current state:
  🎤 Idle (ready)
  🔴 Recording
  ⏳ Processing
  🔊 Speaking
"""

import io
import json
import os
import socket
import struct
import sys
import threading
import time
import wave

import numpy as np
import requests
import rumps
import sounddevice as sd
import yaml
from http.server import HTTPServer, BaseHTTPRequestHandler
from pynput import keyboard

# ── Config ────────────────────────────────────────────────────

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")

with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)

DAEMON_URL = CONFIG.get("daemon_url", "http://localhost:3847")
CLIENT_ID = CONFIG.get("client_id", "voice-client-1")
CLIENT_PORT = CONFIG.get("client_port", 7331)

SAMPLE_RATE = CONFIG.get("audio", {}).get("sample_rate", 16000)
CHANNELS = CONFIG.get("audio", {}).get("channels", 1)
CHUNK_SIZE = CONFIG.get("audio", {}).get("chunk_size", 1024)
SILENCE_THRESHOLD = CONFIG.get("audio", {}).get("silence_threshold", 0.01)
SILENCE_TIMEOUT = CONFIG.get("audio", {}).get("silence_timeout", 1.5)

PTT_KEY = CONFIG.get("ptt", {}).get("key", "right_cmd")

# Map config key names to pynput Key objects
PTT_KEY_MAP = {
    "right_cmd": keyboard.Key.cmd_r,
    "right_ctrl": keyboard.Key.ctrl_r,
    "right_shift": keyboard.Key.shift_r,
    "right_alt": keyboard.Key.alt_r,
    "f13": keyboard.KeyCode.from_vk(105),
}

# ── State ─────────────────────────────────────────────────────

class State:
    IDLE = "idle"
    RECORDING = "recording"
    PROCESSING = "processing"
    SPEAKING = "speaking"

state = State.IDLE
state_lock = threading.Lock()
app_ref = None  # Set when rumps app starts


def set_state(new_state):
    global state
    with state_lock:
        state = new_state
    icons = {
        State.IDLE: "🎤",
        State.RECORDING: "🔴",
        State.PROCESSING: "⏳",
        State.SPEAKING: "🔊",
    }
    if app_ref:
        app_ref.title = icons.get(new_state, "🎤")


# ── Daemon Communication ──────────────────────────────────────

def get_local_ip():
    """Get LAN IP for daemon callbacks."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def register_with_daemon():
    """Register this client with the daemon."""
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


def unregister_from_daemon():
    """Unregister this client on shutdown."""
    try:
        requests.post(
            f"{DAEMON_URL}/voice/unregister",
            json={"clientId": CLIENT_ID},
            timeout=5,
        )
    except Exception:
        pass


def start_heartbeat(interval=30):
    """Re-register periodically — daemon marks clients stale after 60s."""
    def loop():
        while True:
            time.sleep(interval)
            register_with_daemon()
    t = threading.Thread(target=loop, daemon=True)
    t.start()


# ── Audio Recording ───────────────────────────────────────────

def record_until_silence(max_seconds=30):
    """Record audio from mic until silence detected. Returns WAV bytes."""
    frames = []
    silence_frames = 0
    silence_limit = int(SAMPLE_RATE / CHUNK_SIZE * SILENCE_TIMEOUT)
    recording = True

    def callback(indata, frame_count, time_info, status):
        nonlocal silence_frames
        if not recording:
            return
        frames.append(indata.copy())
        rms = float(np.sqrt(np.mean(indata ** 2)))
        if rms < SILENCE_THRESHOLD:
            silence_frames += 1
        else:
            silence_frames = 0

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="float32",
        blocksize=CHUNK_SIZE,
        callback=callback,
    )
    stream.start()

    max_frames = int(SAMPLE_RATE / CHUNK_SIZE * max_seconds)
    while len(frames) < max_frames:
        if silence_frames >= silence_limit and len(frames) > 5:
            break
        # Check if PTT key was released (for PTT mode)
        if not ptt_held:
            break
        sd.sleep(50)

    recording = False
    stream.stop()
    stream.close()

    if not frames:
        return None

    audio = np.concatenate(frames, axis=0)
    pcm = (audio * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def record_while_held(max_seconds=30):
    """Record audio while PTT key is held. Returns WAV bytes."""
    frames = []

    def callback(indata, frame_count, time_info, status):
        frames.append(indata.copy())

    stream = sd.InputStream(
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="float32",
        blocksize=CHUNK_SIZE,
        callback=callback,
    )
    stream.start()

    max_frames = int(SAMPLE_RATE / CHUNK_SIZE * max_seconds)
    while ptt_held and len(frames) < max_frames:
        sd.sleep(50)

    stream.stop()
    stream.close()

    if not frames:
        return None

    audio = np.concatenate(frames, axis=0)
    pcm = (audio * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


# ── Audio Playback ────────────────────────────────────────────

def play_audio(wav_bytes):
    """Play WAV audio through the default output device."""
    if not wav_bytes:
        return
    buf = io.BytesIO(wav_bytes)
    try:
        with wave.open(buf, "rb") as wf:
            rate = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
    except Exception as e:
        print(f"[voice-client] failed to parse WAV: {e}")
        return

    if sampwidth == 2:
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767
    elif sampwidth == 4:
        samples = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483647
    else:
        print(f"[voice-client] unsupported sample width: {sampwidth}")
        return

    if nchannels > 1:
        samples = samples.reshape(-1, nchannels)

    sd.play(samples, samplerate=rate, blocking=True)


# ── Voice Pipeline ────────────────────────────────────────────

def send_to_daemon(wav_bytes):
    """POST audio to /voice/transcribe. Returns dict with audio and text."""
    try:
        resp = requests.post(
            f"{DAEMON_URL}/voice/transcribe",
            data=wav_bytes,
            headers={"Content-Type": "audio/wav"},
            timeout=60,
        )
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")
        if "audio" in content_type:
            return {
                "audio": resp.content,
                "transcription": resp.headers.get("X-Transcription", ""),
                "response_text": resp.headers.get("X-Response-Text", ""),
            }
        else:
            # JSON response (transcription only, no TTS)
            data = resp.json()
            return {
                "audio": None,
                "transcription": data.get("transcription", ""),
                "response_text": data.get("response", ""),
            }
    except Exception as e:
        print(f"[voice-client] daemon error: {e}")
        return None


def voice_pipeline():
    """Full round-trip: record → daemon → play response."""
    if state != State.IDLE:
        return

    set_state(State.RECORDING)
    print("[voice-client] recording...")

    wav = record_while_held()
    if not wav or len(wav) < 1000:
        print("[voice-client] recording too short, discarding")
        set_state(State.IDLE)
        return

    set_state(State.PROCESSING)
    print("[voice-client] processing...")

    result = send_to_daemon(wav)
    if not result:
        set_state(State.IDLE)
        return

    if result.get("transcription"):
        print(f"[voice-client] transcribed: {result['transcription']}")
    if result.get("response_text"):
        print(f"[voice-client] response: {result['response_text'][:100]}...")

    if result.get("audio"):
        set_state(State.SPEAKING)
        print("[voice-client] playing response...")
        play_audio(result["audio"])

    set_state(State.IDLE)


# ── Push-to-Talk Keyboard Listener ───────────────────────────

ptt_held = False
ptt_target = PTT_KEY_MAP.get(PTT_KEY, keyboard.Key.cmd_r)


def on_press(key):
    global ptt_held
    if key == ptt_target and not ptt_held:
        ptt_held = True
        threading.Thread(target=voice_pipeline, daemon=True).start()


def on_release(key):
    global ptt_held
    if key == ptt_target:
        ptt_held = False


def start_keyboard_listener():
    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.daemon = True
    listener.start()


# ── Callback Server (for daemon-initiated chimes) ────────────

class ChimeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))

        if self.path == "/chime":
            body = json.loads(self.rfile.read(length)) if length else {}
            text = body.get("text", "")
            chime_type = body.get("type", "info")

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "confirmed"}).encode())

            # Play TTS of the chime text
            if text:
                try:
                    resp = requests.post(
                        f"{DAEMON_URL}/voice/speak",
                        json={"text": text},
                        timeout=30,
                    )
                    if resp.ok and "audio" in resp.headers.get("Content-Type", ""):
                        play_audio(resp.content)
                except Exception as e:
                    print(f"[voice-client] chime TTS error: {e}")

        elif self.path == "/play":
            wav_data = self.rfile.read(length)
            self.send_response(200)
            self.end_headers()
            if wav_data:
                threading.Thread(
                    target=play_audio, args=(wav_data,), daemon=True
                ).start()

        else:
            self.send_response(404)
            self.end_headers()


def start_callback_server():
    server = HTTPServer(("0.0.0.0", CLIENT_PORT), ChimeHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"[voice-client] callback server on port {CLIENT_PORT}")


# ── Menu Bar App ──────────────────────────────────────────────

class VoiceClientApp(rumps.App):
    def __init__(self):
        super().__init__("🎤", quit_button=None)
        self.menu = [
            rumps.MenuItem("Status: Idle", callback=None),
            None,  # separator
            rumps.MenuItem("Push-to-Talk: Right ⌘", callback=None),
            None,
            rumps.MenuItem("Quit", callback=self.quit_app),
        ]

    @rumps.timer(2)
    def update_status(self, _):
        status_item = self.menu["Status: Idle"]
        labels = {
            State.IDLE: "Status: Idle",
            State.RECORDING: "Status: Recording...",
            State.PROCESSING: "Status: Processing...",
            State.SPEAKING: "Status: Speaking...",
        }
        new_label = labels.get(state, "Status: Idle")
        if status_item.title != new_label:
            status_item.title = new_label

    def quit_app(self, _):
        unregister_from_daemon()
        rumps.quit_application()


# ── Main ──────────────────────────────────────────────────────

def main():
    global app_ref

    print("[voice-client] starting...")
    print(f"[voice-client] daemon: {DAEMON_URL}")
    print(f"[voice-client] PTT key: {PTT_KEY}")

    # Register with daemon
    register_with_daemon()
    start_heartbeat()

    # Start callback server for daemon-initiated interactions
    start_callback_server()

    # Start keyboard listener
    start_keyboard_listener()

    # Start menu bar app (blocks)
    app = VoiceClientApp()
    app_ref = app
    set_state(State.IDLE)
    app.run()


if __name__ == "__main__":
    main()
