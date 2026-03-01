#!/bin/bash

# Kithkit Tmux Attach Script
#
# Attach to the running Kithkit tmux session.
#
# Usage: ./attach.sh

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

if [ -z "$TMUX_BIN" ]; then
    echo "Error: tmux not found. Install with: brew install tmux" >&2
    exit 1
fi

if session_exists; then
    exec $TMUX_CMD attach-session -t "=$SESSION_NAME"
else
    echo "No active session '$SESSION_NAME'. Start with: ./scripts/start-tmux.sh"
    exit 1
fi
