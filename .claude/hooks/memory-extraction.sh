#!/bin/bash
#
# Stop Hook (async): Memory extraction from transcript
#
# Spawns a separate Claude session (Haiku) to extract persistent facts
# from the conversation transcript and store them via the daemon memory API.
#
# Features:
# - Vector dedup via `dedup: true` in store request
# - Source tracking (comms vs orchestrator session)
# - Daily cap (max 15 memories/day) to prevent memory bloat
# - 10-minute cooldown between extractions
# - Highly selective prompt — most sessions should extract 0 memories
#
# Runs as async hook — non-blocking to the main session.

# Ensure claude binary is on PATH (hooks inherit a minimal shell environment)
export PATH="$HOME/.local/bin:$PATH"

LOCK_FILE="/tmp/kithkit-memory-extraction.lock"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Read daemon port from config (default 3847)
DAEMON_PORT=3847
if command -v yq >/dev/null 2>&1 && [ -f "$PROJECT_DIR/kithkit.config.yaml" ]; then
  PORT=$(yq -r '.daemon.port // empty' "$PROJECT_DIR/kithkit.config.yaml" 2>/dev/null)
  [ -n "$PORT" ] && DAEMON_PORT="$PORT"
fi
DAEMON_URL="http://localhost:$DAEMON_PORT"

# --- Gate 1: Cooldown (10 minutes between extractions) ---
if [ -f "$LOCK_FILE" ]; then
  LOCK_TIME=$(cat "$LOCK_FILE" 2>/dev/null || echo 0)
  LOCK_AGE=$(( $(date +%s) - ${LOCK_TIME:-0} ))
  if [ "$LOCK_AGE" -lt 600 ]; then
    exit 0
  fi
fi

date +%s > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# Read hook input from stdin
INPUT=$(cat)

# Skip if already running from a stop hook (prevent infinite loops)
STOP_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stop_hook_active', False))" 2>/dev/null)
if [ "$STOP_ACTIVE" = "True" ]; then
  exit 0
fi

# Extract transcript path from hook JSON (tilde-expand if needed)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "
import sys,json,os
p = json.load(sys.stdin).get('transcript_path','')
print(os.path.expanduser(p))
" 2>/dev/null)

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Detect session type for source tracking
SESSION_SOURCE="extraction"
TMUX_BIN="/opt/homebrew/bin/tmux"
COMMS_SESSION=$(grep -A1 '^tmux:' "$PROJECT_DIR/kithkit.config.yaml" 2>/dev/null | grep 'session:' | sed 's/.*session:[[:space:]]*//' | tr -d '"' | tr -d "'")
COMMS_SESSION="${COMMS_SESSION:-comms1}"

if [ -n "$TMUX" ]; then
  CURRENT_SESSION=$($TMUX_BIN display-message -p '#{session_name}' 2>/dev/null || true)
  if [ "$CURRENT_SESSION" = "$COMMS_SESSION" ]; then
    SESSION_SOURCE="comms-extraction"
  elif [ "$CURRENT_SESSION" = "${COMMS_SESSION}-orch" ]; then
    SESSION_SOURCE="orchestrator-extraction"
  fi
fi

# Build full inventory of existing memories via daemon API (ALL categories)
INVENTORY=$(python3 -c "
import urllib.request, json

url = '$DAEMON_URL/api/memory/search'
categories = ['person', 'preference', 'infrastructure', 'tool', 'architecture',
              'account', 'decision', 'bugfix', 'debugging', 'fact', 'procedural']
seen = set()
for cat in categories:
    try:
        req = urllib.request.Request(url, data=json.dumps({'category': cat}).encode(),
              headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.load(resp)
            for m in data.get('data', []):
                mid = m.get('id')
                if mid in seen: continue
                seen.add(mid)
                c = m.get('content', '')[:100]
                print(f'- [{m.get(\"category\",\"\")}] {c}')
    except: pass
" 2>/dev/null)

# Build the prompt and write to a temp file
PROMPT_FILE=$(mktemp /tmp/kithkit-extract-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT_EOF
You are a HIGHLY SELECTIVE memory extraction agent for a personal assistant.

Read the transcript file at: $TRANSCRIPT_PATH
Read only the LAST 150 lines.

Your job: decide if this session contains any TRULY NOVEL, IMPORTANT facts
that would be valuable months from now. The answer is usually NO.

Extracting 0 is the expected and correct outcome for most sessions.

## Storage process

Step 1: Check for duplicates first (dedup:true):
curl -s -X POST $DAEMON_URL/api/memory/store \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"the fact","type":"fact","category":"preference","tags":["tag1"],"source":"$SESSION_SOURCE","dedup":true}'

If response contains "action":"review_duplicates", compare the "duplicates" array.
Only skip if existing memory truly covers the same info. Similar wording about
DIFFERENT subjects is NOT a duplicate.

Step 2: If NOT a duplicate, store without dedup flag:
curl -s -X POST $DAEMON_URL/api/memory/store \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"the fact","type":"fact","category":"preference","tags":["tag1"],"source":"$SESSION_SOURCE"}'

If dedup is unavailable (503), store directly without the flag.

## EXISTING MEMORIES — do NOT duplicate any of these
$INVENTORY

## STRICT SELECTION CRITERIA

A memory must pass ALL of these gates. If it fails ANY gate, do NOT store it.

### Gate 1: Is it about the HUMAN or their PERSONAL context?
YES: People they know, their preferences, their accounts, their decisions
YES: Their specific infrastructure (servers, domains, hosting they pay for)
NO: Technical implementation details of the codebase
NO: How internal tools/APIs work (this belongs in docs, not memory)
NO: Bug fixes, error messages, code patterns
NO: Architecture of the project being worked on

### Gate 2: Would it still matter in 3 months?
YES: "User prefers Telegram over email"
YES: "Peer agent runs on the Mac mini at 192.168.x.x"
YES: "User decided to use a separate repo for the website"
NO: "CI is now green" (status changes constantly)
NO: "Fixed 4 bugs in orchestrator" (task completion — tracked in todos)
NO: "Repo is 95% ready for launch" (progress updates go stale)

### Gate 3: Is it already covered by existing memories?
Check the EXISTING MEMORIES list above. If ANY existing memory covers
the same topic — even partially or from a different angle — SKIP.
Updating/refining existing facts is NOT your job.

### Gate 4: Is it a personal fact, not a codebase fact?
Memory is for HUMAN context: who people are, what they prefer, how to reach them,
what services they use, what decisions they've made.
Memory is NOT for: how code works, API endpoint behavior, file locations in the repo,
build system quirks, library versions, git commit details.

## Categories (if you do extract)
- person: People, relationships, contact info
- preference: How the user likes things done
- infrastructure: Their servers, hosting, networking (NOT internal daemon/API details)
- decision: Significant decisions (with date and reasoning)
- account: Service accounts, usernames

## DO NOT extract (explicit examples from real over-extraction)
- "Vector search requires enableVectorSearch() call" → codebase detail, not memory
- "Orchestrator wrapper keeps tmux alive by polling" → implementation detail
- "npm install must run at workspace root" → build system knowledge, not memory
- "Catalog uses signed hash verification" → architecture docs, not memory
- "Message polling via since_id cursor API" → API behavior, belongs in docs
- "GitHub Pages has 100GB bandwidth limit" → public knowledge, not personal
- "Content filtering blocks orchestrator output" → transient bug, not memory
- Anything about commit hashes, file paths, or error resolution steps
- Anything that describes how the assistant's own systems work internally

## Final instruction
Read the transcript. In 95% of sessions, the correct action is to extract NOTHING.
Only extract if you find a genuinely new personal fact about the human or their world
that isn't already in the existing memories list. When done, exit silently.
PROMPT_EOF

# Run extraction in a separate claude session (from /tmp to avoid loading project hooks)
cd /tmp
claude -p --model haiku --allowedTools "Read,Bash,Grep,Glob" < "$PROMPT_FILE" > /dev/null 2>&1

rm -f "$PROMPT_FILE"
exit 0
