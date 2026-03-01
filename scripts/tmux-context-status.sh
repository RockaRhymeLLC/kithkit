#!/bin/bash
#
# tmux-context-status.sh — Reads context-usage JSON files and outputs
# a concise string for tmux status-right.
#
# Output examples:
#   C:33% O:55%    (both agents have data)
#   C:33%          (only comms)
#   ctx:--         (no data or stale)

STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.claude/state"
STALE_SECONDS=300  # Consider data stale after 5 minutes

now=$(date +%s)
result=""

for role_file in comms:context-usage.json orch:context-usage-orch.json; do
  label="${role_file%%:*}"
  file="$STATE_DIR/${role_file#*:}"

  [ -f "$file" ] || continue

  ts=$(/usr/bin/jq -r '.timestamp // 0' "$file" 2>/dev/null)
  pct=$(/usr/bin/jq -r '.used_percentage // 0' "$file" 2>/dev/null)

  # Skip stale data
  [ $((now - ts)) -gt $STALE_SECONDS ] && continue

  # Abbreviate label
  tag=$([ "$label" = "comms" ] && echo "C" || echo "O")
  result="${result:+$result }${tag}:${pct}%"
done

if [ -z "$result" ]; then
  echo "ctx:--"
else
  echo "$result"
fi
