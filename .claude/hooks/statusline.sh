#!/bin/bash
# Claude Code status line — shows model and context usage
input=$(cat)
MODEL=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model',{}).get('display_name','?'))" 2>/dev/null)
PCT=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d.get('context_window',{}).get('used_percentage',0)))" 2>/dev/null)
echo "[${MODEL:-?}] Context: ${PCT:-0}% used"
