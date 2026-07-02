#!/usr/bin/env bash
# check-commit-identity.sh — CI pre-merge guard.
#
# Fails if any commit in BASE..HEAD has an author OR committer email that:
#   - is empty or missing
#   - ends with .local (case-insensitive) — typical macOS default hostname leak
#
# Usage: check-commit-identity.sh <base-sha> <head-sha>
#
# Exits 1 with a clear message naming every offending commit and email.
# Exits 0 if all commits pass.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <base-sha> <head-sha>" >&2
  exit 1
fi

BASE="$1"
HEAD="$2"
RANGE="${BASE}..${HEAD}"

# Write commit list to a temp file so git log failure is caught by set -e.
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

git log --pretty=tformat:'%H%x09%ae%x09%ce' "${RANGE}" > "$TMPFILE"

FAILED=0

while IFS=$'\t' read -r hash author_email committer_email; do
  [[ -n "$hash" ]] || continue  # skip blank trailing line
  BAD=()

  # Empty email check
  if [[ -z "$author_email" ]]; then
    BAD+=("author email is empty")
  fi
  if [[ -z "$committer_email" ]]; then
    BAD+=("committer email is empty")
  fi

  # .local TLD check — anchored to end-of-host, case-insensitive.
  # Matches foo@bar.local but NOT dev@localmail.com.
  if [[ -n "$author_email" ]] && echo "$author_email" | grep -qiE '@[^@]+\.local$'; then
    BAD+=("author: ${author_email}")
  fi
  if [[ -n "$committer_email" ]] && echo "$committer_email" | grep -qiE '@[^@]+\.local$'; then
    BAD+=("committer: ${committer_email}")
  fi

  if [[ ${#BAD[@]} -gt 0 ]]; then
    echo "::error::Commit ${hash} has invalid git identity:"
    for b in "${BAD[@]}"; do
      echo "  - ${b}"
    done
    FAILED=1
  fi
done < "$TMPFILE"

if [[ "$FAILED" -eq 1 ]]; then
  echo ""
  echo "One or more commits in this PR have .local or empty email addresses."
  echo "This usually means git identity was not configured on the committing machine."
  echo ""
  echo "Fix with:"
  echo "  git config --global user.name  \"Your Name\""
  echo "  git config --global user.email \"your.real@email.com\""
  echo ""
  echo "Then rewrite the offending commits before re-pushing:"
  echo "  git rebase -i <parent-of-first-bad-commit>   # mark offending commits 'edit'"
  echo "  git commit --amend --reset-author             # rewrite with current identity"
  echo "  git rebase --continue"
  exit 1
fi

echo "Identity check passed: all commits in ${RANGE} have valid email addresses."
