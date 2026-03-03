#!/usr/bin/env python3
"""
CC4Me Voice — macOS Menu Bar App

Runs bmo_voice.py's BMOVoiceClient in-process on a background thread.
Audio/CoreAudio operations stay on the background thread; AppKit UI
stays on the main thread. They communicate via pending-state + NSTimer.

Usage:
    python bmo_menubar.py              # Run directly
    open "CC4Me Voice.app"             # Run as .app bundle
"""

import logging
import os
import sys
import threading

import rumps

# ---------------------------------------------------------------------------
# Logging — file-based (no terminal in .app mode).
# MUST be configured before importing bmo_voice so its basicConfig is a no-op.
# ---------------------------------------------------------------------------

LOG_DIR = os.path.expanduser("~/Library/Logs")
LOG_FILE = os.path.join(LOG_DIR, "BMOVoice.log")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="[bmo-voice] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE),
    ],
)
log = logging.getLogger("bmo-menubar")

# ---------------------------------------------------------------------------
# Icon paths and state → display mapping
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Load config early for profile info (icon directory, app name)
import yaml as _yaml
_config_path = os.path.join(SCRIPT_DIR, "config.yaml")
_config = {}
if os.path.exists(_config_path):
    with open(_config_path) as _f:
        _config = _yaml.safe_load(_f) or {}

_profile = _config.get("profile", {})
AGENT_NAME = _profile.get("agent_name", "CC4Me")
APP_NAME = _profile.get("app_name", "CC4Me Voice")
ICON_DIR = _profile.get("icon_dir", "").strip() or SCRIPT_DIR

ICONS = {
    "idle":       os.path.join(ICON_DIR, "icon_idle.png"),
    "listening":  os.path.join(ICON_DIR, "icon_active.png"),
    "processing": os.path.join(ICON_DIR, "icon_processing.png"),
    "speaking":   os.path.join(ICON_DIR, "icon_speaking.png"),
    "stopped":    os.path.join(ICON_DIR, "icon_idle.png"),
    "error":      os.path.join(ICON_DIR, "icon_idle.png"),
}

# Whether each icon should use template rendering (macOS auto-colors for dark/light mode)
ICON_TEMPLATE = {
    "idle":       True,   # White outline — let macOS handle the color
    "listening":  False,  # Colored — show our teal
    "processing": False,  # Colored — show our blue
    "speaking":   False,  # Colored — show our warm yellow
    "stopped":    True,   # Back to outline
    "error":      True,   # Outline
}


# ---------------------------------------------------------------------------
# Menu bar app
# ---------------------------------------------------------------------------


class BMOVoiceApp(rumps.App):
    """macOS menu bar wrapper — runs the voice client on a background thread."""

    def __init__(self):
        # Start with the idle icon (outline)
        icon_path = ICONS.get("idle")

        super().__init__(
            name=APP_NAME,
            title=None,  # No text — icon only
            icon=icon_path,
            template=True,  # Template mode for idle (auto dark/light)
            quit_button=None,  # We'll add our own with cleanup
        )

        # Menu items
        self.status_item = rumps.MenuItem("Status: Starting...", callback=None)
        self.status_item.set_callback(None)
        self.start_stop = rumps.MenuItem("Stop", callback=self.toggle)
        self.wake_word_toggle = rumps.MenuItem("Wake Word: On", callback=self.toggle_wake_word)
        self.menu = [
            self.status_item,
            None,  # separator
            self.start_stop,
            self.wake_word_toggle,
            None,  # separator
            rumps.MenuItem("View Log", callback=self.open_log),
            None,  # separator
            rumps.MenuItem(f"Quit {APP_NAME}", callback=self.quit_app),
        ]

        # Voice client state (in-process, not a subprocess)
        self._voice_client = None
        self._voice_thread = None
        self._running = False

        # Pending UI updates from background threads.
        # Background threads set these; a main-thread timer applies them.
        # This avoids crashes from AppKit/TSM calls off the main thread.
        self._pending_icon_state = None
        self._pending_status = None
        self._pending_start_stop = None

        # Poll for UI updates on the main thread (rumps timers use NSTimer)
        self._ui_timer = rumps.Timer(self._apply_pending_ui, 0.25)
        self._ui_timer.start()

        # Auto-start after app launches (1 second delay for UI to settle)
        self._startup_timer = rumps.Timer(self._delayed_start, 1)
        self._startup_timer.start()

    def _set_icon_for_state(self, state_name):
        """Set the menu bar icon for a given state. Must be called on main thread."""
        icon_path = ICONS.get(state_name, ICONS["idle"])
        use_template = ICON_TEMPLATE.get(state_name, True)

        if os.path.exists(icon_path):
            self.icon = icon_path
            self.template = use_template
            # If icon loaded but nothing visible, add title as backup
            if not self.icon:
                log.warning("Icon set but not loaded: %s", icon_path)
                self.title = AGENT_NAME
        else:
            # Fallback to text if icon file missing
            log.warning("Icon file missing: %s", icon_path)
            self.icon = None
            self.title = AGENT_NAME if state_name == "idle" else f"{AGENT_NAME} [{state_name}]"

    def _start_client(self):
        """Start the voice client on a background thread (same process)."""
        if self._running:
            return

        try:
            # Import here so sounddevice/numpy don't init on the main thread.
            # bmo_voice.py's top-level logging.basicConfig will be a no-op
            # because we already configured logging above.
            sys.path.insert(0, SCRIPT_DIR)
            from bmo_voice import BMOVoiceClient, load_config

            config = load_config()
            self._voice_client = BMOVoiceClient(config)

            # Wire up state changes to the menu bar via pending-state pattern
            def on_state_change(new_state):
                self._pending_icon_state = new_state.value

            self._voice_client.on_state_change = on_state_change
            self._running = True

            # Run voice client on a background thread — all audio ops happen there
            self._voice_thread = threading.Thread(
                target=self._run_voice_client, daemon=True, name="voice-client"
            )
            self._voice_thread.start()

            self.start_stop.title = "Stop"
            self.wake_word_toggle.title = "Wake Word: On"
            self.status_item.title = "Status: Running"
            self._set_icon_for_state("idle")
            log.info("Voice client started (in-process, background thread)")

        except Exception as e:
            log.error("Failed to start voice client: %s", e, exc_info=True)
            self.status_item.title = f"Status: Error — {e}"
            self._set_icon_for_state("error")

    def _run_voice_client(self):
        """Background thread entry point — runs the voice client's blocking listen loop."""
        try:
            self._voice_client.start()  # Blocks until stop() is called
        except Exception as e:
            log.error("Voice client crashed: %s", e, exc_info=True)
            self._pending_icon_state = "error"
            self._pending_status = f"Status: Crashed — {e}"
        finally:
            self._running = False
            self._pending_start_stop = "Start"
            if self._pending_status is None:
                self._pending_status = "Status: Stopped"
            if self._pending_icon_state is None:
                self._pending_icon_state = "stopped"
            log.info("Voice client thread exited")

    def _stop_client(self):
        """Stop the voice client."""
        if not self._running:
            return

        self._running = False
        if self._voice_client:
            self._voice_client.stop()

        # Wait for background thread to finish
        if self._voice_thread and self._voice_thread.is_alive():
            self._voice_thread.join(timeout=5)
            if self._voice_thread.is_alive():
                log.warning("Voice client thread didn't stop in 5s")

        self._voice_client = None
        self._voice_thread = None

        self.start_stop.title = "Start"
        self.status_item.title = "Status: Stopped"
        self._set_icon_for_state("stopped")
        log.info("Voice client stopped")

    def _apply_pending_ui(self, _timer):
        """Apply pending UI updates on the main thread (called by NSTimer)."""
        if self._pending_icon_state is not None:
            self._set_icon_for_state(self._pending_icon_state)
            self._pending_icon_state = None
        if self._pending_status is not None:
            self.status_item.title = self._pending_status
            self._pending_status = None
        if self._pending_start_stop is not None:
            self.start_stop.title = self._pending_start_stop
            self._pending_start_stop = None

    # -- Menu callbacks -------------------------------------------------------

    def toggle(self, _):
        """Start or stop the voice client."""
        if self._running:
            self._stop_client()
        else:
            self._start_client()

    def toggle_wake_word(self, _):
        """Enable or disable wake word detection."""
        if self._voice_client and self._running:
            new_state = not self._voice_client.wake_word_enabled
            self._voice_client.wake_word_enabled = new_state
            label = "On" if new_state else "Off"
            self.wake_word_toggle.title = f"Wake Word: {label}"
            log.info("Wake word %s", "enabled" if new_state else "disabled")

    def open_log(self, _):
        """Open the log file in Console.app."""
        os.system(f'open "{LOG_FILE}"')

    def quit_app(self, _):
        """Clean shutdown."""
        log.info("Quitting CC4Me Voice")
        self._stop_client()
        rumps.quit_application()

    # -- App lifecycle --------------------------------------------------------

    def _delayed_start(self, timer):
        """Auto-start the voice client after a brief delay."""
        timer.stop()
        self._start_client()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    BMOVoiceApp().run()
