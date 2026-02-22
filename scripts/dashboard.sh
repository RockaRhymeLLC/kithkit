#!/usr/bin/env bash
# Kithkit Dashboard — htop for your agent's whole operation
# Usage: ./scripts/dashboard.sh [--watch]
#
# Shows: system health, services, open todos, recent commits, calendar, daemon tasks

set -euo pipefail

# Source shared config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/config.sh"

AGENT_NAME="$(get_agent_name)"
DAEMON_PORT="$(read_config '.daemon.port' '3847')"
DAEMON_URL="http://localhost:${DAEMON_PORT}"

# --- Colors & Styles ---
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BLUE=$'\033[34m'
MAGENTA=$'\033[35m'
CYAN=$'\033[36m'
WHITE=$'\033[37m'
BG_BLUE=$'\033[44m'
BG_GREEN=$'\033[42m'
BG_RED=$'\033[41m'
BG_YELLOW=$'\033[43m'

# --- Config ---
TERM_WIDTH=$(tput cols 2>/dev/null || echo 80)

# --- Helpers ---
repeat_char() {
  printf '%*s' "$2" '' | tr ' ' "$1"
}

truncate_str() {
  local str="$1" max="$2"
  if [ ${#str} -gt "$max" ]; then
    echo "${str:0:$((max-1))}…"
  else
    echo "$str"
  fi
}

# Box drawing (content width = TERM_WIDTH - 2 for the │ borders)
box_top() {
  local title="$1"
  local title_len=${#title}
  local remaining=$((TERM_WIDTH - title_len - 5))
  [ "$remaining" -lt 0 ] && remaining=0
  printf "${CYAN}┌─ ${BOLD}${WHITE}%s${RESET}${CYAN} %s┐${RESET}\n" "$title" "$(repeat_char '─' "$remaining")"
}

box_bottom() {
  printf "${CYAN}└%s┘${RESET}\n" "$(repeat_char '─' $((TERM_WIDTH - 2)))"
}

box_line() {
  local content="$1"
  local visible
  visible=$(printf '%s' "$content" | sed $'s/\033\[[0-9;]*m//g')
  local visible_len=${#visible}
  local inner=$((TERM_WIDTH - 4))
  local padding=$((inner - visible_len))
  [ "$padding" -lt 0 ] && padding=0
  printf "${CYAN}│${RESET} %b%*s ${CYAN}│${RESET}\n" "$content" "$padding" ""
}

# --- Render Functions ---
render_header() {
  local now
  now=$(date "+%a %b %d %I:%M %p %Z")
  printf "\n"
  printf "  ${BG_BLUE}${WHITE}${BOLD}  ⬡ ${AGENT_NAME} Dashboard${RESET}  ${DIM}%s${RESET}\n" "$now"
  printf "\n"
}

render_status_bar() {
  local ok="$1" warn="$2" err="$3"
  local status_color="$BG_GREEN"
  local status_text="ALL SYSTEMS OPERATIONAL"
  if [ "$err" -gt 0 ]; then
    status_color="$BG_RED"
    status_text="ERRORS DETECTED"
  elif [ "$warn" -gt 0 ]; then
    status_color="$BG_YELLOW"
    status_text="WARNINGS"
  fi

  printf "  ${status_color}${WHITE}${BOLD} %s ${RESET}" "$status_text"
  printf "  ${GREEN}${BOLD}%s${RESET}${DIM} ok${RESET}" "$ok"
  [ "$warn" -gt 0 ] && printf "  ${YELLOW}${BOLD}%s${RESET}${DIM} warn${RESET}" "$warn"
  [ "$err" -gt 0 ] && printf "  ${RED}${BOLD}%s${RESET}${DIM} err${RESET}" "$err"
  printf "\n\n"
}

render_system() {
  local health_json="$1"
  box_top "System"
  python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('results', []):
    cat = r.get('category', '')
    if cat in ('Disk', 'Memory', 'Procs', 'Logs'):
        icons = {'Disk': '💾', 'Memory': '🧠', 'Procs': '⚙️ ', 'Logs': '📋'}
        icon = icons.get(cat, '  ')
        print(f'{icon}|{cat}|{r[\"message\"]}')
" <<< "$health_json" | while IFS='|' read -r icon cat msg; do
    [ -z "$cat" ] && continue
    box_line "${icon} ${DIM}${cat}:${RESET} ${msg}"
  done
  box_bottom
}

render_services() {
  local health_json="$1"
  box_top "Services"

  local -a names=()
  local -a statuses=()

  while IFS='|' read -r status name version; do
    [ -z "$status" ] && continue
    names+=("$name")
    statuses+=("$status")
  done < <(python3 -c "
import sys, json
d = json.load(sys.stdin)
services = [r for r in d.get('results', []) if r.get('category') == 'Services']
for s in services:
    status = 'ok' if s['severity'] == 'ok' else ('warn' if s['severity'] == 'warning' else 'err')
    name = s['message'].replace(' healthy', '').replace(' warning', '').replace(' error', '')
    version = s.get('detail', '')
    print(f'{status}|{name}|{version}')
" <<< "$health_json")

  local total=${#names[@]}
  local cols=3
  local col_width=$(( (TERM_WIDTH - 6) / cols ))

  local i=0
  while [ $i -lt $total ]; do
    local line=""
    local j=0
    while [ $j -lt $cols ] && [ $((i + j)) -lt $total ]; do
      local idx=$((i + j))
      local name="${names[$idx]}"
      local status="${statuses[$idx]}"
      local schar="✓" scolor="${GREEN}"
      [ "$status" = "warn" ] && schar="!" && scolor="${YELLOW}"
      [ "$status" = "err" ] && schar="✗" && scolor="${RED}"

      local entry
      entry=$(truncate_str "$name" $((col_width - 4)))
      local padded
      padded=$(printf "%-${col_width}s" "${schar} ${entry}")
      line+="${scolor}${padded}${RESET}"
      j=$((j + 1))
    done
    box_line "$line"
    i=$((i + cols))
  done

  if [ $total -gt 0 ]; then
    box_line "${DIM}${total} services total${RESET}"
  fi
  box_bottom
}

render_todos() {
  box_top "Open To-Dos"
  local count=0

  while IFS=$'\t' read -r id title priority status; do
    [ -z "$id" ] && continue

    local pcolor="$WHITE"
    case "$priority" in
      CRITICAL) pcolor="$RED" ;;
      HIGH) pcolor="$YELLOW" ;;
      MEDIUM) pcolor="$WHITE" ;;
      LOW) pcolor="$DIM" ;;
    esac

    local sicon="${DIM}○${RESET}"
    case "$status" in
      in-progress) sicon="${GREEN}●${RESET}" ;;
      blocked) sicon="${RED}■${RESET}" ;;
    esac

    local short_title
    short_title=$(truncate_str "$title" $((TERM_WIDTH - 20)))
    box_line "${sicon} ${pcolor}[${id}]${RESET} ${short_title}"
    count=$((count + 1))
  done < <(python3 -c "
import json, glob, os
state_dir = os.environ.get('STATE_DIR', '')
files = []
for pattern in ['*-open-*.json', '*-in-progress-*.json', '*-blocked-*.json']:
    files.extend(glob.glob(os.path.join(state_dir, 'todos', pattern)))
for f in sorted(files):
    if '/archive/' in f:
        continue
    try:
        d = json.load(open(f))
        print(f'{d[\"id\"]}\t{d[\"title\"]}\t{d[\"priority\"].upper()}\t{d[\"status\"]}')
    except:
        pass
" 2>/dev/null)

  if [ "$count" -eq 0 ]; then
    box_line "${DIM}No open to-dos!${RESET}"
  fi
  box_bottom
}

render_commits() {
  box_top "Recent Commits"
  cd "$BASE_DIR"
  git log --oneline --no-decorate -8 2>/dev/null | while IFS= read -r line; do
    local hash="${line%% *}"
    local msg="${line#* }"
    msg=$(truncate_str "$msg" $((TERM_WIDTH - 16)))
    box_line "${YELLOW}${hash}${RESET} ${msg}"
  done
  box_bottom
}

render_calendar() {
  [ -f "$STATE_DIR/calendar.md" ] || return

  local today tomorrow
  today=$(date +%Y-%m-%d)
  tomorrow=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d '+1 day' +%Y-%m-%d 2>/dev/null || echo "")

  local has_entries=0
  local in_section=""
  local entries=""

  while IFS= read -r line; do
    if [[ "$line" == "### $today" ]]; then
      in_section="today"
      entries+="TODAY\n"
      continue
    elif [[ -n "$tomorrow" && "$line" == "### $tomorrow" ]]; then
      in_section="tomorrow"
      entries+="TOMORROW\n"
      continue
    elif [[ "$line" == "###"* || "$line" == "##"* ]]; then
      in_section=""
      continue
    fi
    if [[ -n "$in_section" && "$line" == "- "* ]]; then
      entries+="${line}\n"
      has_entries=1
    fi
  done < "$STATE_DIR/calendar.md"

  [ "$has_entries" -eq 0 ] && return

  box_top "Calendar"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ "$line" = "TODAY" ]; then
      box_line "${GREEN}${BOLD}Today:${RESET}"
    elif [ "$line" = "TOMORROW" ]; then
      box_line "${YELLOW}${BOLD}Tomorrow:${RESET}"
    else
      local item="${line#- }"
      item=$(truncate_str "$item" $((TERM_WIDTH - 8)))
      box_line "  ${item}"
    fi
  done <<< "$(echo -e "$entries")"
  box_bottom
}

render_footer() {
  printf "\n  ${DIM}Press Ctrl+C to exit"
  [ "${WATCH:-0}" = "1" ] && printf " • Refreshes every 30s"
  printf "${RESET}\n\n"
}

# --- Main ---
render_dashboard() {
  clear

  # Fetch health data once
  local health_json
  health_json=$(curl -sf "$DAEMON_URL/health" 2>/dev/null || echo '{"summary":{"ok":0,"warnings":0,"errors":0},"results":[]}')

  local ok warn err
  read -r ok warn err < <(python3 -c "
import sys, json
d = json.load(sys.stdin)
s = d['summary']
print(s['ok'], s['warnings'], s['errors'])
" <<< "$health_json")

  render_header
  render_status_bar "$ok" "$warn" "$err"
  render_system "$health_json"
  printf "\n"
  render_services "$health_json"
  printf "\n"
  render_todos
  printf "\n"
  render_commits
  printf "\n"
  render_calendar
  render_footer
}

if [[ "${1:-}" == "--watch" || "${1:-}" == "-w" ]]; then
  WATCH=1
  while true; do
    render_dashboard
    sleep 30
  done
else
  WATCH=0
  render_dashboard
fi
