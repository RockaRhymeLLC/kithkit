#!/bin/bash
# Deploy voice client to a remote laptop via SSH.
#
# Usage: ./deploy-remote.sh <user>@<host> [config-file]
#
# Example:
#   ./deploy-remote.sh agent@192.168.12.244  # Uses config.yaml
#   ./deploy-remote.sh chrissy@macbook config-r2.yaml
#
# What it does:
#   1. Creates ~/voice-client/ on the remote machine
#   2. Copies all needed files (scripts, config, icons, sounds, wake word model)
#   3. Runs install.sh to create venv + install deps
#   4. Runs build-app.sh to create the .app bundle
#   5. Copies the .app to /Applications/
#
# Prerequisites:
#   - SSH access to the remote machine (key-based auth recommended)
#   - Python 3.10+ on the remote machine (brew install python@3.12)
#   - Homebrew on the remote machine

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$1" ]; then
    echo "Usage: $0 <user>@<host> [config-file]"
    echo ""
    echo "Example:"
    echo "  $0 agent@192.168.12.244"
    echo "  $0 chrissy@macbook config-r2.yaml"
    exit 1
fi

REMOTE="$1"
CONFIG_FILE="${2:-config.yaml}"

if [ ! -f "$SCRIPT_DIR/$CONFIG_FILE" ]; then
    echo "ERROR: Config file not found: $SCRIPT_DIR/$CONFIG_FILE"
    exit 1
fi

# Read app name from config for final reporting
APP_NAME="CC4Me Voice"
if command -v python3 &>/dev/null; then
    APP_NAME=$(python3 -c "
import yaml
with open('$SCRIPT_DIR/$CONFIG_FILE') as f:
    c = yaml.safe_load(f)
print(c.get('profile', {}).get('app_name', 'CC4Me Voice'))
" 2>/dev/null || echo "CC4Me Voice")
fi

echo "=== Deploying $APP_NAME to $REMOTE ==="
echo "Config: $CONFIG_FILE"
echo ""

# Step 1: Create remote directory
echo "[1/5] Creating ~/voice-client/ on remote..."
ssh "$REMOTE" "mkdir -p ~/voice-client/sounds"

# Step 2: Copy files
echo "[2/5] Copying files..."

# Core scripts
scp -q "$SCRIPT_DIR/bmo_menubar.py" \
       "$SCRIPT_DIR/bmo_voice.py" \
       "$SCRIPT_DIR/voice_client.py" \
       "$SCRIPT_DIR/install.sh" \
       "$SCRIPT_DIR/build-app.sh" \
       "$SCRIPT_DIR/requirements.txt" \
       "$REMOTE:~/voice-client/"

# Config (rename to config.yaml on remote)
scp -q "$SCRIPT_DIR/$CONFIG_FILE" "$REMOTE:~/voice-client/config.yaml"

# Sounds
scp -q "$SCRIPT_DIR/sounds/"* "$REMOTE:~/voice-client/sounds/" 2>/dev/null || true

# Custom icon directory (read from config)
ICON_DIR=$(python3 -c "
import yaml
with open('$SCRIPT_DIR/$CONFIG_FILE') as f:
    c = yaml.safe_load(f)
d = c.get('profile', {}).get('icon_dir', '')
print(d)
" 2>/dev/null || echo "")

if [ -n "$ICON_DIR" ] && [ -d "$SCRIPT_DIR/$ICON_DIR" ]; then
    echo "       Copying icons: $ICON_DIR/"
    ssh "$REMOTE" "mkdir -p ~/voice-client/$ICON_DIR"
    scp -q "$SCRIPT_DIR/$ICON_DIR/"* "$REMOTE:~/voice-client/$ICON_DIR/"
fi

# Wake word model (if custom .onnx exists matching config)
WW_MODEL=$(python3 -c "
import yaml
with open('$SCRIPT_DIR/$CONFIG_FILE') as f:
    c = yaml.safe_load(f)
print(c.get('wake_word', {}).get('model', ''))
" 2>/dev/null || echo "")

if [ -n "$WW_MODEL" ] && [ -f "$SCRIPT_DIR/$WW_MODEL" ]; then
    echo "       Copying wake word model: $WW_MODEL"
    scp -q "$SCRIPT_DIR/$WW_MODEL" "$REMOTE:~/voice-client/"
fi

# Step 3: Install dependencies
echo "[3/5] Installing dependencies (this may take a minute)..."
ssh "$REMOTE" "cd ~/voice-client && chmod +x install.sh build-app.sh && ./install.sh"

# Step 4: Build .app
echo "[4/5] Building app bundle..."
ssh "$REMOTE" "cd ~/voice-client && ./build-app.sh"

# Step 5: Install to /Applications
echo "[5/5] Installing to /Applications/..."
ssh "$REMOTE" "cp -r ~/voice-client/dist/*.app /Applications/ 2>/dev/null && echo 'Installed to /Applications/' || echo 'Copy to /Applications/ manually (may need permission)'"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "On the remote machine:"
echo "  1. Open '$APP_NAME' from /Applications (or Spotlight)"
echo "  2. Grant microphone permission when prompted"
echo "  3. Test with push-to-talk or wake word"
echo "  4. Add to Login Items: System Settings > General > Login Items"
