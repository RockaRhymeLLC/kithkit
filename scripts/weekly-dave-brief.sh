#!/bin/bash
# weekly-dave-brief.sh
# Escalates to the orchestrator to compile a weekly self-report for Dave.
# Triggered by LaunchAgent com.r2d2.weekly-dave-brief (Sundays 6pm local).

set -eu

DAEMON="http://localhost:3847"
LOG="/Users/agent/KKit-R2/logs/weekly-dave-brief.log"
PROMPT_FILE="/Users/agent/KKit-R2/scripts/weekly-dave-brief.prompt.md"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

if ! curl -fsS "${DAEMON}/health" >/dev/null 2>&1; then
  log "daemon not healthy, aborting"
  exit 1
fi

if [ ! -f "$PROMPT_FILE" ]; then
  log "missing prompt file: $PROMPT_FILE"
  exit 1
fi

RESPONSE=$(/usr/bin/env python3 - "$PROMPT_FILE" "$DAEMON" <<'PYEOF'
import urllib.request, json, sys
prompt_file, daemon = sys.argv[1], sys.argv[2]
with open(prompt_file) as f:
    task = f.read()
body = json.dumps({'task': task, 'context': 'Scheduled weekly brief fired by LaunchAgent com.r2d2.weekly-dave-brief.'}).encode()
req = urllib.request.Request(f'{daemon}/api/orchestrator/escalate', data=body, headers={'Content-Type':'application/json'}, method='POST')
try:
    print(urllib.request.urlopen(req, timeout=10).read().decode())
except Exception as e:
    print(f'ERR: {e}', file=sys.stderr)
    sys.exit(1)
PYEOF
)

log "escalated: ${RESPONSE}"
