#!/usr/bin/env python3
"""
Auto-announce on restart (todo #50).

Sends a brief Telegram notification summarizing what was restored from saved state.
Respects the silence config flag — suppresses if GET /api/config/silence returns true.

Called from session-start.sh as:
    python3 announce-restart.py <path-to-assistant-state.md>
"""

import json
import os
import sys
import urllib.request

DAEMON = "http://localhost:3847"


def check_silence() -> bool:
    """Return True if silence mode is active."""
    try:
        req = urllib.request.Request(f"{DAEMON}/api/config/silence", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            return bool(data.get("value"))
    except Exception:
        # Config key doesn't exist yet (404) or daemon issue — not silenced
        return False


def build_message(state_path: str) -> str:
    """Build a brief announcement from assistant-state.md."""
    if not os.path.isfile(state_path):
        return "Back online! No saved state — starting fresh."

    with open(state_path) as f:
        lines = f.readlines()

    if len(lines) <= 3:
        return "Back online! No saved state — starting fresh."

    current_task = ""
    next_steps: list[str] = []
    uncommitted = 0

    section = ""
    for line in lines:
        stripped = line.strip()

        # Track which section we're in
        if stripped.startswith("## "):
            section = stripped.lstrip("# ").strip()
            continue

        if section == "Current Task" and not current_task and stripped:
            current_task = stripped[:120]

        elif section == "Next Steps":
            if stripped.startswith(("1.", "2.", "3.", "4.", "5.", "- ")):
                next_steps.append(stripped[:80])
                if len(next_steps) >= 3:
                    section = ""  # stop collecting

        elif "Uncommitted" in section:
            if stripped.startswith("- "):
                uncommitted += 1

    # Assemble message
    parts = ["Back online!"]

    if current_task:
        parts.append(f"\nRestored: {current_task}")

    if next_steps:
        parts.append("\nNext up:")
        for step in next_steps:
            parts.append(step)

    if uncommitted > 0:
        parts.append(f"\n({uncommitted} uncommitted change{'s' if uncommitted != 1 else ''})")

    return "\n".join(parts)


def send_telegram(message: str) -> None:
    """Send message via daemon /api/send."""
    payload = json.dumps({"message": message, "channels": ["telegram"]}).encode()
    req = urllib.request.Request(
        f"{DAEMON}/api/send",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)


def main() -> None:
    state_path = sys.argv[1] if len(sys.argv) > 1 else ""

    if check_silence():
        return

    msg = build_message(state_path)
    send_telegram(msg)


if __name__ == "__main__":
    main()
