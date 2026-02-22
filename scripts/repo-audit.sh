#!/usr/bin/env bash
# repo-audit.sh — Pre-publication security scanner
# Wraps gitleaks with custom patterns for PII, secrets, and infrastructure leaks.
# Designed for scanning repos before making them public.
#
# Usage:
#   ./scripts/repo-audit.sh [options] [path]
#
# Options:
#   --tree-only     Scan working tree only (skip git history)
#   --history-only  Scan git history only (skip working tree)
#   --json          Output raw JSON instead of formatted report
#   --branch NAME   Scan specific branch history (default: all)
#   --redact        Redact secret values in output (default: show)
#   --verbose       Show gitleaks verbose output
#   -h, --help      Show this help
#
# Tree scan uses `git archive HEAD` to extract only committed files, so
# untracked state, logs, and caches are never scanned.
#
# Per-repo suppressions: add a .gitleaksignore in the repo root with
# fingerprints from gitleaks findings (one per line).
#
# Exit codes: 0 = clean, 1 = findings detected
#
# Requires: gitleaks (brew install gitleaks), jq

set -euo pipefail

# Source shared config
source "$(dirname "${BASH_SOURCE[0]}")/lib/config.sh"

# --- Colors ---
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# --- Defaults ---
SCAN_TREE=true
SCAN_HISTORY=true
OUTPUT_JSON=false
BRANCH=""
REDACT_FLAG=""
VERBOSE_FLAG=""
TARGET_PATH="."

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tree-only)   SCAN_HISTORY=false; shift ;;
    --history-only) SCAN_TREE=false; shift ;;
    --json)        OUTPUT_JSON=true; shift ;;
    --branch)      BRANCH="$2"; shift 2 ;;
    --redact)      REDACT_FLAG="--redact"; shift ;;
    --verbose)     VERBOSE_FLAG="--verbose"; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      TARGET_PATH="$1"; shift ;;
  esac
done

# Resolve to absolute path
TARGET_PATH="$(cd "$TARGET_PATH" 2>/dev/null && pwd)"

# --- Dependency check ---
if ! command -v gitleaks &>/dev/null; then
  echo -e "${RED}Error:${RESET} gitleaks not found. Install with: brew install gitleaks" >&2
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error:${RESET} jq not found. Install with: brew install jq" >&2
  exit 1
fi

# --- Config ---
CONFIG_FILE=$(mktemp /tmp/repo-audit-XXXXXX.toml)
TREE_REPORT=$(mktemp /tmp/repo-audit-tree-XXXXXX.json)
HISTORY_REPORT=$(mktemp /tmp/repo-audit-history-XXXXXX.json)
MERGED_REPORT=$(mktemp /tmp/repo-audit-merged-XXXXXX.json)

cleanup() {
  rm -f "$CONFIG_FILE" "$TREE_REPORT" "$HISTORY_REPORT" "$MERGED_REPORT"
  rm -rf "${TREE_STAGING:-}" 2>/dev/null || true
}
trap cleanup EXIT

# Write gitleaks config with custom rules
cat > "$CONFIG_FILE" << 'TOML'
# repo-audit.sh gitleaks config
# Extends all 100+ built-in rules with PII/infra patterns

[extend]
useDefault = true

# ── CRITICAL: Personal email addresses ──
[[rules]]
id = "personal-email-common"
description = "Personal email (common providers)"
regex = '''[a-zA-Z0-9._%+\-]+@(?:gmail|yahoo|hotmail|outlook|icloud|proton|protonmail|fastmail|aol|zoho|yandex|tutanota|hey)\.(?:com|net|org|me|io)'''
tags = ["HIGH", "pii", "email"]

  [[rules.allowlists]]
  description = "Ignore example/placeholder emails"
  regexes = ['''(?:example|test|noreply|no-reply|placeholder|your[-_]?(?:email)?|user|someone|anyone|name)@''']

  [[rules.allowlists]]
  description = "Ignore common patterns in deps/config"
  paths = [
    '''node_modules/''',
    '''\.git/''',
    '''vendor/''',
    '''\.venv/''',
    '''__pycache__/''',
    '''\.gitleaks\.toml$'''
  ]

# ── CRITICAL: Private/LAN IP addresses ──
[[rules]]
id = "lan-ip-rfc1918"
description = "Private/LAN IP (RFC 1918)"
regex = '''(?:^|[^0-9])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?:[^0-9]|$)'''
tags = ["HIGH", "network", "infra"]

  [[rules.allowlists]]
  description = "Ignore common patterns and test fixtures"
  regexes = ['''(?:example|placeholder|YOUR|0\.0\.0\.0|127\.0\.0\.1|localhost|10\.0\.0\.[12]|192\.168\.1\.[01]|192\.168\.0\.)''']

  [[rules.allowlists]]
  paths = [
    '''node_modules/''',
    '''\.git/''',
    '''vendor/''',
    '''\.venv/''',
    '''__pycache__/''',
    '''__tests__/''',
    '''\.test\.''',
    '''\.spec\.''',
    '''test[-_]'''
  ]

# ── HIGH: Hardcoded bearer/auth tokens ──
[[rules]]
id = "hardcoded-bearer"
description = "Hardcoded Bearer token"
regex = '''(?i)(?:bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9\-_\.]{20,}["']?'''
tags = ["HIGH", "secret", "auth"]

  [[rules.allowlists]]
  regexes = ['''(?:example|placeholder|YOUR|test|mock|fake|dummy|xxx)''']

# ── HIGH: Cloud infrastructure IDs ──
[[rules]]
id = "azure-subscription-id"
description = "Azure subscription/tenant/app ID"
regex = '''(?i)(?:subscription|tenant|client|app)[\s_-]*(?:id|ID)\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["']?'''
tags = ["MEDIUM", "infra", "azure"]

  [[rules.allowlists]]
  regexes = ['''(?:example|placeholder|YOUR|00000000-0000)''']

[[rules]]
id = "cloudflare-zone-tunnel-id"
description = "Cloudflare zone/tunnel ID"
regex = '''(?i)(?:zone|tunnel)[\s_-]*(?:id|ID)\s*[:=]\s*["']?[0-9a-f]{32}["']?'''
tags = ["MEDIUM", "infra", "cloudflare"]

# ── HIGH: Phone numbers ──
[[rules]]
id = "us-phone-number"
description = "US phone number"
regex = '''(?:\+1[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}'''
tags = ["HIGH", "pii", "phone"]

  [[rules.allowlists]]
  regexes = ['''(?:555|000|123-456|example|placeholder)''']
  paths = ['''node_modules/''', '''vendor/''']

# ── HIGH: Physical addresses ──
[[rules]]
id = "us-street-address"
description = "US street address (number + street type)"
regex = '''\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Way|Ct|Court|Pl|Place|Cir|Circle|Ter|Terrace|Hwy|Highway)\b'''
tags = ["HIGH", "pii", "address"]

  [[rules.allowlists]]
  description = "Ignore example addresses and reference docs"
  regexes = ['''123 Main''']
  paths = ['''node_modules/''', '''vendor/''', '''\.git/''', '''reference\.md$''']

# ── MEDIUM: SSH key file references ──
[[rules]]
id = "ssh-key-path"
description = "SSH private key file path"
regex = '''(?:~|/home/\w+|/Users/\w+)/\.ssh/[\w.-]+(?:\.pem|_rsa|_ed25519|_ecdsa|id_\w+)'''
tags = ["MEDIUM", "secret", "ssh"]

  [[rules.allowlists]]
  regexes = ['''(?:example|placeholder|YOUR|~\/\.ssh\/id_)''']

# ── MEDIUM: macOS keychain references with real service names ──
[[rules]]
id = "keychain-credential-ref"
description = "macOS Keychain credential reference"
regex = '''security\s+find-generic-password\s+-s\s+[\w-]+'''
tags = ["LOW", "infra", "keychain"]

  [[rules.allowlists]]
  paths = ['''\.md$''', '''README''', '''docs/''', '''tests/''', '''\.test\.''', '''\.spec\.''']

# ── MEDIUM: Telegram chat/bot IDs ──
[[rules]]
id = "telegram-chat-id"
description = "Telegram chat/user ID (long numeric)"
regex = '''(?i)(?:chat|user|telegram)[\s_-]*(?:id|ID)\s*[:=]\s*["']?\d{8,12}["']?'''
tags = ["MEDIUM", "pii", "telegram"]

# ── LOW: Hostname/machine references ──
[[rules]]
id = "local-hostname"
description = "Local hostname (.local or .lan)"
regex = '''[A-Z][\w-]*(?:\.local|\.lan)\b|[\w]+-[\w-]+(?:\.local|\.lan)\b'''
tags = ["LOW", "infra", "hostname"]

  [[rules.allowlists]]
  regexes = ['''(?:example|placeholder|YOUR|localhost|CLAUDE\.local|settings\.local|env\.local|\.env\.local|peers-machine|my-machine|host-name|path-node)''']
  paths = ['''node_modules/''', '''vendor/''']

# ── Global allowlist ──
[allowlist]
paths = [
  '''node_modules/''',
  '''\.git/''',
  '''vendor/''',
  '''\.venv/''',
  '''__pycache__/''',
  '''\.next/''',
  '''dist/''',
  '''build/''',
  '''\.gitleaks\.toml$''',
  '''repo-audit\.sh$''',
  '''\.gitleaksignore$'''
]
TOML

# --- Run scans ---
TREE_FINDINGS=0
HISTORY_FINDINGS=0

if [[ "$SCAN_TREE" == "true" ]]; then
  if [[ "$OUTPUT_JSON" != "true" ]]; then
    echo -e "${CYAN}${BOLD}Scanning working tree (tracked files only)...${RESET}"
  fi
  TREE_STAGING=$(mktemp -d /tmp/repo-audit-staging-XXXXXX)
  (cd "$TARGET_PATH" && git archive HEAD | tar -x -C "$TREE_STAGING")
  set +e
  gitleaks dir "$TREE_STAGING" \
    --config "$CONFIG_FILE" \
    --report-path "$TREE_REPORT" \
    --report-format json \
    --no-banner \
    --no-color \
    $REDACT_FLAG $VERBOSE_FLAG 2>/dev/null
  TREE_EXIT=$?
  set -e
  if [[ -s "$TREE_REPORT" ]]; then
    jq --arg staging "$TREE_STAGING/" \
      '[.[] | .File = (.File | ltrimstr($staging))]' \
      "$TREE_REPORT" > "$TREE_REPORT.tmp" && mv "$TREE_REPORT.tmp" "$TREE_REPORT"
    TREE_FINDINGS=$(jq 'length' "$TREE_REPORT" 2>/dev/null || echo 0)
  fi
  rm -rf "$TREE_STAGING"
fi

if [[ "$SCAN_HISTORY" == "true" ]]; then
  if [[ "$OUTPUT_JSON" != "true" ]]; then
    echo -e "${CYAN}${BOLD}Scanning git history...${RESET}"
  fi
  LOG_OPTS="--all"
  if [[ -n "$BRANCH" ]]; then
    LOG_OPTS="$BRANCH"
  fi
  set +e
  gitleaks git "$TARGET_PATH" \
    --config "$CONFIG_FILE" \
    --report-path "$HISTORY_REPORT" \
    --report-format json \
    --log-opts="$LOG_OPTS" \
    --no-banner \
    --no-color \
    $REDACT_FLAG $VERBOSE_FLAG 2>/dev/null
  HISTORY_EXIT=$?
  set -e
  if [[ $HISTORY_EXIT -eq 1 ]]; then
    HISTORY_FINDINGS=$(jq 'length' "$HISTORY_REPORT" 2>/dev/null || echo 0)
  fi
fi

# --- Merge results ---
TREE_JSON="[]"
HISTORY_JSON="[]"
[[ -s "$TREE_REPORT" ]] && TREE_JSON=$(jq '[.[] | . + {"Source": "working-tree"}]' "$TREE_REPORT" 2>/dev/null || echo "[]")
[[ -s "$HISTORY_REPORT" ]] && HISTORY_JSON=$(jq '[.[] | . + {"Source": "git-history"}]' "$HISTORY_REPORT" 2>/dev/null || echo "[]")

jq -s '.[0] + .[1]' <(echo "$TREE_JSON") <(echo "$HISTORY_JSON") > "$MERGED_REPORT"

TOTAL=$(jq 'length' "$MERGED_REPORT")

# --- Output ---
if [[ "$OUTPUT_JSON" == "true" ]]; then
  cat "$MERGED_REPORT"
  exit $([[ $TOTAL -gt 0 ]] && echo 1 || echo 0)
fi

# Formatted report
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Repo Audit Report${RESET}"
echo -e "${BOLD}  $(date '+%Y-%m-%d %H:%M %Z')${RESET}"
echo -e "${DIM}  Target: $TARGET_PATH${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
echo ""

if [[ $TOTAL -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}✓ CLEAN${RESET} — No findings."
  echo ""
  exit 0
fi

# Count by severity
HIGH=$(jq '[.[] | select(.Tags // [] | index("HIGH"))] | length' "$MERGED_REPORT")
MEDIUM=$(jq '[.[] | select(.Tags // [] | index("MEDIUM"))] | length' "$MERGED_REPORT")
LOW=$(jq '[.[] | select(.Tags // [] | index("LOW"))] | length' "$MERGED_REPORT")
BUILTIN=$(jq '[.[] | select((.Tags // []) | length == 0)] | length' "$MERGED_REPORT")

echo -e "  ${RED}${BOLD}⚠ $TOTAL findings${RESET}  (${RED}$HIGH high${RESET}, ${YELLOW}$MEDIUM medium${RESET}, ${DIM}$LOW low${RESET}$([ "$BUILTIN" -gt 0 ] && echo ", ${CYAN}$BUILTIN built-in${RESET}"))"
echo -e "  ${DIM}Tree: $TREE_FINDINGS | History: $HISTORY_FINDINGS${RESET}"
echo ""

# Print findings grouped by severity
print_findings() {
  local severity="$1"
  local color="$2"
  local filter="$3"
  local count
  count=$(jq "$filter | length" "$MERGED_REPORT")
  [[ $count -eq 0 ]] && return

  echo -e "${color}${BOLD}── $severity ($count) ──${RESET}"
  echo ""

  jq -r "${filter}
    | group_by(.RuleID)
    | .[]
    | {
        rule: .[0].RuleID,
        desc: .[0].Description,
        findings: [.[] | {
          file: .File,
          line: .StartLine,
          match: (.Match // .Secret // \"\"),
          source: .Source,
          commit: (.Commit // \"\")
        }]
      }
    | \"  \\(.rule) — \\(.desc)\n\" +
      (.findings[] |
        if .source == \"git-history\" then
          \"    \\(.file):\\(.line)  [history: \\(.commit[:7])]  \\(.match[:80])\"
        else
          \"    \\(.file):\\(.line)  \\(.match[:80])\"
        end
      )
  " "$MERGED_REPORT"
  echo ""
}

print_findings "HIGH" "$RED" '[.[] | select(.Tags // [] | index("HIGH"))]'
print_findings "MEDIUM" "$YELLOW" '[.[] | select(.Tags // [] | index("MEDIUM"))]'
print_findings "LOW" "$DIM" '[.[] | select(.Tags // [] | index("LOW"))]'
print_findings "BUILT-IN" "$CYAN" '[.[] | select((.Tags // []) | length == 0)]'

# Summary
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"
if [[ $HIGH -gt 0 ]]; then
  echo -e "  ${RED}${BOLD}FAIL${RESET} — $HIGH high-severity findings require attention"
elif [[ $((MEDIUM + LOW)) -gt 0 ]]; then
  echo -e "  ${YELLOW}${BOLD}WARN${RESET} — No high-severity issues, but $((MEDIUM + LOW)) findings to review"
else
  echo -e "  ${CYAN}${BOLD}INFO${RESET} — $BUILTIN built-in rule matches only (review for false positives)"
fi
echo -e "${BOLD}═══════════════════════════════════════════════════${RESET}"

exit 1
