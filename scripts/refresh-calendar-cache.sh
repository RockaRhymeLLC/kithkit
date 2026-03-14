#!/bin/bash
# Refresh the calendar events cache.
# Run periodically from cron (user login context has EventKit TCC access).
BINARY="/Users/agent/KKit-R2/scripts/calendar-events"
if [ -x "$BINARY" ]; then
  "$BINARY" > /dev/null 2>&1
fi
