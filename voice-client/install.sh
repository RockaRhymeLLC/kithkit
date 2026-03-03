#!/bin/bash
# Kithkit Voice Client — install dependencies
#
# Usage: cd voice-client && ./install.sh
#
# Creates a Python venv and installs all required packages.
# Supports multiple instances (BMO, R2, Skippy) via config files.
# Requires: Python 3.10+, Homebrew (for portaudio if needed)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "=== Kithkit Voice Client Setup ==="
echo ""

# Check for Xcode Command Line Tools (needed to compile native Python packages)
if ! xcode-select -p &>/dev/null; then
    echo "Xcode Command Line Tools not found. Installing..."
    xcode-select --install
    echo ""
    echo "Follow the popup to install, then re-run this script."
    exit 1
fi

# Check for Homebrew
if ! command -v brew &>/dev/null; then
    echo "Homebrew not found. Install it first:"
    echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    echo ""
    echo "Then re-run this script."
    exit 1
fi

# Check Python version — install if missing
PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" &>/dev/null; then
        version=$("$candidate" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
        major=$(echo "$version" | cut -d. -f1)
        minor=$(echo "$version" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
            PYTHON="$candidate"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "Python 3.10+ not found. Installing Python 3.12 via Homebrew..."
    brew install python@3.12
    PYTHON="python3.12"
fi

echo "Using Python: $PYTHON ($($PYTHON --version))"

# Create venv
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

# Activate and install
echo "Installing dependencies..."
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q
pip install -r "$SCRIPT_DIR/requirements.txt" -q

# Download pre-trained wake word models (for initial testing)
echo ""
echo "Downloading pre-trained wake word models..."
python3 -c "import openwakeword; openwakeword.utils.download_models()"

echo ""
echo "=== Setup complete ==="
echo ""
echo "To run the BMO voice client (default config):"
echo "  source $VENV_DIR/bin/activate"
echo "  python3 bmo_voice.py"
echo ""
echo "To run the Skippy voice client:"
echo "  source $VENV_DIR/bin/activate"
echo "  python3 bmo_voice.py config-skippy.yaml"
echo ""
echo "To run the R2 voice client:"
echo "  source $VENV_DIR/bin/activate"
echo "  python3 bmo_voice.py config-r2.yaml"
echo ""
echo "For auto-start, install the appropriate launchd plist:"
echo "  BMO:    cp com.bmo.voice-client.plist ~/Library/LaunchAgents/"
echo "          launchctl load ~/Library/LaunchAgents/com.bmo.voice-client.plist"
echo "  Skippy: cp com.skippy.voice-client.plist ~/Library/LaunchAgents/"
echo "          launchctl load ~/Library/LaunchAgents/com.skippy.voice-client.plist"
echo ""
echo "NOTE: On first run, macOS will ask for microphone permission."
echo "      Click 'Allow' when prompted."
