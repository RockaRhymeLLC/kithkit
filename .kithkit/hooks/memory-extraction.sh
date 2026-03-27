#!/bin/bash
# Async memory extraction hook
# Spawns a separate claude -p (haiku) session to extract memories from the transcript
# Stores memories via the daemon API (POST /api/memory/store) instead of flat files
# Runs as async command hook — non-blocking to the main session

# Ensure claude binary is on PATH (hooks inherit a minimal shell environment)
export PATH="$HOME/.local/bin:$PATH"

LOCK_FILE="/tmp/kithkit-memory-extraction.lock"
DAEMON_URL="${KITHKIT_DAEMON_URL:-http://localhost:3847}"

# Prevent concurrent/recursive runs (lock expires after 5 min)
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE") ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0
  fi
fi

touch "$LOCK_FILE"
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

# Verify daemon is reachable before spawning agent
if ! curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; then
  exit 0
fi

# Build the prompt and write to a temp file (avoids shell quoting issues with multi-line args)
PROMPT_FILE=$(mktemp /tmp/kithkit-extract-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT_EOF
You are a memory extraction agent for a kithkit personal assistant.

Read the transcript file at: $TRANSCRIPT_PATH
Read only the LAST 200 lines to stay fast.

Extract any NEW persistent facts worth remembering. For each memory, store it by calling the daemon API using curl:

curl -sf '$DAEMON_URL/api/memory/store' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "content": "<the memory text>",
    "category": "<category>",
    "tags": ["tag1", "tag2"],
    "source": "auto-extraction",
    "importance": 3,
    "dedup": true
  }'

IMPORTANT: Use Bash with curl for ALL storage. Do NOT use the Write tool. Do NOT create any files.

When curl returns a response with "action": "review_duplicates", that means a similar memory already exists — SKIP it and move on.
When curl returns HTTP 201, the memory was stored successfully.

Use python3 to generate the JSON body for curl to avoid shell quoting issues. Example:

python3 -c "
import json, subprocess
body = json.dumps({
    'content': 'The actual memory content here',
    'category': 'technical',
    'tags': ['tag1', 'tag2'],
    'source': 'auto-extraction',
    'importance': 3,
    'dedup': True
})
result = subprocess.run(
    ['curl', '-sf', '$DAEMON_URL/api/memory/store', '-H', 'Content-Type: application/json', '-d', body],
    capture_output=True, text=True
)
print(result.stdout[:200] if result.stdout else 'no response')
"

CATEGORIES (use ONLY these 6):
- person: Names, relationships, contact info, preferences about specific people
- preference: How the user likes things done, tool choices, style preferences
- technical: Environment details, architecture decisions, tool configurations
- account: Service accounts, usernames, non-secret identifiers
- event: Things that happened on specific dates (trips, milestones, meetings)
- decision: Significant decisions made (with reasoning if stated)

IMPORTANCE SCALE (1-5) — pass as the "importance" field:
- 1: Critical — core identity, primary contacts, security-related
- 2: High — important relationships, key preferences, major decisions
- 3: Medium — useful context, general facts (DEFAULT for most extractions)
- 4: Low — nice to know, minor details
- 5: Trivial — barely worth keeping

CONFIDENCE SCALE (0.0-1.0) — include in tags as "confidence:<N>":
- 1.0: User explicitly stated this fact
- 0.9: Clear factual outcome from session (e.g., "commit merged")
- 0.7-0.8: Reasonably inferred from context (DEFAULT: 0.7)
- <0.7: Don't extract — too uncertain

RULES:
1. Only store a memory if ALL of these are true:
   - Genuinely persistent (not transient session context)
   - Stated by the user or a clear factual outcome (not inferred)
   - Would be useful to recall in a future session
2. Quality over quantity. Extracting 0 facts is perfectly fine and expected most turns.
3. Do NOT extract: temp task context, file paths being worked on, routine operations, things tracked in todos, code snippets, error messages, implementation details, secrets, passwords, or API keys.
4. When done, just exit. Do not output anything extra.
PROMPT_EOF

# Run extraction in a separate claude session (from /tmp to avoid loading project hooks)
cd /tmp
claude -p --model haiku --allowedTools "Read,Grep,Bash" < "$PROMPT_FILE" > /dev/null 2>&1

rm -f "$PROMPT_FILE"
exit 0
