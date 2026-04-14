#!/bin/bash

# Kithkit Daemon Startup Wrapper
#
# Runs before starting the daemon to unlock the login keychain.
# This prevents SecurityAgent GUI prompts from hanging on headless Macs
# (e.g., when launchd starts the daemon before a GUI session is available).
#
# Background: On 2026-04-07, BMO's daemon was bricked by a SecurityAgent hang.
# macOS keychain operations (e.g., credential lookups) trigger the SecurityAgent
# process to display a GUI unlock prompt. When launchd starts the daemon at login
# before the WindowServer is ready, SecurityAgent blocks indefinitely — hanging
# any process that touches the keychain. Pre-unlocking here prevents that.
#
# Usage: Called by the launchd plist instead of node directly.
# The launchd EnvironmentVariables (PATH, HOME, NODE_ENV) are inherited.

# Source shared config for BASE_DIR and kithkit_log()
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: starting keychain unlock"

# ── Keychain unlock ────────────────────────────────────────────────────────────
# These commands are best-effort. If they fail, we still start the daemon.
# Do NOT use set -e here — keychain failures must not block daemon startup.

# 1. Unlock the login keychain (prevent SecurityAgent prompts)
#    Try to retrieve the stored keychain password. If unavailable, attempt
#    a passwordless unlock (works when the session already has access).
LOGIN_PW=$(security find-generic-password -s "credential-login-keychain-password" -w 2>/dev/null)
if [ -n "$LOGIN_PW" ]; then
    if security unlock-keychain -p "$LOGIN_PW" ~/Library/Keychains/login.keychain-db 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: keychain unlocked with stored password"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: WARNING: keychain unlock with stored password failed" >&2
    fi
else
    if security unlock-keychain ~/Library/Keychains/login.keychain-db 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: keychain unlocked (passwordless)"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: WARNING: passwordless keychain unlock failed (continuing)" >&2
    fi
fi

# 2. Disable auto-lock timeout (prevent keychain from locking while daemon runs)
#    Calling set-keychain-settings with no -t flag sets timeout to 0 (never lock).
security set-keychain-settings ~/Library/Keychains/login.keychain-db 2>/dev/null || \
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: WARNING: set-keychain-settings failed (continuing)" >&2

# 3. Ensure login keychain is the default (some operations assume the default keychain)
security default-keychain -s ~/Library/Keychains/login.keychain-db 2>/dev/null || \
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: WARNING: default-keychain set failed (continuing)" >&2

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: keychain unlock completed — starting daemon"

# ── Detect node binary ────────────────────────────────────────────────────────
# Prefer node on PATH (launchd may have a limited PATH, so also check common
# install locations as fallbacks).
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
else
    for candidate in \
        /opt/homebrew/opt/node@22/bin/node \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /usr/bin/node; do
        if [ -x "$candidate" ]; then
            NODE_BIN="$candidate"
            break
        fi
    done
fi

if [ -z "$NODE_BIN" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: ERROR: node binary not found" >&2
    exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] start-daemon.sh: using node at $NODE_BIN"

# ── Start daemon ───────────────────────────────────────────────────────────────
exec "$NODE_BIN" "$BASE_DIR/daemon/dist/bootstrap.js"
