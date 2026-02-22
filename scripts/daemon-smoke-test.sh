#!/bin/bash
# Daemon Smoke Test — verifies all key endpoints respond correctly after a rebuild.
# Usage: ./scripts/daemon-smoke-test.sh [port]

# Source shared config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"

PORT="${1:-$(read_config '.daemon.port' '3847')}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0
WARN=0

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }
yellow(){ printf "\033[33m%s\033[0m" "$1"; }
dim()   { printf "\033[90m%s\033[0m" "$1"; }

check() {
  local method="$1" path="$2" desc="$3" expect_key="$4"
  local url="${BASE}${path}"
  local response status body

  response=$(curl -s -w "\n%{http_code}" --max-time 5 "$url" 2>/dev/null)
  status=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$status" = "200" ]; then
    if [ -n "$expect_key" ]; then
      if echo "$body" | grep -q "$expect_key"; then
        printf "  $(green "PASS")  %-30s %s\n" "$path" "$(dim "$desc")"
        PASS=$((PASS + 1))
      else
        printf "  $(yellow "WARN")  %-30s %s $(dim "(missing: $expect_key)")\n" "$path" "$desc"
        WARN=$((WARN + 1))
      fi
    else
      printf "  $(green "PASS")  %-30s %s\n" "$path" "$(dim "$desc")"
      PASS=$((PASS + 1))
    fi
  else
    printf "  $(red "FAIL")  %-30s %s $(dim "(HTTP $status)")\n" "$path" "$desc"
    FAIL=$((FAIL + 1))
  fi
}

check_json_array() {
  local path="$1" desc="$2" min_items="${3:-0}"
  local url="${BASE}${path}"
  local response status body count

  response=$(curl -s -w "\n%{http_code}" --max-time 5 "$url" 2>/dev/null)
  status=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$status" = "200" ]; then
    count=$(echo "$body" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    if [ -n "$count" ] && [ "$count" -ge "$min_items" ]; then
      printf "  $(green "PASS")  %-30s %s $(dim "($count items)")\n" "$path" "$desc"
      PASS=$((PASS + 1))
    else
      printf "  $(yellow "WARN")  %-30s %s $(dim "(${count:-?} items, expected >=$min_items)")\n" "$path" "$desc"
      WARN=$((WARN + 1))
    fi
  else
    printf "  $(red "FAIL")  %-30s %s $(dim "(HTTP $status)")\n" "$path" "$desc"
    FAIL=$((FAIL + 1))
  fi
}

AGENT_NAME="$(get_agent_name)"

echo ""
echo "  ${AGENT_NAME} Daemon Smoke Test"
echo "  ════════════════════════════════════════"
echo "  Target: $BASE"
echo ""

# Quick connectivity check
if ! curl -s --max-time 3 "$BASE/status" >/dev/null 2>&1; then
  echo "  $(red "FAIL")  Daemon not responding at $BASE"
  echo ""
  exit 1
fi

echo "  Health & Status"
echo "  ────────────────────────────────────────"
check GET /health "System health" '"summary"'
check GET /status "Daemon status" '"daemon":"running"'
check GET /status/extended "Extended status" '"uptime"'

echo ""
echo "  Scheduler"
echo "  ────────────────────────────────────────"
check_json_array /tasks "Scheduler tasks" 1

echo ""
echo "  Monitoring"
echo "  ────────────────────────────────────────"
check GET /delivery-stats "Delivery stats" '"totalDelivered"'
check_json_array /logs?limit=5 "Log query" 1
check_json_array /logs/modules "Log modules" 1
check GET /git-status "Git status" '"branch"'

echo ""
echo "  Agent Comms"
echo "  ────────────────────────────────────────"
check GET /agent/status "Agent status" '"agent"'
check_json_array /agent-comms/recent?limit=5 "Recent messages" 0

echo ""
echo "  ════════════════════════════════════════"
total=$((PASS + FAIL + WARN))
printf "  Results: $(green "$PASS passed")  "
[ "$WARN" -gt 0 ] && printf "$(yellow "$WARN warnings")  "
[ "$FAIL" -gt 0 ] && printf "$(red "$FAIL failed")  "
echo "($total total)"
echo ""

[ "$FAIL" -gt 0 ] && exit 1
exit 0
