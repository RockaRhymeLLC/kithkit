#!/usr/bin/env bash
# Quick health check with color output.
# Usage: ./scripts/health.sh [--watch] [--quiet]

set -euo pipefail

# Source shared config for daemon port
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"

PORT="$(read_config '.daemon.port' '3847')"
URL="http://localhost:$PORT/health"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[0;2m'
BOLD='\033[1m'
RESET='\033[0m'

quiet=false
watch=false

for arg in "$@"; do
  case "$arg" in
    --quiet|-q) quiet=true ;;
    --watch|-w) watch=true ;;
    --help|-h)
      echo "Usage: $0 [--watch] [--quiet]"
      echo "  --watch, -w   Poll every 10s"
      echo "  --quiet, -q   Only show warnings and errors"
      exit 0
      ;;
  esac
done

check_health() {
  local json
  json=$(curl -s --connect-timeout 3 "$URL" 2>/dev/null) || {
    echo -e "${RED}${BOLD}DAEMON UNREACHABLE${RESET} (port $PORT)"
    return 1
  }

  local ok warn err
  ok=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['ok'])")
  warn=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['warnings'])")
  err=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['summary']['errors'])")

  # Summary line
  local summary_color="${GREEN}"
  [[ "$warn" -gt 0 ]] && summary_color="${YELLOW}"
  [[ "$err" -gt 0 ]] && summary_color="${RED}"

  local ts
  ts=$(date '+%H:%M:%S')
  echo -e "${DIM}[$ts]${RESET} ${summary_color}${BOLD}${ok} OK${RESET}"
  [[ "$warn" -gt 0 ]] && echo -e "        ${YELLOW}${BOLD}${warn} WARNING${RESET}"
  [[ "$err" -gt 0 ]] && echo -e "        ${RED}${BOLD}${err} ERROR${RESET}"

  # Details
  echo "$json" | python3 -c "
import sys, json

data = json.load(sys.stdin)
quiet = '$quiet' == 'true'

severity_map = {
    'ok': '\033[0;32m  OK \033[0m',
    'warning': '\033[0;33mWARN \033[0m',
    'error': '\033[0;31m ERR \033[0m',
}

for r in data['results']:
    sev = r['severity']
    if quiet and sev == 'ok':
        continue
    icon = severity_map.get(sev, '  ?  ')
    cat = r['category'].ljust(8)
    msg = r['message']
    detail = r.get('detail', '')
    line = f'  {icon} \033[0;36m{cat}\033[0m {msg}'
    if detail:
        line += f'  \033[0;2m({detail})\033[0m'
    print(line)
"
}

AGENT_NAME="$(get_agent_name)"

if $watch; then
  while true; do
    clear
    echo -e "${BOLD}${AGENT_NAME} Health Monitor${RESET}  ${DIM}(Ctrl-C to stop)${RESET}"
    echo ""
    check_health || true
    sleep 10
  done
else
  check_health
fi
