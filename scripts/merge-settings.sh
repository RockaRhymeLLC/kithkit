#!/usr/bin/env bash
# merge-settings.sh — Section-aware YAML settings merge.
#
# Merges upstream config changes into kithkit.config.yaml without
# clobbering instance-specific sections (channels, agent, identity).
#
# Strategy:
#   1. Read upstream kithkit.defaults.yaml (framework defaults)
#   2. Read local kithkit.config.yaml (instance overrides)
#   3. Merge: take upstream defaults as base, apply instance overrides on top
#   4. Write back to kithkit.config.yaml, preserving all instance sections
#
# Instance-protected sections (never overwritten from upstream):
#   agent, tmux, channels, extensions, scheduler.tasks (extra instance tasks)
#
# Usage:
#   bash scripts/merge-settings.sh [--dry-run] [--upstream-defaults <file>]
#
# Options:
#   --dry-run              Print merged result to stdout, do not write file
#   --upstream-defaults    Path to upstream defaults file (default: kithkit.defaults.yaml)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULTS_FILE="$PROJECT_DIR/kithkit.defaults.yaml"
CONFIG_FILE="$PROJECT_DIR/kithkit.config.yaml"
DRY_RUN=false

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --upstream-defaults)
      DEFAULTS_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ── Sanity checks ─────────────────────────────────────────────

if [ ! -f "$DEFAULTS_FILE" ]; then
  echo "Error: upstream defaults not found at $DEFAULTS_FILE" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: instance config not found at $CONFIG_FILE" >&2
  exit 1
fi

# ── Require python3 with PyYAML ──────────────────────────────

if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required for YAML merge" >&2
  exit 1
fi

python3 -c "import yaml" 2>/dev/null || {
  echo "Error: PyYAML required. Install with: pip3 install pyyaml" >&2
  exit 1
}

# ── Merge via Python ──────────────────────────────────────────

MERGE_SCRIPT=$(cat <<'PYEOF'
import sys
import yaml
import copy

# Instance-protected top-level keys — never overwrite from upstream
INSTANCE_KEYS = {
    'agent',
    'tmux',
    'channels',
}

# Keys where we preserve instance entries (array merge: upstream + instance)
ARRAY_MERGE_KEYS = {
    'scheduler.tasks',
    'extensions.dirs',
    'extensions.disabled',
}

def deep_merge(base: dict, override: dict, path: str = '') -> dict:
    """
    Merge override into base. Instance-protected keys are preserved as-is.
    For non-protected keys, override wins at the leaf level.
    """
    result = copy.deepcopy(base)

    for key, override_val in override.items():
        current_path = f"{path}.{key}" if path else key

        # Instance-protected: always keep instance value
        if key in INSTANCE_KEYS and not path:
            result[key] = copy.deepcopy(override_val)
            continue

        if key not in result:
            # Key only in instance config — keep it
            result[key] = copy.deepcopy(override_val)
        elif isinstance(result[key], dict) and isinstance(override_val, dict):
            # Recurse into nested objects
            result[key] = deep_merge(result[key], override_val, current_path)
        elif isinstance(result[key], list) and isinstance(override_val, list):
            # For task arrays: deduplicate by name, instance entries take priority
            if current_path in ARRAY_MERGE_KEYS:
                merged = {
                    item['name']: item
                    for item in result[key]
                    if isinstance(item, dict) and 'name' in item
                }
                for item in override_val:
                    if isinstance(item, dict) and 'name' in item:
                        merged[item['name']] = item  # instance overrides upstream
                result[key] = list(merged.values())
            else:
                # Default: instance list wins
                result[key] = copy.deepcopy(override_val)
        else:
            # Scalar: instance value wins
            result[key] = copy.deepcopy(override_val)

    return result

defaults_file = sys.argv[1]
config_file = sys.argv[2]

with open(defaults_file) as f:
    defaults = yaml.safe_load(f) or {}

with open(config_file) as f:
    instance = yaml.safe_load(f) or {}

# Start from defaults as base, apply instance on top
merged = deep_merge(defaults, instance)

# Output with comment header
output = "# kithkit.config.yaml — Instance configuration\n"
output += "# Merged from kithkit.defaults.yaml + instance overrides.\n"
output += "# Instance-protected sections (agent, tmux, channels) always preserved.\n\n"
output += yaml.dump(merged, default_flow_style=False, sort_keys=False, allow_unicode=True)

print(output, end='')
PYEOF
)

MERGED=$(python3 -c "$MERGE_SCRIPT" "$DEFAULTS_FILE" "$CONFIG_FILE")

if [ "$DRY_RUN" = "true" ]; then
  echo "# [DRY RUN] Merged config would be:"
  echo "$MERGED"
  exit 0
fi

# ── Backup before writing ─────────────────────────────────────

BACKUP="${CONFIG_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
cp "$CONFIG_FILE" "$BACKUP"
echo "Backed up config to: $BACKUP"

# ── Write merged config ───────────────────────────────────────

echo "$MERGED" > "$CONFIG_FILE"
echo "Merged settings written to: $CONFIG_FILE"
echo ""
echo "Review the changes before reloading the daemon:"
echo "  diff $BACKUP $CONFIG_FILE"
echo "  curl -s -X POST http://localhost:3847/api/config/reload"
