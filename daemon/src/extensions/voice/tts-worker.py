#!/usr/bin/env python3.12
"""
TTS Worker — persistent HTTP microservice for text-to-speech.

Supports multiple engines:
  - kokoro: Kokoro-82M via ONNX (fast, ~0.6-1s for typical text)
  - qwen3-tts-mlx: Qwen3-TTS via MLX (slower, higher quality for long text)

Loads the model once on startup and serves synthesis requests with low latency.
Runs on a configurable localhost port (default 3848).

Endpoints:
  POST /synthesize  — {text: str, voice?: str} → WAV audio
  GET  /health      — {status: "ok", engine: str, uptime: float}

Usage:
  python3 tts-worker.py --engine kokoro [--port 3848]
  python3 tts-worker.py --engine qwen3-tts-mlx --model <hf-model-id> [--port 3848]
"""

import argparse
import io
import json
import os
import struct
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

model_instance = None
engine_name = ""
start_time = 0.0

DEFAULT_PORT = 3848
SAMPLE_RATE = 24000  # Both engines output 24kHz


def numpy_to_wav(audio_np, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Convert a numpy float32 array to WAV bytes."""
    import numpy as np

    audio_np = np.asarray(audio_np, dtype=np.float32)

    # Normalize to [-1, 1] if needed
    max_val = np.abs(audio_np).max()
    if max_val > 1.0:
        audio_np = audio_np / max_val

    # Convert to 16-bit PCM
    pcm = (audio_np * 32767).astype(np.int16)

    # Build WAV file
    buf = io.BytesIO()
    num_samples = len(pcm)
    data_size = num_samples * 2  # 16-bit = 2 bytes per sample

    # RIFF header
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")

    # fmt chunk
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))       # chunk size
    buf.write(struct.pack("<H", 1))        # PCM format
    buf.write(struct.pack("<H", 1))        # mono
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))  # byte rate
    buf.write(struct.pack("<H", 2))        # block align
    buf.write(struct.pack("<H", 16))       # bits per sample

    # data chunk
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(pcm.tobytes())

    return buf.getvalue()


# ── Engine: Kokoro ─────────────────────────────────────────────

class KokoroEngine:
    """Kokoro-82M via ONNX — fast, 54 voices, 24kHz output."""

    DEFAULT_VOICE = "am_adam"

    def __init__(self, models_dir: str):
        from kokoro_onnx import Kokoro

        model_path = os.path.join(models_dir, "kokoro-v1.0.onnx")
        voices_path = os.path.join(models_dir, "voices-v1.0.bin")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Kokoro model not found: {model_path}")
        if not os.path.exists(voices_path):
            raise FileNotFoundError(f"Kokoro voices not found: {voices_path}")

        self.kokoro = Kokoro(model_path, voices_path)
        self.voices = set(self.kokoro.get_voices())

    def synthesize(self, text: str, voice: str = "", **kwargs) -> bytes:
        voice = voice or self.DEFAULT_VOICE
        if voice not in self.voices:
            # Fuzzy match: try lowercase, try prefix match
            lower = voice.lower()
            match = next((v for v in self.voices if v == lower), None)
            if not match:
                match = next((v for v in self.voices if v.startswith(lower[:3])), None)
            voice = match or self.DEFAULT_VOICE

        samples, sr = self.kokoro.create(text, voice=voice, speed=kwargs.get("speed", 1.0))
        return numpy_to_wav(samples, sr)

    @property
    def name(self) -> str:
        return "kokoro-v1.0"


# ── Engine: Qwen3-TTS ─────────────────────────────────────────

class Qwen3TTSEngine:
    """Qwen3-TTS via MLX — higher quality, slower."""

    DEFAULT_VOICE = "Aiden"
    DEFAULT_LANGUAGE = "English"

    def __init__(self, model_id: str):
        from mlx_audio.tts.utils import load_model
        self.model = load_model(model_id)
        self.model_id = model_id

    def synthesize(self, text: str, voice: str = "", **kwargs) -> bytes:
        voice = voice or self.DEFAULT_VOICE
        language = kwargs.get("language", self.DEFAULT_LANGUAGE)
        instruct = kwargs.get("instruct", "A clear, friendly voice.")

        results = list(self.model.generate_custom_voice(
            text=text,
            speaker=voice,
            language=language,
            instruct=instruct,
        ))

        if not results or results[0].audio is None:
            raise RuntimeError("Model returned no audio")

        return numpy_to_wav(results[0].audio)

    @property
    def name(self) -> str:
        return self.model_id


# ── HTTP Server ────────────────────────────────────────────────

class TTSServer(HTTPServer):
    """HTTPServer that skips getfqdn() in server_bind.

    Python's HTTPServer.server_bind() calls socket.getfqdn() which does
    a DNS reverse lookup. On macOS this can block for 30+ seconds when
    DNS is slow or misconfigured. Since we only listen on localhost,
    we skip it entirely.
    """

    def server_bind(self):
        import socketserver
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class TTSHandler(BaseHTTPRequestHandler):
    """HTTP handler for TTS requests."""

    def log_message(self, format, *args):
        """Override to use stderr with timestamp."""
        sys.stderr.write(f"[tts-worker] {args[0]}\n")

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({
                "status": "ok",
                "engine": engine_name,
                "model": model_instance.name if model_instance else "none",
                "uptime": round(time.time() - start_time, 1),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_error(404)

    def do_POST(self):
        if self.path == "/synthesize":
            self._handle_synthesize()
            return

        self.send_error(404)

    def _handle_synthesize(self):
        global model_instance

        # Read body
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._json_error(400, "Empty request body")
            return

        raw = self.rfile.read(content_length)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._json_error(400, "Invalid JSON")
            return

        text = data.get("text", "").strip()
        if not text:
            self._json_error(400, "'text' is required and must be non-empty")
            return

        voice = data.get("voice", "")
        kwargs = {}
        for key in ("language", "instruct", "speed"):
            if key in data:
                kwargs[key] = data[key]

        try:
            t0 = time.time()
            wav_bytes = model_instance.synthesize(text, voice=voice, **kwargs)
            elapsed = round((time.time() - t0) * 1000)

            sys.stderr.write(
                f"[tts-worker] synthesized {len(text)} chars in {elapsed}ms "
                f"({len(wav_bytes)} bytes)\n"
            )

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_bytes)))
            self.send_header("X-Synthesis-Time-Ms", str(elapsed))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            sys.stderr.write(f"[tts-worker] synthesis error: {e}\n")
            self._json_error(500, f"Synthesis failed: {str(e)}")

    def _json_error(self, code: int, message: str):
        body = json.dumps({"error": message}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    global model_instance, engine_name, start_time

    parser = argparse.ArgumentParser(description="TTS Worker — multi-engine speech synthesis")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
    parser.add_argument("--engine", default="kokoro", choices=["kokoro", "qwen3-tts-mlx"],
                        help="TTS engine to use")
    parser.add_argument("--model", default="", help="Model ID (for qwen3-tts-mlx engine)")
    parser.add_argument("--models-dir", default="", help="Directory containing model files")
    args = parser.parse_args()

    engine_name = args.engine
    start_time = time.time()

    sys.stderr.write(f"[tts-worker] starting engine: {engine_name}\n")
    sys.stderr.flush()

    if engine_name == "kokoro":
        models_dir = args.models_dir or os.path.join(os.path.dirname(__file__), "..", "..", "..", "models")
        models_dir = os.path.abspath(models_dir)
        model_instance = KokoroEngine(models_dir)
    elif engine_name == "qwen3-tts-mlx":
        model_id = args.model or "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16"
        model_instance = Qwen3TTSEngine(model_id)
    else:
        sys.stderr.write(f"[tts-worker] unknown engine: {engine_name}\n")
        sys.exit(1)

    load_time = round(time.time() - start_time, 1)
    sys.stderr.write(f"[tts-worker] {engine_name} loaded in {load_time}s\n")
    sys.stderr.write(f"[tts-worker] listening on 127.0.0.1:{args.port}\n")
    sys.stderr.flush()

    # Signal readiness via stdout (daemon watches for this)
    print(f"READY port={args.port}", flush=True)

    server = TTSServer(("127.0.0.1", args.port), TTSHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("[tts-worker] shutting down\n")
        server.shutdown()


if __name__ == "__main__":
    main()
