#!/usr/bin/env python3
"""
CC4Me Voice Client — runs on a client device, listens for a configured wake word,
captures speech, sends to the daemon, plays audio response.

Architecture:
  - openWakeWord listens continuously for wake word (~1% CPU)
  - On detection: play feedback sound, record until silence
  - POST audio to daemon /voice/transcribe
  - Play returned TTS audio through speakers
  - Heartbeat keeps registration alive with daemon
"""

from __future__ import annotations

import io
import json
import logging
import os
import signal
import struct
import sys
import threading
import time
import wave
from enum import Enum
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

import numpy as np
import requests
import sounddevice as sd
import yaml

# Push-to-talk: prefer Quartz CGEventTap (macOS-native, thread-safe on Sequoia)
# Falls back to pynput if Quartz unavailable (non-macOS)
QUARTZ_AVAILABLE = False
PYNPUT_AVAILABLE = False
try:
    import Quartz
    QUARTZ_AVAILABLE = True
except ImportError:
    try:
        from pynput import keyboard
        PYNPUT_AVAILABLE = True
    except ImportError:
        pass

logging.basicConfig(
    level=logging.INFO,
    format="[cc4me-voice] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("cc4me-voice")

# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------

class State(Enum):
    IDLE = "idle"               # Listening for wake word only
    LISTENING = "listening"     # Recording user speech
    PROCESSING = "processing"   # Waiting for daemon response
    SPEAKING = "speaking"       # Playing TTS audio

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config(path: str = None) -> dict:
    """Load config from YAML file."""
    if path is None:
        path = os.path.join(os.path.dirname(__file__), "config.yaml")
    with open(path) as f:
        return yaml.safe_load(f)

# ---------------------------------------------------------------------------
# Audio feedback sounds
# ---------------------------------------------------------------------------

def generate_tone(freq: float, duration: float, sample_rate: int = 24000,
                  volume: float = 0.3) -> np.ndarray:
    """Generate a simple sine wave tone."""
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    # Apply fade in/out to avoid clicks
    tone = np.sin(2 * np.pi * freq * t) * volume
    fade_len = min(int(sample_rate * 0.01), len(tone) // 4)
    if fade_len > 0:
        tone[:fade_len] *= np.linspace(0, 1, fade_len)
        tone[-fade_len:] *= np.linspace(1, 0, fade_len)
    return tone.astype(np.float32)


def play_listening_sound(volume: float = 1.0):
    """Play a short 'listening' chime — two ascending tones."""
    sr = 24000
    t1 = generate_tone(880, 0.08, sr, 0.25 * volume)
    gap = np.zeros(int(sr * 0.03), dtype=np.float32)
    t2 = generate_tone(1320, 0.10, sr, 0.25 * volume)
    audio = np.concatenate([t1, gap, t2])
    sd.play(audio, sr)
    sd.wait()


def play_error_sound(volume: float = 1.0):
    """Play a low error buzz."""
    sr = 24000
    tone = generate_tone(220, 0.2, sr, 0.2 * volume)
    sd.play(tone, sr)
    sd.wait()


def play_chime_sound(volume: float = 1.0):
    """Play a distinctive notification chime — three-note arpeggio."""
    sr = 24000
    t1 = generate_tone(660, 0.10, sr, 0.2 * volume)
    gap = np.zeros(int(sr * 0.04), dtype=np.float32)
    t2 = generate_tone(880, 0.10, sr, 0.2 * volume)
    t3 = generate_tone(1100, 0.15, sr, 0.25 * volume)
    audio = np.concatenate([t1, gap, t2, gap, t3])
    sd.play(audio, sr)
    sd.wait()


def play_sent_sound(volume: float = 1.0):
    """Play a soft 'sent' confirmation — single descending tone."""
    sr = 24000
    t1 = generate_tone(880, 0.12, sr, 0.2 * volume)
    sd.play(t1, sr)
    sd.wait()


# ---------------------------------------------------------------------------
# Confirmation/rejection phrase detection
# ---------------------------------------------------------------------------

CONFIRMATION_PHRASES = {
    "yeah", "yes", "what's up", "go ahead", "what", "hey",
    "yep", "sure", "okay", "ok", "go", "tell me", "shoot",
}
REJECTION_PHRASES = {
    "not now", "later", "no", "busy", "stop", "ignore",
    "never mind", "nevermind",
}


def classify_response(text: str) -> str:
    """Classify transcribed text as confirmed, rejected, or unknown."""
    lower = text.lower().strip()
    if not lower:
        return "timeout"
    for phrase in REJECTION_PHRASES:
        if phrase in lower:
            return "rejected"
    for phrase in CONFIRMATION_PHRASES:
        if phrase in lower:
            return "confirmed"
    # If we got speech but can't classify, treat as confirmation
    # (the user said something, probably wants to hear it)
    return "confirmed"

# ---------------------------------------------------------------------------
# Callback server — handles daemon-initiated requests (chime, play)
# ---------------------------------------------------------------------------

class CallbackHandler(BaseHTTPRequestHandler):
    """HTTP handler for daemon→client callbacks."""

    # Reference to the voice client instance (set by CallbackServer)
    voice_client: "BMOVoiceClient" = None  # type: ignore

    def log_message(self, format, *args):
        log.debug("[callback] %s", args[0] if args else format)

    def do_POST(self):
        if self.path == "/chime":
            self._handle_chime()
        elif self.path == "/play":
            self._handle_play()
        else:
            self.send_error(404)

    def _handle_chime(self):
        """Handle a chime request from the daemon."""
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json_response(400, {"status": "error", "error": "Invalid JSON"})
            return

        text = data.get("text", "")
        notif_type = data.get("type", "notification")
        log.info("Chime request: type=%s, text=%s", notif_type, text[:80])

        client = self.voice_client
        if client is None or client.state != State.IDLE:
            log.info("Client busy (state=%s), rejecting chime",
                     client.state.value if client else "none")
            self._json_response(200, {"status": "rejected", "error": "Client busy"})
            return

        # Play chime
        play_chime_sound(client.volume)

        # Listen for confirmation (5 seconds)
        result = client._listen_for_confirmation(duration=5.0)
        log.info("Chime result: %s", result)

        self._json_response(200, {"status": result})

    def _handle_play(self):
        """Handle an audio push from the daemon — play through speakers."""
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_response(400, {"error": "No audio data"})
            return

        audio_data = self.rfile.read(content_length)
        log.info("Received %d bytes of audio to play", len(audio_data))

        client = self.voice_client
        if client:
            client.state = State.SPEAKING
            try:
                client._play_audio(audio_data)
            finally:
                client.state = State.IDLE

        self._json_response(200, {"ok": True})

    def _json_response(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class CallbackServer:
    """Background HTTP server for daemon→client callbacks."""

    def __init__(self, port: int, voice_client: "BMOVoiceClient"):
        self.port = port
        CallbackHandler.voice_client = voice_client
        self._server = HTTPServer(("0.0.0.0", port), CallbackHandler)
        self._server.allow_reuse_address = True
        self._server.socket.setsockopt(
            __import__("socket").SOL_SOCKET,
            __import__("socket").SO_REUSEADDR, 1
        )
        self._thread: threading.Thread | None = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        log.info("Callback server started on port %d", self.port)

    def _run(self):
        self._server.serve_forever()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        log.info("Callback server stopped")

# ---------------------------------------------------------------------------
# Voice client
# ---------------------------------------------------------------------------

class BMOVoiceClient:
    """Main voice client — state machine driving audio pipeline."""

    @property
    def state(self):
        return self._state

    @state.setter
    def state(self, new_state):
        self._state = new_state
        if self.on_state_change:
            try:
                self.on_state_change(new_state)
            except Exception:
                pass  # Don't let callback errors break the voice pipeline

    def __init__(self, config: dict):
        self.config = config
        self._state = State.IDLE
        self.on_state_change = None  # Optional callback: fn(new_state: State)
        self._lock = threading.Lock()
        self._running = False
        self.wake_word_enabled = True  # Can be toggled at runtime from menubar
        self._heartbeat_thread: threading.Thread | None = None
        self._oww_model = None

        # Daemon connection — LAN (primary) and tunnel (fallback)
        daemon = config["daemon"]
        self.lan_url = f"http://{daemon['host']}:{daemon['port']}"
        self.tunnel_url = daemon.get("tunnel_url", "").rstrip("/")
        self.daemon_url = self.lan_url  # Start with LAN, auto-detect switches if needed
        self.is_remote = False  # True when using tunnel
        self.client_id = config["client"]["id"]
        self.callback_port = config["client"]["callback_port"]

        # Audio settings
        audio = config["audio"]
        self.sample_rate = audio["sample_rate"]
        self.channels = audio["channels"]
        self.frame_size = audio["frame_size"]
        self.silence_threshold = audio["silence_threshold"]
        self.silence_duration = audio["silence_duration"]
        self.max_recording = audio["max_recording"]

        # Wake word
        ww = config["wake_word"]
        self.ww_model_name = ww["model"]
        self.ww_threshold = ww["threshold"]
        self.ww_framework = ww["inference_framework"]
        self.ww_patience = ww.get("patience", 2)
        self.ww_vad_threshold = ww.get("vad_threshold", 0.5)
        self._ww_model_key = None  # Set after model loads

        # Playback
        self.volume = config["playback"]["volume"]

        # Conversation mode
        conv = config.get("conversation", {})
        self.follow_up_duration = conv.get("follow_up_duration", 3.0)
        self.enable_stop_interrupt = conv.get("enable_stop_interrupt", True)

        # Push-to-talk
        ptt = config.get("push_to_talk", {})
        self.ptt_enabled = ptt.get("enabled", False) and (QUARTZ_AVAILABLE or PYNPUT_AVAILABLE)
        self.ptt_key = ptt.get("key", "right_cmd")
        self._ptt_pressed = False
        self._ptt_listener = None

        # Interrupt flag (set by interrupt detector during playback)
        self._interrupted = False
        # Set when response is routed to text channel (not an error)
        self._response_routed = False

        # Heartbeat
        self.heartbeat_interval = config["heartbeat"]["interval"]

    # -- Lifecycle -----------------------------------------------------------

    def start(self):
        """Initialize and start the voice client."""
        log.info("Starting voice client")
        self._running = True

        # Load wake word model
        self._load_wake_word_model()

        # Auto-detect LAN vs tunnel
        self._detect_connection()
        log.info("Connection mode: %s (%s)",
                 "tunnel" if self.is_remote else "LAN", self.daemon_url)

        # Start callback server only on LAN (daemon can't reach us over tunnel)
        self._callback_server = None
        if not self.is_remote:
            self._callback_server = CallbackServer(self.callback_port, self)
            self._callback_server.start()
        else:
            log.info("Callback server skipped (remote mode — no inbound connections)")

        # Register with daemon
        self._register()

        # Start heartbeat
        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, daemon=True
        )
        self._heartbeat_thread.start()

        # Start push-to-talk listener if enabled
        if self.ptt_enabled:
            self._start_ptt_listener()

        # Enter main listening loop
        self._listen_loop()

    def stop(self):
        """Shut down the voice client."""
        log.info("Stopping voice client")
        self._running = False
        if self._ptt_listener:
            self._ptt_listener.stop()
        if self._callback_server:
            self._callback_server.stop()
        self._unregister()

    # -- Wake word model -----------------------------------------------------

    def _load_wake_word_model(self):
        """Load the openWakeWord model.

        If wake_word.model is empty or not set, skip initialization and operate
        in push-to-talk-only mode (self._oww_model remains None).
        """
        if not self.ww_model_name:
            log.info("Wake word disabled — push-to-talk only")
            self._oww_model = None
            return

        from openwakeword.model import Model as OWWModel
        import openwakeword

        model_path = self.ww_model_name

        # Common kwargs — vad_threshold enables Silero VAD gating so
        # non-speech sounds (keyboard clicks, taps) get filtered out
        model_kwargs = dict(
            inference_framework=self.ww_framework,
            vad_threshold=self.ww_vad_threshold,
        )

        # If it's a file path, use it directly
        if os.path.isfile(model_path):
            log.info("Loading custom wake word model: %s", model_path)
            self._oww_model = OWWModel(
                wakeword_models=[model_path],
                **model_kwargs,
            )
            self._ww_model_key = os.path.splitext(os.path.basename(model_path))[0]
        else:
            # Use pre-trained model by name
            log.info("Downloading pre-trained models (if needed)")
            openwakeword.utils.download_models()
            log.info("Loading pre-trained wake word model: %s", model_path)
            self._oww_model = OWWModel(
                wakeword_models=[model_path],
                **model_kwargs,
            )
            self._ww_model_key = model_path

        log.info("Wake word model loaded (vad_threshold=%.2f, patience=%d)",
                 self.ww_vad_threshold, self.ww_patience)

    # -- Daemon communication ------------------------------------------------

    def _detect_connection(self):
        """Auto-detect whether to use LAN or tunnel.

        Tries LAN first (fast, supports callbacks). Falls back to tunnel
        if LAN is unreachable — retries tunnel up to 3 times to handle
        cold DNS/TLS handshake delays. Called at startup and periodically
        during heartbeats so the client auto-switches when the user comes home.
        """
        # Try LAN first (responds in <10ms when reachable)
        try:
            r = requests.get(f"{self.lan_url}/health", timeout=1)
            if r.status_code == 200:
                if self.is_remote:
                    log.info("LAN connection restored — switching to local mode")
                self.daemon_url = self.lan_url
                self.is_remote = False
                return
        except requests.RequestException:
            pass

        # LAN failed — try tunnel with retries (first attempt may be slow
        # due to DNS resolution + TLS handshake on cold connection)
        if self.tunnel_url:
            for attempt in range(3):
                try:
                    r = requests.get(f"{self.tunnel_url}/health", timeout=8)
                    if r.status_code == 200:
                        if not self.is_remote:
                            log.info("LAN unreachable — switching to tunnel: %s", self.tunnel_url)
                        self.daemon_url = self.tunnel_url
                        self.is_remote = True
                        return
                except requests.RequestException as e:
                    if attempt < 2:
                        log.info("Tunnel attempt %d failed (%s), retrying...", attempt + 1, type(e).__name__)
                        time.sleep(1)

        # Neither works — keep current setting and hope it comes back
        log.warning("Cannot reach daemon via LAN or tunnel")

    def _register(self) -> bool:
        """Register with the daemon. Returns True if successful."""
        url = f"{self.daemon_url}/voice/register"
        # Only provide callback URL when on LAN (daemon can reach us directly)
        if self.is_remote:
            body = {"clientId": self.client_id, "callbackUrl": None, "remote": True}
        else:
            callback_url = f"http://{self._get_local_ip()}:{self.callback_port}"
            body = {"clientId": self.client_id, "callbackUrl": callback_url}
        try:
            r = requests.post(url, json=body, timeout=5)
            if r.status_code == 200:
                mode = "tunnel" if self.is_remote else "LAN"
                log.info("Registered with daemon at %s (%s)", self.daemon_url, mode)
                return True
            else:
                log.warning("Registration failed: %s %s", r.status_code, r.text)
                return False
        except requests.RequestException as e:
            log.warning("Cannot reach daemon: %s", e)
            return False

    def _unregister(self):
        """Unregister from the daemon."""
        url = f"{self.daemon_url}/voice/unregister"
        try:
            requests.post(url, json={"clientId": self.client_id}, timeout=5)
            log.info("Unregistered from daemon")
        except requests.RequestException:
            pass

    def _heartbeat_loop(self):
        """Send heartbeats to keep registration alive.

        Also re-checks LAN vs tunnel each cycle so the client
        auto-switches when network conditions change. Uses shorter
        interval (5s) when disconnected so recovery is fast.
        """
        while self._running:
            # Retry fast when disconnected, normal pace when connected
            interval = 5 if not hasattr(self, '_connected') or not self._connected else self.heartbeat_interval
            time.sleep(interval)
            if not self._running:
                break
            self._detect_connection()
            self._connected = self._register()

    def _get_local_ip(self) -> str:
        """Get this machine's LAN IP."""
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    # -- Push-to-talk --------------------------------------------------------

    def _start_ptt_listener(self):
        """Start the push-to-talk keyboard listener."""
        if QUARTZ_AVAILABLE:
            self._start_ptt_quartz()
        elif PYNPUT_AVAILABLE:
            self._start_ptt_pynput()
        else:
            log.warning("Push-to-talk requested but no keyboard backend available")

    def _start_ptt_quartz(self):
        """Push-to-talk via Quartz CGEventTap (thread-safe on macOS Sequoia)."""
        # Map config key names to macOS virtual key codes and modifier flags.
        # Modifier keys (cmd, ctrl, shift, alt) fire kCGEventFlagsChanged, NOT
        # kCGEventKeyDown/KeyUp. We need the flag bitmask to detect press/release.
        key_codes = {
            "right_cmd": 0x36, "left_cmd": 0x37,
            "right_alt": 0x3D, "left_alt": 0x3A,
            "right_ctrl": 0x3E, "left_ctrl": 0x3B,
            "right_shift": 0x3C, "left_shift": 0x38,
            "f18": 0x4F, "f19": 0x50, "f20": 0x5A,
        }
        # Modifier flag bits for detecting press/release via kCGEventFlagsChanged
        modifier_flags = {
            "right_cmd": Quartz.kCGEventFlagMaskCommand,
            "left_cmd": Quartz.kCGEventFlagMaskCommand,
            "right_alt": Quartz.kCGEventFlagMaskAlternate,
            "left_alt": Quartz.kCGEventFlagMaskAlternate,
            "right_ctrl": Quartz.kCGEventFlagMaskControl,
            "left_ctrl": Quartz.kCGEventFlagMaskControl,
            "right_shift": Quartz.kCGEventFlagMaskShift,
            "left_shift": Quartz.kCGEventFlagMaskShift,
        }
        target_code = key_codes.get(self.ptt_key)
        if target_code is None:
            log.warning("Unknown push-to-talk key: %s", self.ptt_key)
            return
        is_modifier = self.ptt_key in modifier_flags
        target_flag = modifier_flags.get(self.ptt_key, 0)

        def callback(_proxy, event_type, event, _refcon):
            if is_modifier and event_type == Quartz.kCGEventFlagsChanged:
                # Modifier keys: check keycode to identify WHICH modifier,
                # then check flags to determine press vs release
                keycode = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode)
                if keycode != target_code:
                    return event
                flags = Quartz.CGEventGetFlags(event)
                pressed = bool(flags & target_flag)
                if pressed and not self._ptt_pressed:
                    self._ptt_pressed = True
                    log.info("Push-to-talk: modifier pressed")
                    threading.Thread(target=self._handle_ptt, daemon=True).start()
                elif not pressed and self._ptt_pressed:
                    self._ptt_pressed = False
                    log.debug("Push-to-talk: modifier released")
            elif not is_modifier:
                # Non-modifier keys (F18, F19, etc.): use KeyDown/KeyUp
                keycode = Quartz.CGEventGetIntegerValueField(event, Quartz.kCGKeyboardEventKeycode)
                if keycode != target_code:
                    return event
                if event_type == Quartz.kCGEventKeyDown and not self._ptt_pressed:
                    self._ptt_pressed = True
                    log.info("Push-to-talk: key pressed")
                    threading.Thread(target=self._handle_ptt, daemon=True).start()
                elif event_type == Quartz.kCGEventKeyUp:
                    self._ptt_pressed = False
                    log.debug("Push-to-talk: key released")
            return event

        mask = (1 << Quartz.kCGEventKeyDown) | (1 << Quartz.kCGEventKeyUp) | (1 << Quartz.kCGEventFlagsChanged)
        tap = Quartz.CGEventTapCreate(
            Quartz.kCGSessionEventTap,
            Quartz.kCGHeadInsertEventTap,
            Quartz.kCGEventTapOptionListenOnly,
            mask, callback, None,
        )
        if tap is None:
            log.error("Push-to-talk: failed to create event tap (need Accessibility permission)")
            return

        source = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)

        def run_tap():
            # All run loop setup must happen on THIS thread — CFRunLoopGetCurrent()
            # returns the run loop for the calling thread, so the source, enable,
            # and run must all be in the same thread context.
            rl = Quartz.CFRunLoopGetCurrent()
            Quartz.CFRunLoopAddSource(rl, source, Quartz.kCFRunLoopCommonModes)
            Quartz.CGEventTapEnable(tap, True)
            Quartz.CFRunLoopRun()

        self._ptt_listener = threading.Thread(target=run_tap, daemon=True)
        self._ptt_listener.start()
        log.info("Push-to-talk enabled via Quartz (key: %s)", self.ptt_key)

    def _start_ptt_pynput(self):
        """Push-to-talk via pynput (fallback for non-macOS)."""
        key_map = {
            "right_cmd": keyboard.Key.cmd_r,
            "left_cmd": keyboard.Key.cmd_l,
            "right_alt": keyboard.Key.alt_r,
            "left_alt": keyboard.Key.alt_l,
            "right_ctrl": keyboard.Key.ctrl_r,
            "left_ctrl": keyboard.Key.ctrl_l,
            "right_shift": keyboard.Key.shift_r,
            "left_shift": keyboard.Key.shift_l,
            "f18": keyboard.Key.f18,
            "f19": keyboard.Key.f19,
            "f20": keyboard.Key.f20,
        }

        self._ptt_target_key = key_map.get(self.ptt_key)
        if not self._ptt_target_key:
            log.warning("Unknown push-to-talk key: %s", self.ptt_key)
            return

        def on_press(key):
            if key == self._ptt_target_key and not self._ptt_pressed:
                self._ptt_pressed = True
                log.info("Push-to-talk: key pressed")
                threading.Thread(target=self._handle_ptt, daemon=True).start()

        def on_release(key):
            if key == self._ptt_target_key:
                self._ptt_pressed = False
                log.debug("Push-to-talk: key released")

        self._ptt_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._ptt_listener.start()
        log.info("Push-to-talk enabled via pynput (key: %s)", self.ptt_key)

    def _handle_ptt(self):
        """Handle push-to-talk: record while key is held, then send."""
        try:
            with self._lock:
                if self.state != State.IDLE:
                    log.info("PTT ignored — not idle (state=%s)", self.state.value)
                    return
                self.state = State.LISTENING

            play_listening_sound(self.volume)

            # Record while key is held (or until silence after speech)
            audio_data = self._record_ptt()

            if audio_data is None or len(audio_data) == 0:
                log.info("PTT: no speech captured")
                with self._lock:
                    self.state = State.IDLE
                return

            # Immediate feedback — confirm recording captured
            play_sent_sound(self.volume)

            # Send to daemon (same as wake word flow)
            self.state = State.PROCESSING
            self._response_routed = False
            response_audio = self._send_to_daemon(audio_data)

            if response_audio is None:
                if not self._response_routed:
                    play_error_sound(self.volume)
                with self._lock:
                    self.state = State.IDLE
                return

            # Play response
            self.state = State.SPEAKING
            self._play_audio_with_interrupt(response_audio)

            with self._lock:
                self.state = State.IDLE
        finally:
            # Always reset PTT flag so the next press isn't ignored
            # (release events can be missed on macOS modifier keys)
            self._ptt_pressed = False

    def _record_ptt(self) -> bytes | None:
        """Record audio while push-to-talk key is held.

        Continues recording while _ptt_pressed is True, plus captures
        trailing audio after key release until silence.
        Returns None if no actual speech detected (prevents whisper
        hallucinations on silent/ambient-noise recordings).
        """
        log.info("PTT recording...")
        frames: list[np.ndarray] = []
        speech_frame_count = 0
        max_frames = int(self.max_recording * self.sample_rate / self.frame_size)

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                for i in range(max_frames):
                    if not self._running:
                        return None

                    data, _ = stream.read(self.frame_size)
                    frame = data[:, 0]
                    frames.append(frame.copy())

                    energy = np.abs(frame).mean()
                    if energy > self.silence_threshold:
                        speech_frame_count += 1

                    # While key is held, keep recording
                    if self._ptt_pressed:
                        continue

                    # Key released — stop immediately
                    log.info("PTT: key released, stopping")
                    break

        except Exception as e:
            log.error("PTT recording error: %s", e)
            return None

        if not frames:
            return None

        # Require at least ~200ms of speech to avoid whisper hallucinations
        # on silent/ambient recordings (whisper loves to hallucinate "you")
        min_speech_frames = max(3, int(0.2 * self.sample_rate / self.frame_size))
        if speech_frame_count < min_speech_frames:
            log.info("PTT: no speech detected (%d frames < %d minimum), discarding",
                     speech_frame_count, min_speech_frames)
            return None

        all_audio = np.concatenate(frames)
        log.info("PTT recorded %.1fs of audio (%d speech frames)",
                 len(all_audio) / self.sample_rate, speech_frame_count)
        return self._pcm_to_wav(all_audio)

    # -- Main listening loop -------------------------------------------------

    def _listen_loop(self):
        """Main loop: listen for wake word, record, send, play response.

        When wake word model is disabled (push-to-talk-only mode), this loop
        still runs to keep the process alive — PTT is handled by a separate
        thread started in start(). The audio stream is opened so PTT recording
        can access the device, but wake word detection frames are skipped.
        """
        if self._oww_model is None:
            log.info("Push-to-talk only mode — wake word detection disabled")
            # Keep running; PTT listener thread handles interaction
            try:
                while self._running:
                    time.sleep(0.5)
            except KeyboardInterrupt:
                log.info("Interrupted")
            finally:
                self.stop()
            return

        log.info("Listening for wake word '%s' (threshold=%.2f, patience=%d, vad=%.2f)",
                 self.ww_model_name, self.ww_threshold, self.ww_patience, self.ww_vad_threshold)

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                while self._running:
                    # Read one frame
                    audio_frame, overflowed = stream.read(self.frame_size)
                    if overflowed:
                        continue

                    # Only check wake word when idle and enabled
                    if self.state != State.IDLE or not self.wake_word_enabled:
                        continue

                    # Run wake word detection
                    frame_data = audio_frame[:, 0]  # mono
                    prediction = self._oww_model.predict(frame_data)

                    for model_name, score in prediction.items():
                        if score > self.ww_threshold:
                            # Confirmation: noise spikes drop instantly,
                            # real speech sustains across frames. Read one
                            # more frame and verify the score stays elevated.
                            confirm_frame, _ = stream.read(self.frame_size)
                            confirm_data = confirm_frame[:, 0]
                            confirm_pred = self._oww_model.predict(confirm_data)
                            confirm_score = confirm_pred.get(model_name, 0)

                            if confirm_score > self.ww_threshold * 0.3:
                                log.info("Wake word confirmed! (%s: %.3f → %.3f)",
                                         model_name, score, confirm_score)
                                self._handle_wake()
                                self._oww_model.reset()
                            else:
                                log.info("Wake word rejected (noise spike: %s: %.3f → %.3f)",
                                         model_name, score, confirm_score)
                                self._oww_model.reset()
                            break

        except KeyboardInterrupt:
            log.info("Interrupted")
        except Exception as e:
            log.error("Listen loop error: %s", e, exc_info=True)
        finally:
            self.stop()

    # -- Voice interaction flow ----------------------------------------------

    def _handle_wake(self):
        """Handle a wake word detection — record, send, play, then
        enter conversation mode for follow-up questions."""
        with self._lock:
            if self.state != State.IDLE:
                return
            self.state = State.LISTENING

        try:
            self._voice_interaction_loop(initial=True)
        except Exception as e:
            log.error("Voice interaction failed: %s", e, exc_info=True)
            play_error_sound(self.volume)
        finally:
            self.state = State.IDLE

    def _voice_interaction_loop(self, initial: bool = True):
        """Core voice loop — handles initial query and follow-up conversation.

        After each response, listens briefly for follow-up questions.
        If the user speaks within follow_up_duration, processes as new query
        without requiring the wake word again.
        """
        if initial:
            play_listening_sound(self.volume)

        # Record utterance
        self.state = State.LISTENING
        audio_data = self._record_utterance()
        if audio_data is None or len(audio_data) == 0:
            log.info("No speech detected")
            return

        # Send to daemon
        self.state = State.PROCESSING
        self._response_routed = False
        response_audio = self._send_to_daemon(audio_data)
        if response_audio is None:
            if self._response_routed:
                play_sent_sound(self.volume)
                # Still enter follow-up mode for Telegram routing
                self._do_follow_up_loop()
            else:
                play_error_sound(self.volume)
            return

        # Play response (with optional stop interrupt detection)
        self.state = State.SPEAKING
        self._play_audio_with_interrupt(response_audio)

        if self._interrupted:
            log.info("Playback was interrupted")
            self._interrupted = False
            return

        # Enter follow-up listening window (conversation mode)
        self._do_follow_up_loop()

    def _do_follow_up_loop(self):
        """Listen for follow-up utterances after a response (voice or Telegram)."""
        if self.follow_up_duration <= 0:
            return

        log.info("Listening for follow-up (%.1fs)...", self.follow_up_duration)
        follow_up_audio = self._listen_for_follow_up()
        if follow_up_audio is not None:
            log.info("Follow-up detected, continuing conversation")
            # Handle the follow-up (no wake word needed)
            self.state = State.PROCESSING
            self._response_routed = False
            response_audio = self._send_to_daemon(follow_up_audio)
            if response_audio:
                self.state = State.SPEAKING
                self._play_audio_with_interrupt(response_audio)
                # Recurse for another follow-up opportunity
                if not self._interrupted:
                    self._do_follow_up_loop()
                else:
                    self._interrupted = False
            elif self._response_routed:
                play_sent_sound(self.volume)
                # Recurse for another follow-up even after Telegram routing
                self._do_follow_up_loop()
            else:
                play_error_sound(self.volume)

    def _record_utterance(self) -> bytes | None:
        """Record audio until silence is detected. Returns WAV bytes.

        Requires sustained speech (not just noise spikes) to avoid sending
        ambient noise to whisper, which hallucinates words like 'you'.
        """
        log.info("Recording...")
        frames: list[np.ndarray] = []
        silence_count = 0
        speech_frame_count = 0
        silence_frames_needed = int(
            self.silence_duration * self.sample_rate / self.frame_size
        )
        max_frames = int(
            self.max_recording * self.sample_rate / self.frame_size
        )
        has_speech = False

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                for _ in range(max_frames):
                    if not self._running:
                        return None

                    data, overflowed = stream.read(self.frame_size)
                    frame = data[:, 0]  # mono
                    frames.append(frame.copy())

                    # Energy-based VAD
                    energy = np.abs(frame).mean()

                    if energy > self.silence_threshold:
                        has_speech = True
                        speech_frame_count += 1
                        silence_count = 0
                    else:
                        silence_count += 1

                    # End recording after enough silence (but only if we got speech)
                    if has_speech and silence_count >= silence_frames_needed:
                        log.info("Silence detected, stopping recording")
                        break

        except Exception as e:
            log.error("Recording error: %s", e)
            return None

        if not has_speech:
            return None

        # Require at least ~200ms of speech to avoid whisper hallucinations
        min_speech_frames = max(3, int(0.2 * self.sample_rate / self.frame_size))
        if speech_frame_count < min_speech_frames:
            log.info("Utterance too short (%d speech frames < %d min), discarding",
                     speech_frame_count, min_speech_frames)
            return None

        # Convert to WAV bytes
        all_audio = np.concatenate(frames)
        return self._pcm_to_wav(all_audio)

    def _pcm_to_wav(self, pcm: np.ndarray) -> bytes:
        """Convert int16 PCM array to WAV bytes."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(pcm.tobytes())
        return buf.getvalue()

    def _send_to_daemon(self, audio_data: bytes) -> bytes | None:
        """Send recorded audio to daemon and get TTS response."""
        url = f"{self.daemon_url}/voice/transcribe"
        log.info("Sending %d bytes to daemon...", len(audio_data))

        try:
            r = requests.post(
                url,
                data=audio_data,
                headers={"Content-Type": "application/octet-stream"},
                timeout=60,  # Claude might take a while to respond
            )

            if r.status_code == 200:
                content_type = r.headers.get("Content-Type", "")

                if "audio/" in content_type:
                    # Full voice pipeline — daemon returned TTS audio
                    transcription = unquote(
                        r.headers.get("X-Transcription", "")
                    )
                    response_text = unquote(
                        r.headers.get("X-Response-Text", "")
                    )
                    log.info("Transcription: %s", transcription)
                    log.info("Response: %s",
                             response_text[:100] + ("..." if len(response_text) > 100 else ""))
                    return r.content
                else:
                    # JSON response — voice input accepted, response via other channel
                    self._response_routed = True
                    try:
                        data = r.json()
                        log.info("Transcription: %s", data.get("text", ""))
                        channel = data.get("responseChannel", "unknown")
                        log.info("Response routed to %s (no audio)", channel)
                    except Exception:
                        log.info("Non-audio response from daemon")
                    return None
            else:
                try:
                    err = r.json()
                    log.warning("Daemon error: %s", err.get("error", r.text))
                except Exception:
                    log.warning("Daemon returned %d: %s", r.status_code, r.text[:200])
                return None

        except requests.Timeout:
            log.warning("Request timed out (60s)")
            return None
        except requests.RequestException as e:
            log.warning("Request failed: %s", e)
            return None

    def _listen_for_follow_up(self) -> bytes | None:
        """Listen briefly for a follow-up utterance after playback.

        Returns WAV bytes if speech detected, None if silence.
        """
        frames: list[np.ndarray] = []
        has_speech = False
        silence_count = 0
        # Use shorter silence timeout for follow-up
        silence_needed = int(self.silence_duration * self.sample_rate / self.frame_size)
        max_frames = int(
            (self.follow_up_duration + self.max_recording) *
            self.sample_rate / self.frame_size
        )
        # Wait at most follow_up_duration for speech to start
        start_wait_frames = int(
            self.follow_up_duration * self.sample_rate / self.frame_size
        )
        waited = 0

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                for i in range(max_frames):
                    if not self._running:
                        return None

                    data, _ = stream.read(self.frame_size)
                    frame = data[:, 0]

                    energy = np.abs(frame).mean()

                    if not has_speech:
                        waited += 1
                        if energy > self.silence_threshold:
                            log.info("Follow-up: speech detected (energy=%d > threshold=%d)",
                                     int(energy), self.silence_threshold)
                            has_speech = True
                            frames.append(frame.copy())
                            silence_count = 0
                        elif waited >= start_wait_frames:
                            # No speech within follow-up window
                            log.debug("Follow-up: no speech detected in window")
                            return None
                    else:
                        frames.append(frame.copy())
                        if energy > self.silence_threshold:
                            silence_count = 0
                        else:
                            silence_count += 1
                        if silence_count >= silence_needed:
                            break

        except Exception as e:
            log.error("Follow-up listen error: %s", e)
            return None

        if not has_speech or not frames:
            return None

        all_audio = np.concatenate(frames)
        return self._pcm_to_wav(all_audio)

    def _play_audio_with_interrupt(self, wav_data: bytes):
        """Play WAV audio with optional stop-interrupt detection.

        If enable_stop_interrupt is True, listens for 'stop' / '{agent name} stop'
        in a background thread during playback and halts if detected.
        """
        self._interrupted = False

        if not self.enable_stop_interrupt:
            self._play_audio(wav_data)
            return

        # Start interrupt detector in background
        stop_event = threading.Event()
        detector_thread = threading.Thread(
            target=self._interrupt_detector,
            args=(stop_event,),
            daemon=True,
        )
        detector_thread.start()

        try:
            self._play_audio(wav_data)
        finally:
            stop_event.set()  # Signal detector to stop
            detector_thread.join(timeout=1.0)

    def _interrupt_detector(self, stop_event: threading.Event):
        """Background thread that listens for 'stop' command during playback.

        Monitors audio energy on a separate InputStream. If speech is detected
        during playback, stops playback immediately. Full STT classification
        would add latency; we use energy detection as the trigger and treat
        any speech during playback as an interrupt.
        """
        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                speech_frames = 0
                while not stop_event.is_set():
                    data, _ = stream.read(self.frame_size)
                    frame = data[:, 0]
                    energy = np.abs(frame).mean()

                    # Need sustained speech (not just a blip from the speakers)
                    if energy > self.silence_threshold * 2:
                        speech_frames += 1
                        if speech_frames >= 3:  # ~240ms of speech
                            log.info("Interrupt detected during playback")
                            self._interrupted = True
                            sd.stop()  # Stop playback
                            return
                    else:
                        speech_frames = 0

        except Exception as e:
            log.debug("Interrupt detector error: %s", e)

    def _play_audio(self, wav_data: bytes):
        """Play WAV audio through speakers."""
        try:
            buf = io.BytesIO(wav_data)
            with wave.open(buf, "rb") as wf:
                sr = wf.getframerate()
                channels = wf.getnchannels()
                sampwidth = wf.getsampwidth()
                frames = wf.readframes(wf.getnframes())

            # Convert to float32 for playback
            if sampwidth == 2:
                audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32767.0
            elif sampwidth == 4:
                audio = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483647.0
            else:
                log.warning("Unsupported sample width: %d", sampwidth)
                return

            # Apply volume
            audio *= self.volume

            # Reshape for multi-channel
            if channels > 1:
                audio = audio.reshape(-1, channels)

            log.info("Playing response audio (%.1fs)", len(audio) / sr)
            sd.play(audio, sr)
            sd.wait()
            log.info("Playback complete")

        except Exception as e:
            log.error("Playback error: %s", e, exc_info=True)

    # -- Chime confirmation --------------------------------------------------

    def _listen_for_confirmation(self, duration: float = 5.0) -> str:
        """Listen for a short voice response after a chime.

        Records for up to `duration` seconds, sends to daemon /voice/speak
        for STT-only classification, and returns 'confirmed', 'rejected',
        or 'timeout'.
        """
        log.info("Listening for confirmation (%.1fs)...", duration)
        frames: list[np.ndarray] = []
        has_speech = False
        silence_count = 0
        silence_needed = int(0.8 * self.sample_rate / self.frame_size)  # 0.8s silence ends
        max_frames = int(duration * self.sample_rate / self.frame_size)

        try:
            with sd.InputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                dtype="int16",
                blocksize=self.frame_size,
            ) as stream:
                for _ in range(max_frames):
                    data, _ = stream.read(self.frame_size)
                    frame = data[:, 0]
                    frames.append(frame.copy())

                    energy = np.abs(frame).mean()
                    if energy > self.silence_threshold:
                        has_speech = True
                        silence_count = 0
                    else:
                        silence_count += 1

                    if has_speech and silence_count >= silence_needed:
                        break

        except Exception as e:
            log.error("Confirmation listen error: %s", e)
            return "timeout"

        if not has_speech:
            log.info("No speech during confirmation window")
            return "timeout"

        # Send audio to daemon for STT-only transcription, then classify
        all_audio = np.concatenate(frames)
        wav_bytes = self._pcm_to_wav(all_audio)

        try:
            url = f"{self.daemon_url}/voice/stt"
            r = requests.post(
                url,
                data=wav_bytes,
                headers={"Content-Type": "application/octet-stream"},
                timeout=10,
            )

            if r.status_code == 200:
                data = r.json()
                text = data.get("text", "")
                result = classify_response(text)
                log.info("Confirmation STT: '%s' → %s", text, result)
                return result
            else:
                # STT failed — fallback: speech detected = confirmed
                log.warning("STT failed (%d), defaulting to confirmed", r.status_code)
                return "confirmed"

        except Exception as e:
            log.warning("STT request failed: %s — defaulting to confirmed", e)
            return "confirmed"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    config_path = None
    state_output = False

    args = sys.argv[1:]
    if "--state-output" in args:
        state_output = True
        args.remove("--state-output")
    if args:
        config_path = args[0]

    if state_output:
        # Redirect logging to stderr so stdout stays clean for state lines
        logging.basicConfig(
            level=logging.INFO,
            format="[cc4me-voice] %(asctime)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
            handlers=[logging.StreamHandler(sys.stderr)],
            force=True,
        )

    config = load_config(config_path)
    client = BMOVoiceClient(config)

    if state_output:
        def emit_state(new_state):
            print(f"STATE:{new_state.value}", flush=True)
        client.on_state_change = emit_state

    def on_signal(signum, frame):
        log.info("Received signal %d, shutting down", signum)
        client.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    client.start()


if __name__ == "__main__":
    main()
