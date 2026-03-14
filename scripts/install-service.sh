#!/bin/bash
# install-service.sh — Install Kithkit launchd services from templates
#
# Renders templates/launchd/*.plist with real paths and installs them to
# ~/Library/LaunchAgents/ so they autostart on login.
#
# Usage:
#   ./scripts/install-service.sh            # Install and optionally load
#   ./scripts/install-service.sh --dry-run  # Show what would be done
#   ./scripts/install-service.sh --uninstall # Unload and remove plists

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$PROJECT_DIR/templates/launchd"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

DRY_RUN=false
UNINSTALL=false

for arg in "$@"; do
    case "$arg" in
        --dry-run)   DRY_RUN=true ;;
        --uninstall) UNINSTALL=true ;;
        --help|-h)
            echo "Usage: $0 [--dry-run] [--uninstall]"
            echo ""
            echo "Options:"
            echo "  --dry-run    Show what would be done without doing it"
            echo "  --uninstall  Unload and remove installed plists"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            echo "Run $0 --help for usage" >&2
            exit 1
            ;;
    esac
done

# ── Detect paths ──────────────────────────────────────────────────────────────

NODE_PATH="$(which node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
    # Try common install locations
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
        if [ -x "$candidate" ]; then
            NODE_PATH="$candidate"
            break
        fi
    done
fi

if [ -z "$NODE_PATH" ]; then
    echo "ERROR: node not found. Install Node.js 22+ and ensure it is on PATH." >&2
    exit 1
fi

NODE_BIN_DIR="$(dirname "$NODE_PATH")"

# ── Plist labels ──────────────────────────────────────────────────────────────

PLISTS=(
    "com.assistant.daemon"
    "com.assistant.comms"
    "com.assistant.restart-watcher"
)

# ── Uninstall ─────────────────────────────────────────────────────────────────

if [ "$UNINSTALL" = true ]; then
    echo "Uninstalling Kithkit launchd services..."
    for label in "${PLISTS[@]}"; do
        plist_dest="$LAUNCH_AGENTS_DIR/${label}.plist"
        if [ "$DRY_RUN" = true ]; then
            echo "[dry-run] Would unload and remove: $plist_dest"
        else
            if launchctl list | grep -q "^.*[[:space:]]${label}$" 2>/dev/null; then
                echo "  Unloading $label..."
                launchctl unload "$plist_dest" 2>/dev/null || true
            fi
            if [ -f "$plist_dest" ]; then
                echo "  Removing $plist_dest"
                rm -f "$plist_dest"
            else
                echo "  $plist_dest not found (already removed)"
            fi
        fi
    done
    echo "Done."
    exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────

echo "Installing Kithkit launchd services"
echo "  Project dir : $PROJECT_DIR"
echo "  Node path   : $NODE_PATH"
echo "  Node bin dir: $NODE_BIN_DIR"
echo "  Home        : $HOME"
echo "  Destination : $LAUNCH_AGENTS_DIR"
echo ""

# Create logs directory
if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] Would create: $PROJECT_DIR/logs/"
else
    mkdir -p "$PROJECT_DIR/logs"
fi

# Render and install each template
for label in "${PLISTS[@]}"; do
    template="$TEMPLATES_DIR/${label}.plist"
    dest="$LAUNCH_AGENTS_DIR/${label}.plist"

    if [ ! -f "$template" ]; then
        echo "WARNING: Template not found: $template — skipping" >&2
        continue
    fi

    if [ "$DRY_RUN" = true ]; then
        echo "[dry-run] Would render: $template -> $dest"
        echo "[dry-run] Substitutions:"
        echo "  {{PROJECT_DIR}}  -> $PROJECT_DIR"
        echo "  {{NODE_PATH}}    -> $NODE_PATH"
        echo "  {{NODE_BIN_DIR}} -> $NODE_BIN_DIR"
        echo "  {{HOME}}         -> $HOME"
        echo ""
    else
        echo "Installing $label..."
        sed \
            -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
            -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
            -e "s|{{NODE_BIN_DIR}}|$NODE_BIN_DIR|g" \
            -e "s|{{HOME}}|$HOME|g" \
            "$template" > "$dest"
        echo "  -> $dest"
    fi
done

if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] No files were written."
    exit 0
fi

echo ""
echo "Plists installed. Load them now? [y/N]"
read -r response
if [[ "$response" =~ ^[Yy]$ ]]; then
    for label in "${PLISTS[@]}"; do
        plist_dest="$LAUNCH_AGENTS_DIR/${label}.plist"
        if [ -f "$plist_dest" ]; then
            echo "  Loading $label..."
            launchctl load "$plist_dest"
        fi
    done
    echo ""
    echo "Services loaded. Verify with:"
    echo "  launchctl list | grep com.assistant"
else
    echo ""
    echo "Not loaded. To load manually:"
    for label in "${PLISTS[@]}"; do
        echo "  launchctl load $LAUNCH_AGENTS_DIR/${label}.plist"
    done
fi

echo ""
echo "To uninstall: $0 --uninstall"
