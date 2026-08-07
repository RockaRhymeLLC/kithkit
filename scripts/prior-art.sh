#!/usr/bin/env bash
#
# scripts/prior-art.sh - mechanical prior-art sweep across the seven surfaces
# named in .claude/CLAUDE.md's Step-Zero check.
#
# WHY THIS EXISTS
#   Step Zero is nine manual instrument reads, remembered as a habit, run
#   correctly only when someone holds the whole list in their head. Two
#   measured defects show what happens when they don't (both re-measured on
#   this box while building this script):
#     - `GET /api/orchestrator/tasks` with no `?status=` returns 2074 rows;
#       summing all six statuses explicitly returns 2150 - 76 terminal rows
#       are invisible to the default call, broken down: completed 1916 ·
#       failed 156 · cancelled 77 · in_progress 1 · pending 0 · assigned 0.
#       A `cancelled` row is often the MOST valuable prior art - "we tried
#       this and stopped, and why" - and it is exactly what the default call
#       hides.
#     - 369 of 2017 todos (18%) have a NULL/empty `description` and carry
#       their entire content in the TITLE. A description-only grep misses
#       nearly a fifth of the corpus.
#     - scripts/check-migration-collisions.mjs already existed (114 lines,
#       unit-tested, CI-gating) when a todo was filed asking to build it,
#       because no standard prior-art surface looks inside scripts/ or
#       .claude/. The tool that finds duplicates was itself a duplicate
#       nobody's search reached.
#   This script makes those seven surfaces one mechanical, parallel sweep
#   instead of nine remembered steps.
#
# RELATIONSHIP TO EXISTING AUTOMATION - READ BEFORE ASSUMING THIS RUNS ITSELF
#   .claude/hooks/memory-context.py already runs on EVERY prompt (wired at
#   .claude/settings.json) and is the only prior-art-adjacent check that fires
#   without being invoked. As of this writing it searches daemon memory + a
#   curated wiki ONLY - zero references to todos, orchestrator_tasks, or GH.
#   Upstream kithkit#576 ("extend memory-context hook with ticket and report
#   prior-art") is MERGED there (+421 lines). Our copy does NOT have that
#   extension. Separately, todo #4094 (the review gate on #576) measured that
#   the *merged* version searches `/api/todos` only - ~40.9% of the corpus,
#   still blind to every orchestrator task.
#   THIS SCRIPT DOES NOT MODIFY memory-context.py AND DOES NOT FIX #576 -
#   both out of scope here. It exists so that whenever #576 is synced or
#   repaired, there is one correct, six-status, title+description search
#   implementation to converge onto, instead of a second guess.
#
# SITING - READ THIS BEFORE TRUSTING IT TO ENFORCE ANYTHING
#   This is a script in scripts/. IT RUNS ONLY WHEN AN AGENT OR HUMAN CHOOSES
#   TO INVOKE IT BY NAME. There is no hook, no CI step, and no daemon task
#   wired to call it - nothing enforces that Step Zero happened before an
#   escalation is filed. The only thing that runs unconditionally today is
#   memory-context.py, and (see above) it does not cover six of these seven
#   surfaces. An overstated guard is worse than a documented gap: this is a
#   manual instrument that makes the check fast and complete ONCE RUN, not a
#   gate that guarantees it WAS run.
#
# TARGET REPOS FOR SURFACE 1 (GH_REPOS) - RESOLUTION ORDER
#   This is a portable script with no install-specific default baked in.
#   GH_REPOS (the repos surface 1 searches) resolves in this order:
#     1. `PRIOR_ART_GH_REPOS` env var, if set - a comma- or space-separated
#        list of `owner/repo` pairs, e.g.
#        `PRIOR_ART_GH_REPOS="me/repo-a,me/repo-b" scripts/prior-art.sh term`.
#        Use this when a search should span more than one repo (e.g. a
#        private fork plus the public upstream it tracks).
#     2. Otherwise, derived from `git remote get-url origin` - parsed for a
#        `github.com` owner/repo, covering https, ssh, and git@ remote forms.
#        This is what fires on a fresh clone with no config and no env var:
#        one repo, whatever `origin` actually points at.
#     3. If neither yields a repo (no `origin`, or `origin` isn't GitHub),
#        surface 1 reports that no repo is configured and skips the `gh`
#        calls rather than failing the whole sweep.
#
# THE SEVEN SURFACES (numbered to match .claude/CLAUDE.md's Step-Zero list)
#   1. `gh issue list` + `gh pr list` equivalent, for each repo in GH_REPOS
#      (see TARGET REPOS above), ALL states - via `gh api search/issues`,
#      which already ANDs space-separated words and covers PRs by any author
#      (including our own open ones - there is no `is:open`/author filter
#      applied).
#   2. Todos - title AND description AND work_notes (local fetch + AND-of-words
#      match; the daemon has no todo full-text search endpoint). work_notes is
#      where the CURRENT instruction accumulates as a task proceeds - the
#      description is often the older, broader framing set at creation time.
#      A description-only search can hand back a stale framing while the
#      correct, narrower instruction sits unread in the same row's
#      work_notes (measured live on #3828, 2026-08-05).
#   3. Orchestrator tasks - the UNION of two instruments, deduped by task id:
#      (a) the bare `GET /api/orchestrator/tasks` call with no `?status=`,
#      and (b) all six documented statuses queried explicitly (pending,
#      assigned, in_progress, completed, failed, cancelled). NEITHER CALL IS
#      COMPLETE ALONE: a `?status=abandoned` (or any other undocumented
#      status value actually present in the data) returns HTTP 400, so the
#      six-status sweep cannot reach rows in that status - while the bare
#      call has been measured to omit 100% of `cancelled` rows outright.
#      Measured two-box: on one box the bare call returned 2132 tasks, the
#      six-status sweep 2210, union 2211 (79 rows reachable only via the
#      six-status sweep, 1 row reachable only via the bare call); an
#      independent measurement on a second box reproduced the same shape at
#      923 vs 984, a difference of exactly that box's 61 cancelled rows.
#      Where the two instruments disagree, this script prints the
#      disagreement rather than silently picking one. Matching is against
#      description AND result AND work_notes text. Same rationale as surface
#      2: work_notes is where the running task log accumulates and is even
#      more heavily populated here than on todos (measured 2026-08-05: 63%
#      of sampled completed/failed/cancelled rows have non-empty work_notes,
#      one record 61KB).
#   4. Daemon memory search (`POST /api/memory/search`, keyword mode).
#   5. `.kithkit/docs/` and `.kithkit/reports/` - filesystem grep (word-AND)
#      PLUS `git ls-files`, because these two directories mix tracked and
#      untracked files in a ratio that varies per box (measured here:
#      docs 9/12 tracked, reports 211/313 tracked) - neither instrument alone
#      sees the whole corpus. READ-ONLY: never writes, commits, moves, or
#      `git add`s anything under either directory.
#   6. `git log -S'<exact term>'` over the repo, printing commit BODIES, not
#      just subjects. NOTE: -S is a literal pickaxe match, so unlike surfaces
#      2/3/5/7 this one is NOT word-AND - a multi-word term must appear
#      adjacently (as typed) in an added/removed diff line to hit. That is
#      git's own semantics, kept as-is rather than reimplemented.
#   7. `scripts/` and `.claude/` - filesystem grep (word-AND), excluding
#      node_modules/dist/.git/worktree checkouts. This is the surface that
#      found check-migration-collisions.mjs when nothing else did; kept
#      distinct from surface 5 because tooling and docs live in different
#      parts of the repo for different reasons.
#
# MATCHING CONVENTION
#   A search term is one or more whitespace-separated words. A record matches
#   a term if ALL of its words appear (case-insensitive substring, matched
#   independently - not required to be adjacent) somewhere in the record's
#   searched fields - mirroring the daemon's own documented "multi-word
#   queries use AND matching" convention for /api/memory/search. Surfaces 1
#   (GitHub search) and 6 (git pickaxe) use their own native semantics
#   instead, and are called out above.
#
# DISPLAY CAPS AND TRUNCATION - READ BEFORE TRUSTING A "NO PRIOR ART" RESULT
#   Every surface reports an honest match COUNT against the full corpus, but
#   for readability only prints a capped list of matched records underneath
#   it. That cap used to be silent: a surface could report "matched: 58" and
#   then print 15 rows with no indication that 43 were withheld. Measured
#   cost, the same night this was found: a broad term matched 58 records,
#   printed 15, and dropped the one that was the decisive prior art -
#   producing a false "no prior art exists" conclusion. The dangerous
#   property is that a BROADER term matches MORE and therefore silently
#   drops MORE - the tool degraded exactly when it was searched harder.
#   Fix: every surface that caps its printed list now prints an explicit
#   `showing N of M` line whenever the real match count M exceeds the
#   display cap N. The cap itself is controlled by `PRIOR_ART_LIMIT` (an
#   integer, default 15) or the `--all` flag (equivalent to an unlimited
#   cap for this invocation). Use `--all` or a raised `PRIOR_ART_LIMIT` any
#   time a "no prior art" conclusion actually matters.
#
#   THERE ARE TWO SEPARATE LOSSES, AND --all ONLY RECOVERS ONE OF THEM. On
#   surface 1 (gh issues/PRs), `gh api search/issues` returns one page of
#   results (GitHub's default, 30 items) per call, REGARDLESS of DISPLAY_LIMIT
#   - a term matching 71 PRs still only has 30 of them in hand before display
#   truncation is even applied. `--all`/`PRIOR_ART_LIMIT` raise how many of
#   the FETCHED rows are printed; they cannot raise how many rows were
#   fetched, because that page was already the only page requested. Measured:
#   `--all` on a term matching 71 PRs printed all 30 fetched and said nothing
#   about the other 41 - the fetch loss produced total silence because the
#   old notice fired only on display truncation (`fetched > shown`), and
#   `--all` makes that condition false while the fetch loss is still present.
#   Fixed: surface 1 now discloses `fetched < matched` unconditionally, in
#   both default and `--all` modes, distinct from the `shown < fetched`
#   display notice - they are different failures with different remedies (one
#   is fixed by `--all`, the other is not fixed by anything short of paginating
#   the GitHub call, which this script does not do to avoid its separate
#   30 req/min search rate limit).
#   The other six surfaces were audited for the same shape and are NOT
#   affected today: surfaces 2/3/4 ask the daemon for up to FETCH_LIMIT/
#   MEMORY_FETCH_LIMIT rows, but as of this writing `/api/todos`,
#   `/api/orchestrator/tasks`, and `/api/memory/search` (keyword mode) all
#   ignore the `limit` parameter entirely and return their complete result
#   set regardless of what's requested (verified against the live daemon:
#   limit=1 and limit=5000 returned the same row count on all three) - so
#   TOTAL/MATCHED on those surfaces is a true corpus count today, not a
#   fetch-capped one. That is a property of the current daemon, not a
#   guarantee of this script; surfaces 5/6/7 have no fetch step at all
#   (grep and `git log` return every match with no page size), so they were
#   never exposed to this class of loss.
#
# READ-ONLY GUARANTEE
#   Reads only: `curl` GETs/POSTs to the local daemon API, `gh api`/`gh repo
#   view` (read endpoints), `git log`/`git ls-files`/`git rev-parse` (no
#   fetch), and `grep`/`find` over the working tree. It NEVER writes,
#   commits, pushes, restarts the daemon, or modifies anything under
#   .kithkit/docs or .kithkit/reports.
#
# EXIT CODES
#   0  the sweep ran to completion (a term with no hits anywhere is a valid,
#      reportable result, not a failure)
#   2  usage error, or a hard precondition failed (not a git repo)
#
# Usage: scripts/prior-art.sh [--all] <term> [term2 ...]
#   Each argument is one independent term, quoted if it has multiple words,
#   e.g.: scripts/prior-art.sh "migration collision" "cancelled prior art"
#   --all disables per-surface display caps for this run (see DISPLAY CAPS
#   above); PRIOR_ART_LIMIT=<n> raises/lowers the cap instead of disabling it.

set -uo pipefail

DAEMON_URL="${DAEMON_URL:-http://localhost:3847}"
ORCH_STATUSES=(pending assigned in_progress completed failed cancelled)
FETCH_LIMIT=5000
MEMORY_FETCH_LIMIT="${PRIOR_ART_MEMORY_FETCH_LIMIT:-200}"

SHOW_ALL=0
if [[ "${1:-}" == "--all" ]]; then
  SHOW_ALL=1
  shift
fi
if [[ "$SHOW_ALL" -eq 1 ]]; then
  DISPLAY_LIMIT=999999999
else
  DISPLAY_LIMIT="${PRIOR_ART_LIMIT:-15}"
fi
export DISPLAY_LIMIT

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [--all] <term> [term2 ...]" >&2
  echo "  e.g.: $0 \"migration collision\"" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "FATAL: not inside a git repository" >&2; exit 2; }
cd "$REPO_ROOT" || exit 2

# ── resolve GH_REPOS: env override, else derive from the `origin` remote ────
GH_REPOS=()
if [[ -n "${PRIOR_ART_GH_REPOS:-}" ]]; then
  IFS=', ' read -r -a GH_REPOS <<< "${PRIOR_ART_GH_REPOS}"
else
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  origin_stripped="${origin_url%.git}"
  if [[ "$origin_stripped" =~ github\.com[:/]([^/[:space:]]+/[^/[:space:]]+)$ ]]; then
    GH_REPOS=("${BASH_REMATCH[1]}")
  fi
fi

hdr() { printf '\n── %s\n' "$1"; }

# ── shared JSON word-AND matcher ─────────────────────────────────────────────
# stdin: a JSON array of records (or {"data": [...]}). argv: <comma-separated
# fields to search> <word1> [word2 ...]. Prints TOTAL, MATCHED, then up to
# $DISPLAY_LIMIT matched records as "  #<id> [<status>] <title>", with an
# explicit "showing N of M" line whenever the cap actually truncates.
json_word_and_match() {
  python3 -c '
import json, os, sys
fields = sys.argv[1].split(",")
words = [w.lower() for w in sys.argv[2:]]
limit = int(os.environ.get("DISPLAY_LIMIT", "15"))
raw = json.load(sys.stdin)
records = raw.get("data", []) if isinstance(raw, dict) else raw
total = len(records)
matched = []
for r in records:
    blob = " ".join(str(r.get(f) or "") for f in fields).lower()
    if all(w in blob for w in words):
        matched.append(r)
print(f"TOTAL {total}")
print(f"MATCHED {len(matched)}")
shown = matched[:limit]
for r in shown:
    ident = r.get("id", r.get("_int_id", "?"))
    title = (r.get("title") or "").replace("\n", " ").strip()[:90]
    status = r.get("status", "")
    print(f"  #{ident} [{status}] {title}")
if len(matched) > len(shown):
    print(f"  showing {len(shown)} of {len(matched)} (PRIOR_ART_LIMIT or --all to see the rest)")
' "$@"
}

# ── per-surface worker functions - each writes its own report to $1 (a file) ─

surface_gh() {
  local out="$1"; shift
  local words=("$@")
  local query="${words[*]}"

  if [[ "${#GH_REPOS[@]}" -eq 0 ]]; then
    {
      echo "Surface 1 - gh issues/PRs (GitHub-native AND/search semantics)"
      echo "  no repo configured - set PRIOR_ART_GH_REPOS or add a github.com 'origin' remote"
    } > "$out" 2>&1
    return
  fi

  local gt
  gt="$(mktemp -d)"
  # Fire every gh api call for every repo concurrently - gh api search is the
  # single slowest instrument here (network round-trip per call); running the
  # 4 calls-per-repo serially is what pushed a 2-repo sweep past 7s.
  local i=0
  local -a repo_of_idx
  for repo in "${GH_REPOS[@]}"; do
    gh api -X GET search/issues -f q="repo:$repo is:issue" --jq '.total_count' > "$gt/$i.issue_total" 2>/dev/null &
    gh api -X GET search/issues -f q="repo:$repo is:pr" --jq '.total_count' > "$gt/$i.pr_total" 2>/dev/null &
    gh api -X GET search/issues -f q="repo:$repo is:issue $query" --jq '.total_count' > "$gt/$i.issue_hits" 2>/dev/null &
    gh api -X GET search/issues -f q="repo:$repo is:issue $query" --jq '.items[] | "    #\(.number) [\(.state)] \(.title)"' > "$gt/$i.issue_lines" 2>/dev/null &
    gh api -X GET search/issues -f q="repo:$repo is:pr $query" --jq '.total_count' > "$gt/$i.pr_hits" 2>/dev/null &
    gh api -X GET search/issues -f q="repo:$repo is:pr $query" --jq '.items[] | "    #\(.number) [\(.state)] \(.title)"' > "$gt/$i.pr_lines" 2>/dev/null &
    repo_of_idx[i]="$repo"
    i=$((i+1))
  done
  wait

  # GitHub's search endpoint has its own, much tighter rate limit (30 req/min,
  # separate from core API limits). A tripped limit returns a 403 JSON error
  # body on stdout, not empty - printing that raw would masquerade as a count.
  # Validate every reading is an integer before trusting it as one.
  numeric_or_err() {
    local v; v="$(cat "$1" 2>/dev/null)"
    [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo "ERR(non-numeric response - likely GH search rate limit, 30/min)"
  }

  # Two INDEPENDENT losses can happen between "matched" and what's on screen,
  # and --all/PRIOR_ART_LIMIT only ever recovers one of them:
  #   (a) FETCH loss - the `gh api search/issues` call above returns one page
  #       (GitHub's default, 30 items); $gt/$j.issue_lines and $gt/$j.pr_lines
  #       never hold more than that no matter how high DISPLAY_LIMIT goes -
  #       those rows were never retrieved, and --all cannot recover them.
  #   (b) DISPLAY loss - of whatever WAS fetched, only DISPLAY_LIMIT lines are
  #       printed below; --all/PRIOR_ART_LIMIT controls this one.
  # Report both, and say which is which - `matched` is 1's true count from
  # search/issues, `fetched` is what actually landed in the temp file (the
  # ceiling --all can reach), `shown` is what's printed.
  gh_truncation_notice() {
    local matched="$1" fetched="$2" shown="$3"
    local unfetched=$((matched - fetched))
    local unshown=$((fetched - shown))
    if [[ "$unfetched" -gt 0 && "$unshown" -gt 0 ]]; then
      echo "    showing $shown of $fetched fetched; $matched matched, so $unfetched were never retrieved (GitHub search page cap) - PRIOR_ART_LIMIT or --all raises the display cap but CANNOT recover the unfetched rows"
    elif [[ "$unshown" -gt 0 ]]; then
      echo "    showing $shown of $fetched fetched (matched: $matched) - PRIOR_ART_LIMIT or --all to see the rest"
    elif [[ "$unfetched" -gt 0 ]]; then
      echo "    $fetched fetched; $matched matched, so $unfetched were never retrieved (GitHub search page cap) - PRIOR_ART_LIMIT or --all raises the display cap but CANNOT recover the unfetched rows"
    fi
  }

  {
    echo "Surface 1 - gh issues/PRs, all configured repos, all states (GitHub-native AND/search semantics)"
    for ((j=0; j<${#repo_of_idx[@]}; j++)); do
      local repo="${repo_of_idx[$j]}"
      local issue_total pr_total issue_hits pr_hits
      issue_total="$(numeric_or_err "$gt/$j.issue_total")"
      pr_total="$(numeric_or_err "$gt/$j.pr_total")"
      issue_hits="$(numeric_or_err "$gt/$j.issue_hits")"
      pr_hits="$(numeric_or_err "$gt/$j.pr_hits")"
      echo "  $repo - issues searched: $issue_total  matched: $issue_hits"
      if [[ "$issue_hits" =~ ^[1-9] ]]; then
        head -n "$DISPLAY_LIMIT" "$gt/$j.issue_lines" 2>/dev/null
        local issue_lines_n issue_shown_n
        issue_lines_n="$(wc -l < "$gt/$j.issue_lines" 2>/dev/null | tr -d ' ')"
        issue_lines_n="${issue_lines_n:-0}"
        if [[ "$issue_lines_n" -lt "$DISPLAY_LIMIT" ]]; then
          issue_shown_n="$issue_lines_n"
        else
          issue_shown_n="$DISPLAY_LIMIT"
        fi
        gh_truncation_notice "$issue_hits" "$issue_lines_n" "$issue_shown_n"
      fi
      echo "  $repo - PRs    searched: $pr_total  matched: $pr_hits"
      if [[ "$pr_hits" =~ ^[1-9] ]]; then
        head -n "$DISPLAY_LIMIT" "$gt/$j.pr_lines" 2>/dev/null
        local pr_lines_n pr_shown_n
        pr_lines_n="$(wc -l < "$gt/$j.pr_lines" 2>/dev/null | tr -d ' ')"
        pr_lines_n="${pr_lines_n:-0}"
        if [[ "$pr_lines_n" -lt "$DISPLAY_LIMIT" ]]; then
          pr_shown_n="$pr_lines_n"
        else
          pr_shown_n="$DISPLAY_LIMIT"
        fi
        gh_truncation_notice "$pr_hits" "$pr_lines_n" "$pr_shown_n"
      fi
    done
  } > "$out" 2>&1
  rm -rf "$gt"
}

surface_todos() {
  local out="$1"; shift
  {
    echo "Surface 2 - todos (title AND description AND work_notes, all three fields matched)"
    local json
    json="$(curl -s --max-time 10 "$DAEMON_URL/api/todos?limit=$FETCH_LIMIT")"
    if [[ -z "$json" ]]; then
      echo "  UNREACHABLE - no response from $DAEMON_URL/api/todos"
    else
      echo "$json" | json_word_and_match "title,description,work_notes" "$@" | sed 's/^TOTAL/  searched:/; s/^MATCHED/  matched: /'
    fi
  } > "$out" 2>&1
}

surface_orchestrator() {
  local out="$1"; shift
  {
    echo "Surface 3 - orchestrator tasks, UNION of the bare call and all six explicit statuses (description AND result AND work_notes matched)"
    # NOTE: payloads are passed between python3 invocations via TEMP FILES, never
    # via argv. The `completed` status alone runs ~10.8MB on this box - far past
    # ARG_MAX (1,048,576 bytes here). Passing that through "$@" fails with
    # "Argument list too long" silently if stderr is swallowed; a file path is a
    # few bytes regardless of payload size, so this is the only safe channel.

    # bare call - no ?status= - measured to omit 100% of `cancelled` rows.
    local bare_file
    bare_file="$(mktemp)"
    curl -s --max-time 10 "$DAEMON_URL/api/orchestrator/tasks?limit=$FETCH_LIMIT" > "$bare_file"
    local bare_n
    bare_n="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("data",[])))' < "$bare_file" 2>/dev/null)"
    echo "  bare call (no ?status=) searched: ${bare_n:-ERR}"

    # six-status sweep - misses any status value outside this list
    # (e.g. `abandoned`, which 400s on ?status= but exists in real data).
    local combined_file
    combined_file="$(mktemp)"
    echo "[]" > "$combined_file"
    local sum_n=0
    local accumulation_ok=1
    for status in "${ORCH_STATUSES[@]}"; do
      local status_file n
      status_file="$(mktemp)"
      curl -s --max-time 10 "$DAEMON_URL/api/orchestrator/tasks?status=$status&limit=$FETCH_LIMIT" > "$status_file"
      n="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("data",[])))' < "$status_file" 2>/dev/null)"
      echo "  status=$status searched: ${n:-ERR}"
      if [[ "$n" =~ ^[0-9]+$ ]]; then
        sum_n=$((sum_n + n))
      else
        accumulation_ok=0
      fi

      local new_combined_file
      new_combined_file="$(mktemp)"
      if python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    a = json.load(f)
with open(sys.argv[2]) as f:
    b = json.load(f).get("data", [])
with open(sys.argv[3], "w") as f:
    json.dump(a + b, f)
' "$combined_file" "$status_file" "$new_combined_file" 2>/dev/null; then
        mv "$new_combined_file" "$combined_file"
      else
        # LOUD, not silent: a swallowed failure here is exactly what made the
        # original bug invisible - combined kept its stale pre-failure value
        # and the script reported a count that looked authoritative but wasn't.
        echo "  ERR: accumulation FAILED for status=$status - combined corpus is now INCOMPLETE"
        accumulation_ok=0
        rm -f "$new_combined_file"
      fi
      rm -f "$status_file"
    done

    local total_n
    total_n="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$combined_file" 2>/dev/null)"

    if [[ "$accumulation_ok" -eq 0 ]] || [[ "$total_n" != "$sum_n" ]]; then
      echo "  WARNING: INVARIANT VIOLATED - combined corpus has $total_n records but the six per-status counts sum to $sum_n. Results below are PARTIAL and UNRELIABLE."
    fi
    echo "  six-status sweep (sum of six explicit statuses) searched: $total_n"

    # union of bare + six-status, deduped by task id, with explicit
    # disagreement reporting - this is the fix for the measured defect
    # where neither single instrument sees the full corpus.
    local union_file union_records_file
    union_file="$(mktemp)"
    union_records_file="$(mktemp)"
    python3 -c '
import json, sys

def ident(r):
    return r.get("id", r.get("_int_id"))

bare = json.load(open(sys.argv[1])).get("data", [])
six = json.load(open(sys.argv[2]))

bare_ids = {ident(r) for r in bare}
six_ids = {ident(r) for r in six}

union = {}
for r in bare + six:
    union[ident(r)] = r

only_bare = bare_ids - six_ids
only_six = six_ids - bare_ids

with open(sys.argv[3], "w") as f:
    json.dump({
        "bare_n": len(bare_ids),
        "six_n": len(six_ids),
        "union_n": len(union),
        "only_bare_n": len(only_bare),
        "only_six_n": len(only_six),
    }, f)

with open(sys.argv[4], "w") as f:
    json.dump(list(union.values()), f)
' "$bare_file" "$combined_file" "$union_file" "$union_records_file"

    local stats_line
    stats_line="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["bare_n"], d["six_n"], d["union_n"], d["only_bare_n"], d["only_six_n"])' "$union_file")"
    read -r u_bare_n u_six_n u_union_n u_only_bare_n u_only_six_n <<< "$stats_line"

    echo "  union (dedup by id) searched: $u_union_n"
    if [[ "$u_bare_n" != "$u_union_n" || "$u_six_n" != "$u_union_n" ]]; then
      echo "  DISAGREEMENT: bare $u_bare_n - six-status $u_six_n - union $u_union_n - $u_only_six_n rows reachable only via the six-status sweep, $u_only_bare_n rows reachable only via the bare call"
    fi

    json_word_and_match "title,description,result,work_notes" "$@" < "$union_records_file" | grep -v '^TOTAL' | sed 's/^MATCHED/  matched:/'

    rm -f "$bare_file" "$combined_file" "$union_file" "$union_records_file"
  } > "$out" 2>&1
}

surface_memory() {
  local out="$1"; shift
  local query="$*"
  {
    # keyword mode, not hybrid: hybrid is a nearest-neighbour vector search and
    # ALWAYS returns its top-K, even for a term with zero real relevance (a
    # nonsense negative-control term returned 15 "hits" under hybrid - measured
    # while building this script). keyword mode does true AND-of-words text
    # matching and returns a genuine zero, which is what a discriminating
    # negative control requires and matches this script's own AND convention.
    echo "Surface 4 - daemon memory search (keyword mode - AND-of-words text match, not vector nearest-neighbour; total corpus size is not exposed by this endpoint, so only the returned/matched count is reportable)"
    local payload resp n
    payload="$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1], "mode": "keyword", "limit": int(sys.argv[2])}))' "$query" "$MEMORY_FETCH_LIMIT")"
    resp="$(curl -s --max-time 10 -X POST "$DAEMON_URL/api/memory/search" -H "Content-Type: application/json" -d "$payload")"
    if [[ -z "$resp" ]]; then
      echo "  UNREACHABLE - no response from $DAEMON_URL/api/memory/search"
    else
      n="$(echo "$resp" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))' 2>/dev/null)"
      echo "  query: \"$query\"  returned: ${n:-ERR}"
      echo "$resp" | python3 -c '
import json, os, sys
limit = int(os.environ.get("DISPLAY_LIMIT", "15"))
data = json.load(sys.stdin).get("data", [])
shown = data[:limit]
for m in shown:
    content = (m.get("content") or "").replace(chr(10), " ").strip()[:100]
    cat = m.get("category") or m.get("type") or ""
    print("    [" + str(cat) + "] " + content)
if len(data) > len(shown):
    print(f"    showing {len(shown)} of {len(data)} (PRIOR_ART_LIMIT or --all to see the rest)")
' 2>/dev/null
    fi
  } > "$out" 2>&1
}

# word-AND grep over a directory: intersect per-word file-match sets.
grep_word_and_dir() {
  local dir="$1"; shift
  local words=("$@")
  [[ -d "$dir" ]] || { echo ""; return; }
  local acc=""
  local first=1
  for w in "${words[@]}"; do
    local hits
    hits="$(grep -rIl -i --exclude-dir='.git' -- "$w" "$dir" 2>/dev/null | sort -u)"
    if [[ $first -eq 1 ]]; then
      acc="$hits"
      first=0
    else
      acc="$(comm -12 <(echo "$acc") <(echo "$hits"))"
    fi
  done
  echo "$acc"
}

surface_docs_reports() {
  local out="$1"; shift
  {
    echo "Surface 5 - .kithkit/docs/ and .kithkit/reports/ (filesystem grep, word-AND, PLUS git ls-files - read-only, tracked+untracked mix)"
    for d in ".kithkit/docs" ".kithkit/reports"; do
      local total tracked matches n
      total="$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' ')"
      tracked="$(git ls-files -- "$d" 2>/dev/null | wc -l | tr -d ' ')"
      matches="$(grep_word_and_dir "$d" "$@")"
      n="$(printf '%s\n' "$matches" | grep -c '[^[:space:]]' || true)"
      echo "  $d - files on disk: $total  (tracked via git: $tracked, untracked: $((total - tracked)))  word-AND matches: $n"
      if [[ "$n" -gt 0 ]]; then
        printf '%s\n' "$matches" | head -n "$DISPLAY_LIMIT" | while read -r f; do [[ -n "$f" ]] && echo "    $f"; done
        if [[ "$n" -gt "$DISPLAY_LIMIT" ]]; then
          echo "    showing $DISPLAY_LIMIT of $n (PRIOR_ART_LIMIT or --all to see the rest)"
        fi
      fi
    done
  } > "$out" 2>&1
}

surface_git_pickaxe() {
  local out="$1"; shift
  local term="$*"
  {
    echo "Surface 6 - git log -S'<exact term>' (literal pickaxe, NOT word-AND - see header note)"
    local hits
    hits="$(git log --all -S"$term" --pretty=format:'%h %ad %s' --date=short -- . 2>/dev/null)"
    local n
    n="$(printf '%s\n' "$hits" | grep -c '[^[:space:]]' || true)"
    echo "  commits touching a diff containing \"$term\" literally: $n"
    if [[ "$n" -gt 0 ]]; then
      printf '%s\n' "$hits" | head -n "$DISPLAY_LIMIT" | sed 's/^/    /'
      if [[ "$n" -gt "$DISPLAY_LIMIT" ]]; then
        echo "    showing $DISPLAY_LIMIT of $n (PRIOR_ART_LIMIT or --all to see the rest)"
      fi
      echo "  --- bodies (first 3) ---"
      git log --all -S"$term" -3 --format='  commit %h - %s%n%b%n---' -- . 2>/dev/null | sed 's/^/    /'
    fi
  } > "$out" 2>&1
}

surface_scripts_claude() {
  local out="$1"; shift
  {
    echo "Surface 7 - scripts/ and .claude/ (filesystem grep, word-AND - this is the surface that found check-migration-collisions.mjs)"
    for d in "scripts" ".claude"; do
      local total matches n
      total="$(find "$d" -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/worktrees/*' 2>/dev/null | wc -l | tr -d ' ')"
      matches="$(python3 - "$d" "$@" <<'PY'
import sys, subprocess
d = sys.argv[1]
words = sys.argv[2:]
result = None
for w in words:
    out = subprocess.run(
        ["grep", "-rIl", "-i", "--exclude-dir=.git", "--exclude-dir=node_modules",
         "--exclude-dir=dist", "--exclude-dir=worktrees", "--", w, d],
        capture_output=True, text=True
    ).stdout.splitlines()
    s = set(out)
    result = s if result is None else (result & s)
for f in sorted(result or []):
    print(f)
PY
)"
      n="$(printf '%s\n' "$matches" | grep -c '[^[:space:]]' || true)"
      echo "  $d - files: $total  word-AND matches: $n"
      if [[ "$n" -gt 0 ]]; then
        printf '%s\n' "$matches" | head -n "$DISPLAY_LIMIT" | while read -r f; do [[ -n "$f" ]] && echo "    $f"; done
        if [[ "$n" -gt "$DISPLAY_LIMIT" ]]; then
          echo "    showing $DISPLAY_LIMIT of $n (PRIOR_ART_LIMIT or --all to see the rest)"
        fi
      fi
    done
  } > "$out" 2>&1
}

# ── run all seven surfaces per term, in parallel ─────────────────────────────

for TERM in "$@"; do
  read -r -a WORDS <<< "$TERM"

  T=$(mktemp -d)
  surface_gh              "$T/1" "${WORDS[@]}" &
  surface_todos           "$T/2" "${WORDS[@]}" &
  surface_orchestrator    "$T/3" "${WORDS[@]}" &
  surface_memory          "$T/4" "${WORDS[@]}" &
  surface_docs_reports    "$T/5" "${WORDS[@]}" &
  surface_git_pickaxe     "$T/6" "$TERM"       &
  surface_scripts_claude  "$T/7" "${WORDS[@]}" &
  wait

  printf '\n════════════════════════════════════════════════════════════\n'
  printf 'TERM: "%s"\n' "$TERM"
  printf '════════════════════════════════════════════════════════════\n'
  for i in 1 2 3 4 5 6 7; do
    hdr "$(head -1 "$T/$i" 2>/dev/null)"
    tail -n +2 "$T/$i" 2>/dev/null
  done
  rm -rf "$T"
done

exit 0
