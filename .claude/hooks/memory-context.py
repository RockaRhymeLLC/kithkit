#!/usr/bin/env python3
"""
UserPromptSubmit Hook: Memory-assisted context injection

Extracts keywords from user input, does a fast keyword search against
the daemon memory API, and injects 2-3 brief memory hints into context.
Also surfaces prior-art tickets (todos/tasks) and local report files
so that completed work and filed issues reach the model automatically.

Skips short/generic inputs (<10 chars). Keyword-only for speed.
"""

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request

DAEMON_URL = "http://localhost:3847/api/memory/search"
WIKI_URL = "http://localhost:3847/api/wiki/search"
TODOS_URL = "http://localhost:3847/api/todos"
MAX_HITS = 3
MAX_CHARS_PER_HIT = 100
WIKI_SUMMARY_CHARS = 120
MIN_INPUT_LENGTH = 10
MAX_TICKETS = 3          # cap on prior-art ticket hits
MAX_REPORTS = 2          # cap on prior-art report file hits
TICKET_TIMEOUT = 1.5     # seconds — hard ceiling for the todos HTTP fetch
TODO_CACHE_TTL = 300     # seconds (5 min) — how long the cached ticket list is fresh
REPORT_SCAN_BYTES = 512  # first N bytes of each report file scanned for keywords

# Report directories relative to CLAUDE_PROJECT_DIR (resolved at runtime).
# .kithkit/state is deliberately excluded — it is ephemeral agent state, not
# finished-work prior art.  .kithkit/docs is included only when present.
REPORT_DIRS = [
    ".kithkit/reports",
    "docs/retros",
    ".kithkit/docs",
]

# Common stopwords to strip before searching
STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must",
    "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
    "they", "them", "their", "its", "this", "that", "these", "those",
    "what", "which", "who", "whom", "how", "when", "where", "why",
    "if", "then", "else", "so", "but", "and", "or", "not", "no", "yes",
    "ok", "okay", "sure", "thanks", "thank", "please", "just", "also",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "up",
    "about", "into", "through", "during", "before", "after", "above",
    "below", "between", "out", "off", "over", "under", "again",
    "there", "here", "all", "each", "every", "both", "few", "more",
    "most", "other", "some", "such", "only", "own", "same", "than",
    "too", "very", "any", "let", "get", "got", "go", "going", "make",
    "know", "think", "see", "look", "want", "tell", "use", "find",
    "give", "take", "come", "thing", "things", "something",
    "hey", "hi", "hello", "yo", "sup", "yeah", "yep", "nah", "nope",
})

# Patterns to skip entirely (system/agent messages, slash commands)
# NOTE: Do NOT skip [Telegram] — those are real user messages that need memory recall
SKIP_PATTERNS = [
    r"^\[System\]",       # System notifications
    r"^\[timer\]",        # Timer fires
    r"^\[email-triage\]", # Email triage results
    r"^\[task ",          # Task completed/failed notifications
    r"^\[result\]",       # Orchestrator/daemon results
    r"^\[worker ",        # Worker status notifications
    r"^\[Agent\]",        # A2A agent messages
    r"^/",                # Slash commands
    r"^Session ",         # Session lifecycle
]

# Strip all leading [bracket] metadata segments (timestamps, channel tags, etc.)
# then strip the optional "Username: " prefix that follows them.
# Handles formats like:
#   [8:40 AM] [Telegram] Dave: message
#   [Telegram] Dave: message
#   [3rdParty][Telegram] Name: message
# Only strips "Word:" if at least one [bracket] block preceded it,
# so plain messages starting with "Note: ..." are not truncated.
METADATA_PREFIX = re.compile(r"^(?:\[[^\]]*\]\s*)+(?:\w+:\s*)?")


def extract_keywords(text: str) -> list[str]:
    """Strip stopwords and punctuation, return meaningful terms as a list."""
    # Remove markdown formatting, URLs, code blocks
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"`[^`]*`", "", text)
    text = re.sub(r"[^\w\s-]", " ", text)

    words = text.lower().split()
    keywords = [w for w in words if w not in STOPWORDS and len(w) > 1]

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for w in keywords:
        if w not in seen:
            seen.add(w)
            unique.append(w)

    # Cap at 8 keywords to keep the search focused
    return unique[:8]


def search_memories(keywords: list[str]) -> list:
    """Fast keyword search against daemon memory API.

    AND matching can be too strict, so we try progressively fewer keywords
    until we get results: all keywords, then first 3, then first 2.
    """
    attempts = [keywords]
    if len(keywords) > 3:
        attempts.append(keywords[:3])
    if len(keywords) > 2:
        attempts.append(keywords[:2])

    for kw_subset in attempts:
        query = " ".join(kw_subset)
        payload = json.dumps({
            "mode": "hybrid",
            "query": query,
            "limit": MAX_HITS,
        }).encode()

        req = urllib.request.Request(
            DAEMON_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read())
                results = data.get("data", [])
                if results:
                    return results[:MAX_HITS]
        except Exception:
            return []

    return []


def format_hint(memory: dict) -> str:
    """Format a single memory hit as a brief hint."""
    content = memory.get("content", "")
    # Collapse to single line
    content = content.replace("\n", " ").strip()
    # Truncate
    if len(content) > MAX_CHARS_PER_HIT:
        content = content[:MAX_CHARS_PER_HIT].rsplit(" ", 1)[0] + "…"
    category = memory.get("category", "")
    origin = memory.get("origin_agent") or None
    if category and origin:
        prefix = f"[{category}, from: {origin}] "
    elif category:
        prefix = f"[{category}] "
    else:
        prefix = ""
    return f"  - {prefix}{content}"


def search_wiki(keywords: list[str]) -> list:
    """Search wiki articles — top-1 result only.

    Uses the same progressive keyword narrowing as search_memories.
    Returns empty list on any failure (graceful degradation — must never
    block memory hints or the prompt itself).
    """
    attempts = [keywords]
    if len(keywords) > 3:
        attempts.append(keywords[:3])
    if len(keywords) > 2:
        attempts.append(keywords[:2])

    for kw_subset in attempts:
        query = " ".join(kw_subset)
        payload = json.dumps({
            "query": query,
            "limit": 1,
        }).encode()

        req = urllib.request.Request(
            WIKI_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                data = json.loads(resp.read())
                results = data.get("data", [])
                if results:
                    return results[:1]
        except Exception:
            return []

    return []


def format_wiki_hint(article: dict) -> str:
    """Format a wiki article as a brief hint line."""
    title = article.get("title", article.get("slug", ""))
    summary = article.get("summary") or ""
    summary = summary.replace("\n", " ").strip()
    if len(summary) > WIKI_SUMMARY_CHARS:
        summary = summary[:WIKI_SUMMARY_CHARS].rsplit(" ", 1)[0] + "…"
    category = article.get("category") or ""
    slug = article.get("slug", "")
    cat_prefix = f"[{category}] " if category else ""
    hint = f"  - {cat_prefix}{title}"
    if summary:
        hint += f": {summary}"
    if slug:
        hint += f"\n    (slug: {slug} — full body via GET /api/wiki/articles?slug={slug})"
    return hint


# ── Ticket prior-art (todos/tasks) ────────────────────────────────────────────

def _todo_cache_path(project_dir: str) -> str:
    """Per-project temp file for the cached ticket list."""
    h = hashlib.md5(project_dir.encode()).hexdigest()[:8]
    return os.path.join(tempfile.gettempdir(), f"kkit-todo-cache-{h}.json")


def _load_todos(project_dir: str) -> tuple[list, str | None]:
    """Load todos from cache or HTTP.  Returns (todos, err_msg).

    err_msg is None on success; a short string on failure.
    An empty list with err_msg=None means the fetch succeeded but returned
    no records — which is a clean-empty state, not UNDETERMINED.
    """
    cache = _todo_cache_path(project_dir)
    todos = None

    # Try the on-disk cache first
    try:
        if time.time() - os.path.getmtime(cache) < TODO_CACHE_TTL:
            with open(cache) as f:
                todos = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        pass  # cache absent or corrupt — fall through to HTTP fetch

    if todos is None:
        try:
            req = urllib.request.Request(TODOS_URL)
            with urllib.request.urlopen(req, timeout=TICKET_TIMEOUT) as resp:
                data = json.loads(resp.read())
                todos = data.get("data") or []
            # Persist to cache (best-effort; failure is non-fatal)
            try:
                with open(cache, "w") as f:
                    json.dump(todos, f)
            except OSError:
                pass
        except urllib.error.HTTPError as e:
            return [], f"HTTP {e.code}"
        except urllib.error.URLError as e:
            reason = str(getattr(e, "reason", e))[:50]
            return [], f"connection failed: {reason}"
        except TimeoutError:
            return [], "timeout"
        except json.JSONDecodeError:
            return [], "bad response"
        except Exception as e:
            return [], type(e).__name__

    return todos, None


def _score_ticket(ticket: dict, kw_set: set[str]) -> int:
    """Weighted keyword score: title match = 2pts, desc/notes snippet = 1pt."""
    title = (ticket.get("title") or "").lower()
    # First 300 chars of description + work_notes covers the topic summary
    # without pulling in entire 18k-char work logs.
    snippet = (
        (ticket.get("description") or "") + " " + (ticket.get("work_notes") or "")
    )[:300].lower()
    score = 0
    for kw in kw_set:
        if kw in title:
            score += 2
        if kw in snippet:
            score += 1
    return score


def search_tickets(keywords: list[str], project_dir: str) -> tuple[list, str | None]:
    """Match keywords against ALL todos/tasks (no status filter).

    Returns (results, err_msg).  All statuses and both kinds (todo/orchestrator)
    are included — a completed ticket is often the most informative prior art.
    Ranked by weighted score (title×2, desc/notes×1), then by id descending
    so that newer tickets break ties.
    """
    todos, err = _load_todos(project_dir)
    if err:
        return [], err

    kw_set = set(keywords)
    scored = [(_score_ticket(t, kw_set), t) for t in todos]
    matched = sorted(
        [(s, t) for s, t in scored if s > 0],
        key=lambda x: (-x[0], -(x[1].get("id") or 0)),
    )
    return [t for _, t in matched[:MAX_TICKETS]], None


def format_ticket_hint(ticket: dict) -> str:
    """Format one ticket as a brief hint line."""
    tid = ticket.get("id", "?")
    status = (ticket.get("status") or "unknown")
    title = (ticket.get("title") or "").replace("\n", " ").strip()
    if len(title) > 100:
        title = title[:100].rsplit(" ", 1)[0] + "…"
    return f"  - #{tid} [{status}] {title}"


# ── Report / retro file prior-art ─────────────────────────────────────────────

def search_reports(keywords: list[str], project_dir: str) -> tuple[list, str | None]:
    """Scan report directories for files relevant to the current keywords.

    Strategy: filename words (×2) + first 512 bytes of content (×1).
    This is cheap (~0.2ms for 18 files) and avoids full-content grep.
    Missing directories are clean-empty, not errors.
    Returns (results, err_msg) where results is a list of (rel_path, abs_path).
    """
    kw_set = set(keywords)
    all_files: list[tuple[str, str]] = []  # (rel_path, abs_path)

    for rel_dir in REPORT_DIRS:
        abs_dir = os.path.join(project_dir, rel_dir)
        try:
            entries = os.listdir(abs_dir)
        except FileNotFoundError:
            continue  # absent directory = clean empty, not an error
        except OSError as e:
            return [], f"listdir({rel_dir}): {type(e).__name__}"
        for fn in entries:
            fp = os.path.join(abs_dir, fn)
            if os.path.isfile(fp):
                all_files.append((rel_dir + "/" + fn, fp))

    scored: list[tuple[int, str, str]] = []
    for rel_path, fp in all_files:
        # Filename words (hyphens/underscores/dots become spaces for matching)
        name_lower = (
            os.path.basename(fp)
            .lower()
            .replace("-", " ")
            .replace("_", " ")
            .replace(".", " ")
        )
        try:
            with open(fp, "rb") as fh:
                content = fh.read(REPORT_SCAN_BYTES).decode("utf-8", errors="replace").lower()
        except OSError:
            content = ""
        score = 0
        for kw in kw_set:
            if kw in name_lower:
                score += 2
            if kw in content:
                score += 1
        if score > 0:
            scored.append((score, rel_path, fp))

    scored.sort(key=lambda x: -x[0])
    return [(rel, fp) for _, rel, fp in scored[:MAX_REPORTS]], None


def _report_summary(fp: str) -> str:
    """Extract a one-line summary from the first bytes of a report file."""
    try:
        with open(fp, "rb") as fh:
            head = fh.read(200).decode("utf-8", errors="replace")
        for line in head.split("\n"):
            clean = line.strip().lstrip("#").strip()
            if clean:
                return clean[:100].rsplit(" ", 1)[0] + ("…" if len(clean) > 100 else "")
    except OSError:
        pass
    return ""


def format_report_hint(rel_path: str, fp: str) -> str:
    """Format one report file as a brief hint line."""
    summary = _report_summary(fp)
    hint = f"  - {rel_path}"
    if summary:
        hint += f": {summary}"
    return hint


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    prompt = hook_input.get("prompt", "").strip()

    # Skip empty or very short/generic inputs
    if len(prompt) < MIN_INPUT_LENGTH:
        sys.exit(0)

    # Skip tagged/system messages and slash commands
    for pattern in SKIP_PATTERNS:
        if re.match(pattern, prompt):
            sys.exit(0)

    # Strip leading metadata prefix (e.g., "[8:40 AM] [Telegram] Dave: ") before extracting keywords
    prompt = METADATA_PREFIX.sub("", prompt)

    # Extract keywords
    keywords = extract_keywords(prompt)
    if not keywords:
        sys.exit(0)

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    # ── Run all sources ────────────────────────────────────────────────────────
    memories = search_memories(keywords)

    wiki_results: list = []
    try:
        wiki_results = search_wiki(keywords)
    except Exception:
        pass

    tickets, ticket_err = search_tickets(keywords, project_dir)
    reports, report_err = search_reports(keywords, project_dir)

    # Exit silently only when every source is clean-empty (no errors either).
    # An UNDETERMINED error is itself informative and must reach the model.
    has_output = bool(memories or wiki_results or tickets or ticket_err or reports or report_err)
    if not has_output:
        sys.exit(0)

    # ── Emit memory hints ─────────────────────────────────────────────────────
    if memories:
        hints = [format_hint(m) for m in memories]
        print("Memory hints (from hybrid search):")
        print("\n".join(hints))
        print("  (Search daemon memory for deeper context if needed)")

    # ── Emit wiki hint ────────────────────────────────────────────────────────
    if wiki_results:
        print("Wiki article (curated):")
        print(format_wiki_hint(wiki_results[0]))

    # ── Emit ticket prior-art ─────────────────────────────────────────────────
    # UNDETERMINED always printed; results printed when present; "(none matched)"
    # printed only when at least one other section is active (avoids noise on
    # prompts where nothing is relevant except a ticket query that found nothing).
    other_sections_before_tickets = bool(memories or wiki_results)
    if ticket_err:
        print(f"Prior-art tickets: UNDETERMINED (query failed: {ticket_err})")
    elif tickets:
        print("Prior-art tickets (todos/tasks):")
        for t in tickets:
            print(format_ticket_hint(t))
        print(f"  ({len(tickets)} matched; all statuses included)")
    elif other_sections_before_tickets or reports or report_err:
        print("Prior-art tickets: (none matched)")

    # ── Emit report prior-art ─────────────────────────────────────────────────
    other_sections_for_reports = bool(memories or wiki_results or tickets)
    if report_err:
        print(f"Prior-art reports: UNDETERMINED (scan failed: {report_err})")
    elif reports:
        active_dirs = ", ".join(REPORT_DIRS)
        print("Prior-art reports:")
        for rel, fp in reports:
            print(format_report_hint(rel, fp))
        print(f"  ({len(reports)} matched in {active_dirs})")
    elif other_sections_for_reports or ticket_err:
        print("Prior-art reports: (none matched)")


if __name__ == "__main__":
    main()
