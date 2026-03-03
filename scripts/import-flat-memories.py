#!/usr/bin/env python3
"""Import flat-file memories (.md with YAML frontmatter) into the daemon API.

Parses YAML frontmatter for metadata, uses markdown body as content.
Skips duplicates by checking if content already exists in the DB (substring match).

Usage: python3 scripts/import-flat-memories.py [--dry-run] [--daemon-url URL]
"""

import os
import sys
import json
import re
import urllib.request
import urllib.error
from pathlib import Path

DAEMON_URL = os.environ.get("KITHKIT_DAEMON_URL", "http://localhost:3847")
MEMORY_DIR = Path(__file__).resolve().parent.parent / ".claude/state/memory/memories"

# Valid categories and types for the API
VALID_CATEGORIES = {"person", "preference", "technical", "account", "event", "decision"}
# Map flat-file categories to API categories
CATEGORY_MAP = {
    "person": "person",
    "preference": "preference",
    "technical": "technical",
    "account": "account",
    "event": "event",
    "decision": "decision",
}


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML frontmatter and return (metadata, body)."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not match:
        return {}, text

    yaml_text = match.group(1)
    body = match.group(2).strip()

    # Simple YAML parser (avoids PyYAML dependency)
    meta = {}
    current_key = None
    current_list = None

    for line in yaml_text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # List item under a key
        if stripped.startswith("- ") and current_key and current_list is not None:
            current_list.append(stripped[2:].strip().strip("'\""))
            meta[current_key] = current_list
            continue

        # Key: value
        kv_match = re.match(r"^(\w[\w_-]*)\s*:\s*(.*)", stripped)
        if kv_match:
            key = kv_match.group(1)
            value = kv_match.group(2).strip()

            # Inline list: [a, b, c]
            if value.startswith("[") and value.endswith("]"):
                items = [v.strip().strip("'\"") for v in value[1:-1].split(",") if v.strip()]
                meta[key] = items
                current_key = key
                current_list = None
                continue

            # Empty value — might be followed by list items
            if not value:
                current_key = key
                current_list = []
                continue

            # Scalar value
            meta[key] = value.strip("'\"")
            current_key = key
            current_list = None

    return meta, body


def api_call(endpoint: str, data: dict) -> tuple[int, dict]:
    """Make a POST request to the daemon API."""
    url = f"{DAEMON_URL}{endpoint}"
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8")) if e.read else {}
    except Exception as e:
        return 0, {"error": str(e)}


def check_duplicate(content: str) -> bool:
    """Check if a memory with similar content already exists."""
    # Use the first 80 chars as a keyword search — good enough for dedup
    snippet = content[:80].replace('"', "").replace("'", "").strip()
    if not snippet:
        return False
    # Take first 3 significant words for search
    words = [w for w in snippet.split() if len(w) > 3][:3]
    if not words:
        return False
    query = " ".join(words)
    status, resp = api_call("/api/memory/search", {"query": query, "mode": "keyword"})
    if status == 200 and resp.get("data"):
        for existing in resp["data"]:
            # Check for substantial content overlap
            existing_content = existing.get("content", "")
            if content[:100] in existing_content or existing_content[:100] in content:
                return True
    return False


def import_file(filepath: Path, dry_run: bool = False) -> str:
    """Import a single memory file. Returns: 'imported', 'skipped', or 'error:<msg>'."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except Exception as e:
        return f"error:read:{e}"

    meta, body = parse_frontmatter(text)
    if not body:
        return "skipped:empty"

    # Build content: use subject as title + body
    subject = meta.get("subject", "")
    content = f"{subject}\n\n{body}" if subject else body

    # Map category
    raw_category = meta.get("category", "technical")
    category = CATEGORY_MAP.get(raw_category, "technical")

    # Build tags list
    raw_tags = meta.get("tags", [])
    if isinstance(raw_tags, str):
        raw_tags = [raw_tags]
    tags = list(raw_tags)

    # Add confidence as a tag (importance is a DB column)
    confidence = meta.get("confidence", "0.7")
    tags.append(f"confidence:{confidence}")

    # Parse importance (DB column, integer 1-5, default 3)
    try:
        importance = int(meta.get("importance", 3))
    except (ValueError, TypeError):
        importance = 3

    # Add source file reference
    source = meta.get("source", "auto-extraction")
    if "flat-file-import" not in source:
        source = f"flat-file-import ({source})"

    if dry_run:
        print(f"  DRY RUN: would import {filepath.name}")
        print(f"    category={category}, importance={importance}, tags={tags[:5]}")
        print(f"    content preview: {content[:100]}...")
        return "imported"

    # Check for duplicates
    if check_duplicate(content):
        return "skipped:duplicate"

    # Store via API
    payload = {
        "content": content,
        "category": category,
        "tags": tags,
        "source": source,
        "importance": importance,
    }
    status, resp = api_call("/api/memory/store", payload)

    if status == 201:
        return "imported"
    elif status == 200 and resp.get("action") == "review_duplicates":
        return "skipped:vector-dedup"
    else:
        return f"error:api:{status}:{resp.get('error', 'unknown')}"


def main():
    dry_run = "--dry-run" in sys.argv
    global DAEMON_URL
    for i, arg in enumerate(sys.argv):
        if arg == "--daemon-url" and i + 1 < len(sys.argv):
            DAEMON_URL = sys.argv[i + 1]

    if not MEMORY_DIR.exists():
        print(f"Memory directory not found: {MEMORY_DIR}")
        sys.exit(1)

    files = sorted(MEMORY_DIR.glob("*.md"))
    print(f"Found {len(files)} memory files in {MEMORY_DIR}")
    if dry_run:
        print("DRY RUN — no changes will be made\n")

    stats = {"imported": 0, "skipped": 0, "errors": 0}
    errors = []

    for i, f in enumerate(files):
        result = import_file(f, dry_run)

        if result == "imported":
            stats["imported"] += 1
            if not dry_run:
                print(f"  [{i+1}/{len(files)}] ✓ {f.name}")
        elif result.startswith("skipped"):
            stats["skipped"] += 1
            reason = result.split(":", 1)[1] if ":" in result else "unknown"
            if not dry_run:
                print(f"  [{i+1}/{len(files)}] ⊘ {f.name} ({reason})")
        else:
            stats["errors"] += 1
            errors.append((f.name, result))
            print(f"  [{i+1}/{len(files)}] ✗ {f.name}: {result}")

    print(f"\n{'DRY RUN ' if dry_run else ''}RESULTS:")
    print(f"  Imported: {stats['imported']}")
    print(f"  Skipped:  {stats['skipped']}")
    print(f"  Errors:   {stats['errors']}")

    if errors:
        print("\nErrors:")
        for name, err in errors:
            print(f"  {name}: {err}")


if __name__ == "__main__":
    main()
