#!/bin/bash
# Build the CC4Me Voice menu bar .app bundle.
#
# This creates a lightweight .app wrapper that launches the Python
# voice client from the existing venv — no heavy py2app bundling needed.
#
# Reads profile (agent name, app name) from config.yaml so the same
# build script works for any agent (BMO, R2, etc.).
#
# Usage:
#   cd voice-client && ./build-app.sh
#
# Result:
#   dist/<App Name>.app

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read profile from config.yaml for app naming
# Prefer venv Python (has pyyaml) over system Python
YAML_PYTHON="python3"
if [ -f "$SCRIPT_DIR/.venv/bin/python3" ]; then
    YAML_PYTHON="$SCRIPT_DIR/.venv/bin/python3"
fi
if "$YAML_PYTHON" -c "import yaml" 2>/dev/null && [ -f "$SCRIPT_DIR/config.yaml" ]; then
    APP_NAME=$("$YAML_PYTHON" -c "
import yaml
with open('$SCRIPT_DIR/config.yaml') as f:
    c = yaml.safe_load(f)
print(c.get('profile', {}).get('app_name', 'CC4Me Voice'))
" 2>/dev/null || echo "CC4Me Voice")
    AGENT_NAME=$("$YAML_PYTHON" -c "
import yaml
with open('$SCRIPT_DIR/config.yaml') as f:
    c = yaml.safe_load(f)
print(c.get('profile', {}).get('agent_name', 'CC4Me'))
" 2>/dev/null || echo "CC4Me")
else
    APP_NAME="CC4Me Voice"
    AGENT_NAME="CC4Me"
fi

DIST_DIR="$SCRIPT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
# Sanitized name for executable (no spaces)
EXEC_NAME=$(echo "$APP_NAME" | tr -d ' ')

echo "=== Building $APP_NAME.app (agent: $AGENT_NAME) ==="
echo ""

# Verify venv exists
if [ ! -f "$SCRIPT_DIR/.venv/bin/python3" ]; then
    echo "ERROR: No venv found. Run ./install.sh first."
    exit 1
fi

# Verify key files
for f in bmo_menubar.py bmo_voice.py config.yaml; do
    if [ ! -f "$SCRIPT_DIR/$f" ]; then
        echo "ERROR: Missing $f"
        exit 1
    fi
done

# Clean previous build
rm -rf "$APP_DIR"

# Create .app structure
mkdir -p "$MACOS" "$RESOURCES"

# Generate Info.plist dynamically from profile
BUNDLE_ID="com.cc4me.voice-client.$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')"
cat > "$CONTENTS/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$EXEC_NAME</string>

    <key>CFBundleIdentifier</key>
    <string>$BUNDLE_ID</string>

    <key>CFBundleName</key>
    <string>$APP_NAME</string>

    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>

    <key>CFBundlePackageType</key>
    <string>APPL</string>

    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>

    <key>CFBundleVersion</key>
    <string>1</string>

    <!-- Hide from Dock — menu bar only -->
    <key>LSUIElement</key>
    <true/>

    <!-- Microphone permission prompt text -->
    <key>NSMicrophoneUsageDescription</key>
    <string>$APP_NAME needs microphone access to listen for your wake word and voice commands.</string>
</dict>
</plist>
PLIST

# Create launcher script
cat > "$MACOS/$EXEC_NAME" << LAUNCHER
#!/bin/bash
# $APP_NAME — menu bar app launcher
# Activates the venv and runs the rumps menu bar wrapper.

VOICE_DIR="$SCRIPT_DIR"
VENV_PYTHON="\$VOICE_DIR/.venv/bin/python3"
SCRIPT="\$VOICE_DIR/bmo_menubar.py"

# Log startup
LOG_FILE=~/Library/Logs/${EXEC_NAME}.log
echo "\$(date): Starting $APP_NAME from \$VOICE_DIR" >> "\$LOG_FILE"

# Set working directory for config.yaml resolution
cd "\$VOICE_DIR"

# exec replaces shell with Python — inherits .app's TCC identity
exec "\$VENV_PYTHON" "\$SCRIPT"
LAUNCHER

chmod +x "$MACOS/$EXEC_NAME"

# Ad-hoc code sign (important for TCC to recognize the bundle identity)
codesign --deep --force --sign - "$APP_DIR" 2>&1

# Validate plist
plutil "$CONTENTS/Info.plist"

# Show result
APP_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo ""
echo "Built: $APP_DIR ($APP_SIZE)"
echo ""
echo "Install:"
echo "  cp -r \"$APP_DIR\" /Applications/"
echo ""
echo "First launch:"
echo "  1. Open '$APP_NAME' from /Applications"
echo "  2. Grant microphone permission when prompted"
echo "  3. Add to Login Items: System Settings > General > Login Items"
