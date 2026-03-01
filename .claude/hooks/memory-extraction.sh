#!/bin/bash
# Async memory extraction hook
# Spawns a separate claude -p (haiku) session to extract memories from the transcript
# Runs as async command hook — non-blocking to the main session

# Ensure claude binary is on PATH (hooks inherit a minimal shell environment)
export PATH="$HOME/.local/bin:$PATH"

LOCK_FILE="/tmp/cc4me-memory-extraction.lock"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
MEMORY_DIR="$PROJECT_DIR/.claude/state/memory/memories"

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

# Build the prompt and write to a temp file (avoids shell quoting issues with multi-line args)
PROMPT_FILE=$(mktemp /tmp/r2d2-extract-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT_EOF
You are a memory extraction agent for a personal assistant named R2D2.

Read the transcript file at: $TRANSCRIPT_PATH
Read only the LAST 200 lines to stay fast.

Extract any NEW persistent facts worth remembering. Write each as an individual memory file to: $MEMORY_DIR

CATEGORIES (use ONLY these 6):
- person: Names, relationships, contact info, preferences about specific people
- preference: How the user likes things done, tool choices, style preferences
- technical: Environment details, architecture decisions, tool configurations
- account: Service accounts, usernames, non-secret identifiers
- event: Things that happened on specific dates (trips, milestones, meetings)
- decision: Significant decisions made (with reasoning if stated)

IMPORTANCE SCALE (1-5):
- 1: Critical — core identity, primary contacts, security-related
- 2: High — important relationships, key preferences, major decisions
- 3: Medium — useful context, general facts (DEFAULT for most extractions)
- 4: Low — nice to know, minor details
- 5: Trivial — barely worth keeping

CONFIDENCE SCALE (0.0-1.0):
- 1.0: User explicitly stated this fact
- 0.9: Clear factual outcome from session (e.g., "commit merged")
- 0.7-0.8: Reasonably inferred from context (DEFAULT: 0.7)
- <0.7: Don't extract — too uncertain

DEDUP CHECK (REQUIRED before each write):
1. Use Grep to search $MEMORY_DIR for the subject keywords
2. If a similar memory exists, skip — don't create near-duplicates
3. Check both subject lines AND content for overlap

RULES:
1. Run \`date '+%Y%m%d-%H%M'\` via Bash to get the current timestamp for filenames.
2. Only write a memory if ALL of these are true:
   - Genuinely persistent (not transient session context)
   - Not already in memories (passed dedup check)
   - Stated by the user or a clear factual outcome (not inferred)
   - Would be useful to recall in a future session
3. Write to $MEMORY_DIR with format:
   - Filename: YYYYMMDD-HHMM-slug.md
   - YAML frontmatter: date (ISO 8601), category, importance (1-5), subject, tags (list), confidence, source (auto-extraction)
   - Markdown body with the fact
4. Quality over quantity. Extracting 0 facts is perfectly fine and expected most turns.
5. Do NOT extract: temp task context, file paths being worked on, routine operations, things tracked in todos, code snippets, error messages, implementation details, secrets, passwords, or API keys.
6. When done, just exit. Do not output anything extra.
PROMPT_EOF

# Run extraction in a separate claude session (from /tmp to avoid loading project hooks)
cd /tmp
claude -p --model haiku --allowedTools "Read,Write,Grep,Glob,Bash" < "$PROMPT_FILE" > /dev/null 2>&1

rm -f "$PROMPT_FILE"
exit 0
