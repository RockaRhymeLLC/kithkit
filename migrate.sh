#!/usr/bin/env bash
# migrate.sh — .claude/ → .kithkit/ migration script
#
# Final model (Dave-revised 2026-03-26):
#   MOVE: .claude/hooks/ → .kithkit/hooks/
#         .claude/state/ (kithkit-owned files) → .kithkit/state/
#         .claude/agents/ → .kithkit/agents/ (MOVE+SYNC: rsync back to .claude/agents/)
#         .claude/skills/ → .kithkit/skills/ (MOVE+SYNC: rsync back to .claude/skills/)
#   SYNC: .claude/settings.json and .claude/CLAUDE.md — copies made to .kithkit/ as authoritative
#         .kithkit/agents/ → .claude/agents/ (rsync, so Claude Code can still find them)
#         .kithkit/skills/ → .claude/skills/ (rsync, so Claude Code can still find them)
#
# Usage:
#   ./migrate.sh              # Run migration
#   ./migrate.sh --rollback   # Reverse migration from manifest
#   ./migrate.sh --dry-run    # Show what would be done (no changes)
#   ./migrate.sh --yes        # Skip confirmation prompts
#
# After migration:
#   - .kithkit/ is the authoritative source for hooks, state, agents, skills
#   - .claude/ contains synced copies (maintained by POST /api/sync/claude)
#   - Claude Code internal files remain in .claude/ (projects/, worktrees/, state/todos.json, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
MANIFEST="$PROJECT_DIR/migrate-rollback.manifest"
DRY_RUN=false

# ── Parse args ────────────────────────────────────────────────

ROLLBACK=false
YES=false
for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK=true ;;
    --dry-run)  DRY_RUN=true ;;
    --yes)      YES=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────

log() {
  echo "[migrate] $*"
}

log_skip() {
  echo "[migrate] SKIP: $*"
}

log_dry() {
  echo "[migrate] DRY-RUN: $*"
}

# Move a single file: src → dst
# Writes manifest entry: SRC|DST
move_file() {
  local src="$1"
  local dst="$2"

  if [ ! -e "$src" ]; then
    log_skip "$src (does not exist)"
    return 0
  fi

  if $DRY_RUN; then
    log_dry "mv $src → $dst"
    return 0
  fi

  local dst_dir
  dst_dir="$(dirname "$dst")"
  mkdir -p "$dst_dir"

  mv "$src" "$dst"
  echo "${src}|${dst}" >> "$MANIFEST"
  log "Moved: $src → $dst"
}

# Move a directory using rsync (preserves timestamps, permissions)
# Then removes the source directory.
move_dir() {
  local src="$1"
  local dst="$2"

  if [ ! -d "$src" ]; then
    log_skip "$src/ (directory does not exist)"
    return 0
  fi

  if $DRY_RUN; then
    log_dry "rsync -a $src/ → $dst/ (then remove $src)"
    return 0
  fi

  mkdir -p "$dst"
  # rsync: src/ copies contents into dst/
  rsync -a "$src/" "$dst/"
  rm -rf "$src"
  echo "${src}/|${dst}/" >> "$MANIFEST"
  log "Moved dir: $src/ → $dst/"
}

# Copy a file (for SYNC items — originals stay in .claude/ until sync runs)
copy_file() {
  local src="$1"
  local dst="$2"

  if [ ! -e "$src" ]; then
    log_skip "copy $src (does not exist)"
    return 0
  fi

  if $DRY_RUN; then
    log_dry "cp $src → $dst"
    return 0
  fi

  local dst_dir
  dst_dir="$(dirname "$dst")"
  mkdir -p "$dst_dir"

  cp "$src" "$dst"
  log "Copied: $src → $dst (authoritative copy in .kithkit/)"
}

# ── Rollback ─────────────────────────────────────────────────

if $ROLLBACK; then
  if [ ! -f "$MANIFEST" ]; then
    echo "[migrate] ERROR: No manifest found at $MANIFEST" >&2
    exit 1
  fi

  if ! $YES && ! $DRY_RUN; then
    echo "[migrate] WARNING: This will reverse the .claude/ → .kithkit/ migration."
    echo "[migrate] All files moved to .kithkit/ will be moved back to .claude/."
    echo ""
    read -rp "[migrate] This will rollback the migration. Continue? [y/N] " confirm
    case "$confirm" in
      y|Y|yes|YES) ;;
      *) echo "[migrate] Aborted."; exit 0 ;;
    esac
  fi

  log "Reading manifest: $MANIFEST"
  log "Reversing migration..."

  while IFS='|' read -r src dst; do
    [ -z "$src" ] && continue

    # Detect directory entries (trailing slash)
    if [[ "$src" == */ ]]; then
      src="${src%/}"
      dst="${dst%/}"
      if [ ! -d "$dst" ]; then
        log_skip "rollback dir $dst (does not exist)"
        continue
      fi
      mkdir -p "$(dirname "$src")"
      rsync -a "$dst/" "$src/"
      rm -rf "$dst"
      log "Restored dir: $dst/ → $src/"
    else
      if [ ! -e "$dst" ]; then
        log_skip "rollback $dst (does not exist)"
        continue
      fi
      mkdir -p "$(dirname "$src")"
      mv "$dst" "$src"
      log "Restored: $dst → $src"
    fi
  done < "$MANIFEST"

  # Restore hook paths in .kithkit/settings.json (back to .claude/hooks/)
  # Note: migration updated hook paths in .kithkit/settings.json, not .claude/settings.json
  kithkit_settings="$PROJECT_DIR/.kithkit/settings.json"
  if [ -f "$kithkit_settings" ]; then
    if grep -q '\.kithkit/hooks/' "$kithkit_settings"; then
      log "Restoring hook paths in .kithkit/settings.json → .claude/hooks/"
      if ! $DRY_RUN; then
        sed -i.bak 's|\.kithkit/hooks/|.claude/hooks/|g' "$kithkit_settings"
        rm -f "${kithkit_settings}.bak"
        # Sync updated settings.json back to .claude/ so hooks point at existing paths
        cp "$kithkit_settings" "$PROJECT_DIR/.claude/settings.json"
        log "Synced updated settings.json to .claude/settings.json"
      fi
    fi
  fi

  # Remove .kithkit/settings.json and .kithkit/CLAUDE.md (copied during migration, not moved)
  for copied_file in "$PROJECT_DIR/.kithkit/settings.json" "$PROJECT_DIR/.kithkit/CLAUDE.md"; do
    if [ -f "$copied_file" ]; then
      if ! $DRY_RUN; then
        rm -f "$copied_file"
        log "Removed copied file: $copied_file"
      else
        log_dry "rm $copied_file"
      fi
    fi
  done

  # Clean up .kithkit/ if now empty
  kithkit_dir="$PROJECT_DIR/.kithkit"
  if [ -d "$kithkit_dir" ] && [ -z "$(ls -A "$kithkit_dir" 2>/dev/null)" ]; then
    rmdir "$kithkit_dir"
    log "Removed empty .kithkit/"
  fi

  log "Rollback complete."
  rm -f "$MANIFEST"
  exit 0
fi

# ── Migration ─────────────────────────────────────────────────

log "Starting .claude/ → .kithkit/ migration"
log "Project dir: $PROJECT_DIR"
$DRY_RUN && log "DRY-RUN mode — no changes will be made"

if ! $YES && ! $DRY_RUN; then
  echo ""
  echo "[migrate] This will move kithkit-owned files from .claude/ to .kithkit/."
  echo "[migrate] Claude Code internals (.claude/projects/, .claude/worktrees/, etc.) are not moved."
  echo ""
  read -rp "[migrate] Continue? [y/N] " confirm
  case "$confirm" in
    y|Y|yes|YES) ;;
    *) echo "[migrate] Aborted."; exit 0 ;;
  esac
fi

# Initialize manifest
if ! $DRY_RUN; then
  > "$MANIFEST"
  log "Initialized manifest: $MANIFEST"
fi

# ── Step 1: Create .kithkit/ structure ────────────────────────

log "Creating .kithkit/ directory structure..."
if ! $DRY_RUN; then
  mkdir -p "$PROJECT_DIR/.kithkit/hooks"
  mkdir -p "$PROJECT_DIR/.kithkit/state"
  mkdir -p "$PROJECT_DIR/.kithkit/agents"
  mkdir -p "$PROJECT_DIR/.kithkit/skills"
  chmod 0700 "$PROJECT_DIR/.kithkit"
  chmod 0700 "$PROJECT_DIR/.kithkit/hooks"
  chmod 0700 "$PROJECT_DIR/.kithkit/state"
else
  log_dry "mkdir -p .kithkit/hooks .kithkit/state .kithkit/agents .kithkit/skills"
fi
log "Directory structure created."

# ── Step 2: Move hook scripts ─────────────────────────────────

log "Moving hook scripts: .claude/hooks/ → .kithkit/hooks/"
hooks_src="$PROJECT_DIR/.claude/hooks"
hooks_dst="$PROJECT_DIR/.kithkit/hooks"

if [ -d "$hooks_src" ]; then
  for hook in "$hooks_src"/*; do
    [ -f "$hook" ] || continue
    basename="$(basename "$hook")"
    move_file "$hook" "$hooks_dst/$basename"
  done
  # Remove empty hooks dir if all moved
  if ! $DRY_RUN && [ -d "$hooks_src" ] && [ -z "$(ls -A "$hooks_src" 2>/dev/null)" ]; then
    rmdir "$hooks_src"
    log "Removed empty .claude/hooks/"
  fi
else
  log_skip ".claude/hooks/ (directory does not exist)"
fi

# ── Step 3: Move runtime state files ─────────────────────────

log "Moving kithkit runtime state files: .claude/state/ → .kithkit/state/"
state_src="$PROJECT_DIR/.claude/state"
state_dst="$PROJECT_DIR/.kithkit/state"

# Explicitly skipped Claude Code internal files
log_skip ".claude/state/todos.json (Claude Code internal — not moved)"
log_skip ".claude/state/ide/ (Claude Code internal — not moved)"
log_skip ".claude/state/conversation_state.json (Claude Code internal — not moved)"

# Move individual kithkit-owned state files
for f in \
  channel.txt \
  assistant-state.md \
  autonomy.json \
  skip-permissions.json \
  identity.json \
  reply-chat-id.txt \
  3rd-party-senders.json \
  orchestrator-state.md \
  context-usage.json \
  context-usage-orch.json \
  safe-senders.json \
  system-prompt.txt \
  calendar.md \
  browser-contexts.json \
  browser-session.json; do
  move_file "$state_src/$f" "$state_dst/$f"
done

# Move directories (rsync-based)
move_dir "$state_src/telegram-media"          "$state_dst/telegram-media"
move_dir "$state_src/network-cache"           "$state_dst/network-cache"
move_dir "$state_src/assistant-state-backups" "$state_dst/assistant-state-backups"
move_dir "$state_src/memory"                  "$state_dst/memory"

# ── Step 3b: Move agents/ and skills/ to .kithkit/ ───────────

log "Moving agent profiles: .claude/agents/ → .kithkit/agents/"
move_dir "$PROJECT_DIR/.claude/agents" "$PROJECT_DIR/.kithkit/agents"

log "Moving skill directories: .claude/skills/ → .kithkit/skills/"
move_dir "$PROJECT_DIR/.claude/skills" "$PROJECT_DIR/.kithkit/skills"

# ── Step 4: Explicitly log skipped paths ─────────────────────

log "Confirming skipped paths (not moved):"
log_skip ".claude/projects/ (STAY — Claude Code internal)"
log_skip ".claude/worktrees/ (STAY — Claude Code managed)"
log_skip ".claude/state/todos.json (STAY — Claude Code internal)"
log_skip ".claude/state/ide/ (STAY — Claude Code internal)"

# ── Step 5: Copy settings.json and CLAUDE.md to .kithkit/ ────

log "Copying settings.json and CLAUDE.md to .kithkit/ as authoritative copies..."
copy_file "$PROJECT_DIR/.claude/settings.json" "$PROJECT_DIR/.kithkit/settings.json"
copy_file "$PROJECT_DIR/.claude/CLAUDE.md"      "$PROJECT_DIR/.kithkit/CLAUDE.md"

# ── Step 6: Update hook paths in .kithkit/settings.json ──────

log "Updating hook paths in .kithkit/settings.json (.claude/hooks/ → .kithkit/hooks/)..."
kithkit_settings="$PROJECT_DIR/.kithkit/settings.json"
if [ -f "$kithkit_settings" ]; then
  if grep -q '\.claude/hooks/' "$kithkit_settings" 2>/dev/null; then
    if ! $DRY_RUN; then
      sed -i.bak 's|\.claude/hooks/|.kithkit/hooks/|g' "$kithkit_settings"
      rm -f "${kithkit_settings}.bak"
      log "Hook paths updated in .kithkit/settings.json"
    else
      log_dry "sed: .claude/hooks/ → .kithkit/hooks/ in .kithkit/settings.json"
    fi
  else
    log "No .claude/hooks/ references found in .kithkit/settings.json (already updated or no hooks configured)"
  fi
else
  log_skip "update hook paths (.kithkit/settings.json does not exist)"
fi

# ── Step 7: Initial sync (.kithkit/ → .claude/) ──────────────

log "Running initial sync: copying .kithkit/ authoritative files → .claude/..."
if ! $DRY_RUN; then
  if [ -f "$PROJECT_DIR/.kithkit/settings.json" ]; then
    cp "$PROJECT_DIR/.kithkit/settings.json" "$PROJECT_DIR/.claude/settings.json"
    log "Synced: .kithkit/settings.json → .claude/settings.json"
  fi
  if [ -f "$PROJECT_DIR/.kithkit/CLAUDE.md" ]; then
    cp "$PROJECT_DIR/.kithkit/CLAUDE.md" "$PROJECT_DIR/.claude/CLAUDE.md"
    log "Synced: .kithkit/CLAUDE.md → .claude/CLAUDE.md"
  fi
  if [ -d "$PROJECT_DIR/.kithkit/agents" ]; then
    mkdir -p "$PROJECT_DIR/.claude/agents"
    rsync -a --delete "$PROJECT_DIR/.kithkit/agents/" "$PROJECT_DIR/.claude/agents/"
    log "Synced: .kithkit/agents/ → .claude/agents/"
  fi
  if [ -d "$PROJECT_DIR/.kithkit/skills" ]; then
    mkdir -p "$PROJECT_DIR/.claude/skills"
    rsync -a --delete "$PROJECT_DIR/.kithkit/skills/" "$PROJECT_DIR/.claude/skills/"
    log "Synced: .kithkit/skills/ → .claude/skills/"
  fi
else
  log_dry "cp .kithkit/settings.json → .claude/settings.json"
  log_dry "cp .kithkit/CLAUDE.md → .claude/CLAUDE.md"
  log_dry "rsync -a --delete .kithkit/agents/ → .claude/agents/"
  log_dry "rsync -a --delete .kithkit/skills/ → .claude/skills/"
fi

# ── Done ─────────────────────────────────────────────────────

log ""
log "Migration complete."
$DRY_RUN && log "DRY-RUN: no changes were made."
if ! $DRY_RUN; then
  log "Rollback manifest written to: $MANIFEST"
  log ""
  log "Next steps:"
  log "  1. Restart the comms session to pick up the new hook paths."
  log "  2. Verify .kithkit/state/ and .kithkit/hooks/ have the expected files."
  log "  3. Send a test message and confirm channel.txt appears in .kithkit/state/"
  log "     with no permission prompt."
  log "  4. Run 'POST /api/sync/claude' to keep .claude/ in sync."
  log "     (or type /kkitclaudesync in your agent session)"
  log ""
  log "Note: .claude/ hooks and state are now stale — the new locations are"
  log "      .kithkit/hooks/ and .kithkit/state/. Claude Code reads hooks from"
  log "      .kithkit/settings.json (synced back to .claude/settings.json)."
fi
