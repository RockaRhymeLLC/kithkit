#!/bin/bash
#
# Stop Hook (async): Memory extraction from transcript
#
# Spawns a separate Claude session (Haiku) to extract persistent facts
# from the conversation transcript and store them via the daemon memory API.
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

# Prevent concurrent/recursive runs (lock expires after 5 min)
if [ -f "$LOCK_FILE" ]; then
  LOCK_TIME=$(cat "$LOCK_FILE" 2>/dev/null || echo 0)
  LOCK_AGE=$(( $(date +%s) - ${LOCK_TIME:-0} ))
  if [ "$LOCK_AGE" -lt 300 ]; then
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

# Build inventory of existing memories via daemon API
INVENTORY=$(curl -s "$DAEMON_URL/api/memory" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    memories = data if isinstance(data, list) else data.get('memories', [])
    for m in memories:
        cat = m.get('category', '')
        content = m.get('content', '')[:80]
        print(f'- [{cat}] {content}')
except: pass
" 2>/dev/null)

# Fallback: read from filesystem if daemon is unavailable
if [ -z "$INVENTORY" ]; then
  MEMORY_DIR="$PROJECT_DIR/.claude/state/memory/memories"
  if [ -d "$MEMORY_DIR" ]; then
    INVENTORY=$(for f in "$MEMORY_DIR"/*.md; do
      [ -f "$f" ] || continue
      subj=$(grep -m1 '^subject:' "$f" 2>/dev/null | sed 's/^subject: *//')
      cat=$(grep -m1 '^category:' "$f" 2>/dev/null | sed 's/^category: *//')
      [ -n "$subj" ] && echo "- [$cat] $subj"
    done | sort)
  fi
fi

# Build the prompt and write to a temp file
PROMPT_FILE=$(mktemp /tmp/kithkit-extract-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT_EOF
You are a memory extraction agent for a personal assistant.

Read the transcript file at: $TRANSCRIPT_PATH
Read only the LAST 200 lines to stay fast.

Extract any NEW persistent facts worth remembering.

Store each memory by running curl to the daemon API:
curl -s -X POST $DAEMON_URL/api/memory \\
  -H 'Content-Type: application/json' \\
  -d '{"content":"the fact","type":"memory","category":"preference","tags":["tag1"]}'

## EXISTING MEMORIES — do NOT duplicate
$INVENTORY

## RULES

### DEFAULT: Extract nothing
Extracting 0 facts is the EXPECTED outcome for most turns. Creating a memory is the exception, not the rule.

### 1. Dedup check (MUST do first)
Before storing ANY memory, scan the EXISTING MEMORIES list above:
- Same person = same individual. Do NOT create separate entries for sub-facts about existing people.
- Same topic = same concept. Do NOT create narrow entries about topics already covered.
- When in doubt, SKIP. A missed extraction is harmless. A duplicate wastes time.

### 2. What qualifies as a NEW memory
ALL of these must be true:
- Genuinely persistent (not transient session context or task progress)
- Not covered by ANY existing memory (even partially)
- Stated by the user or a clear factual outcome (not inferred or speculative)
- Would be useful to recall in a DIFFERENT session (not just this one)

### 3. Categories
- person: Names, relationships, contact info about specific people
- preference: How the user likes things done, tool choices, style preferences
- infrastructure: Servers, hosting, deployment, networking
- tool: Specific tools, CLIs, libraries, APIs
- architecture: System design, patterns, approaches
- account: Service accounts, usernames, non-secret identifiers
- decision: Significant decisions made (with reasoning if stated)

### 4. Do NOT extract
- Temp task context, file paths, routine operations
- Things already tracked in todos or work notes
- Code snippets, error messages, implementation details
- Secrets, passwords, API keys
- Status updates that will be stale quickly

### 5. Exit
When done (usually after extracting 0 memories), just exit silently.
PROMPT_EOF

# Run extraction in a separate claude session (from /tmp to avoid loading project hooks)
cd /tmp
claude -p --model haiku --allowedTools "Read,Bash,Grep,Glob" < "$PROMPT_FILE" > /dev/null 2>&1

rm -f "$PROMPT_FILE"
exit 0
