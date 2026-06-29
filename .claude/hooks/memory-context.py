#!/usr/bin/env python3
"""
UserPromptSubmit Hook: Memory-assisted context injection

Extracts keywords from user input, does a fast keyword search against
the daemon memory API, and injects 2-3 brief memory hints into context.

Skips short/generic inputs (<10 chars). Keyword-only for speed.
"""

import json
import sys
import urllib.request
import re

DAEMON_URL = "http://localhost:3847/api/memory/search"
WIKI_URL = "http://localhost:3847/api/wiki/search"
MAX_HITS = 3
MAX_CHARS_PER_HIT = 100
WIKI_SUMMARY_CHARS = 120
MIN_INPUT_LENGTH = 10

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

    # Search (tries progressively fewer keywords if AND is too strict)
    memories = search_memories(keywords)
    if not memories:
        sys.exit(0)

    # Format output
    hints = [format_hint(m) for m in memories]
    print("Memory hints (from hybrid search):")
    print("\n".join(hints))
    print("  (Search daemon memory for deeper context if needed)")

    # Wiki article hint — additive, independently guarded.
    # A failure here MUST NOT suppress the memory hints above.
    try:
        wiki_results = search_wiki(keywords)
        if wiki_results:
            print("Wiki article (curated):")
            print(format_wiki_hint(wiki_results[0]))
    except Exception:
        pass  # Never block on wiki failure


if __name__ == "__main__":
    main()
