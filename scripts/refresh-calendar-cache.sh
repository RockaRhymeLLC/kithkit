#!/bin/bash
# Refresh EventKit caches (calendar events + reminders).
# Run periodically from a context with TCC access (e.g., tmux session).
DIR="/Users/agent/KKit-R2/scripts"

# Refresh calendar events cache
if [ -x "$DIR/calendar-events" ]; then
  "$DIR/calendar-events" > /dev/null 2>&1
fi

# Refresh reminders cache
if [ -x "$DIR/reminders" ]; then
  "$DIR/reminders" > /dev/null 2>&1
fi
