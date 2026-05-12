#!/usr/bin/env python3
"""Back-fill orch_task_calibrations from orchestrator_tasks history.

For each orch task in the last N days:
- Parse a budget hint from description (regex for "Time-box: X hours",
  "X-min budget", "time box X minutes", etc.)
- Compute actual_minutes from started_at -> completed_at
- Classify task_type by keyword match in description
- Insert a row into orch_task_calibrations

Also seeds 8 hand-curated baseline rows from 5/4 events that pre-date this
system (see HANDCURATED below).

Usage:
  python3 scripts/calibration/back-fill.py [--days 30] [--dry-run]
"""

import argparse
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = os.path.expanduser("~/Library/Application Support/kithkit/kithkit.db")

# Hand-curated baseline entries (deployment-specific). Empty by default for
# upstream — agents that want to seed calibration data with known
# estimate-vs-actual pairs from prior history can extend this list locally.
# Each tuple: (label, estimate_min, actual_min, task_type, complexity).
HANDCURATED: list[tuple[str, int, int, str, str]] = [
    # ("Example task", 60, 12, "framework", "M"),
]

# Keyword -> task_type classifier. First match wins.
TYPE_KEYWORDS = [
    (r"\bdigest\b|\breport\b|csv|xlsx|aggregat|pivot",   "data"),
    (r"\bspec\b|\bdesign doc\b|\bschema\b|\bdocument\b",  "docs"),
    (r"\bbuild\b|\bimplement\b|\bship\b|\brefactor\b|\bport\b", "coding"),
    (r"\bresearch\b|\bscoping\b|\bdiscover\b|\binvestigat\b|\baudit\b", "research"),
    (r"\ba/b\b|\bharness\b|\bframework\b|\bplaywright\b|test runner", "framework"),
    (r"\bemail\b|telegram|relay|notify",                   "comms"),
]

# Time-budget parser. Expressed as (regex, scale_to_minutes).
BUDGET_PATTERNS = [
    # "Time-box: 4 hours" / "Time box: 90 min" / "time box 30 minutes"
    (re.compile(r"time[- ]?box(?:ed)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*(hr|hour|hours|h)\b", re.I), 60.0),
    (re.compile(r"time[- ]?box(?:ed)?[^\d]{0,12}(\d+(?:\.\d+)?)\s*(min|minute|minutes|m)\b", re.I), 1.0),
    # "4-hour budget" / "90-min budget" / "30 min target"
    (re.compile(r"(\d+(?:\.\d+)?)[- ]?(hour|hr|h)\s*(budget|target|window|cap)", re.I), 60.0),
    (re.compile(r"(\d+(?:\.\d+)?)[- ]?(min|minute|m)\s*(budget|target|window|cap)", re.I), 1.0),
    # "estimated half a day" -> 240 min (1 unit of "half day" = 4 hr)
    (re.compile(r"half[- ]a?[- ]day", re.I), None),  # special: 240
    # "30-min ceiling" / "90 minute hard stop"
    (re.compile(r"(\d+(?:\.\d+)?)[- ]?(min|minute)s?[- ]?(ceiling|hard stop|max)", re.I), 1.0),
    (re.compile(r"(\d+(?:\.\d+)?)[- ]?(hour|hr|h)s?[- ]?(ceiling|hard stop|max)", re.I), 60.0),
]

def parse_budget(description: str) -> int | None:
    if not description:
        return None
    for pat, scale in BUDGET_PATTERNS:
        m = pat.search(description)
        if not m:
            continue
        if scale is None:
            return 240
        try:
            n = float(m.group(1))
            return int(round(n * scale))
        except (ValueError, IndexError):
            continue
    return None

def classify_type(description: str) -> str:
    if not description:
        return "other"
    for pat, label in TYPE_KEYWORDS:
        if re.search(pat, description, re.I):
            return label
    return "other"

def parse_iso(s: str | None):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None

def compute_actual_min(started_at: str | None, completed_at: str | None) -> int | None:
    s = parse_iso(started_at)
    e = parse_iso(completed_at)
    if not s or not e:
        return None
    delta = (e - s).total_seconds() / 60.0
    if delta < 0:
        return None
    return int(round(delta))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-handcurated", action="store_true")
    args = ap.parse_args()

    if not Path(DB_PATH).exists():
        sys.exit(f"DB not found: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Sanity: table exists?
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='orch_task_calibrations'")
    if not cur.fetchone():
        sys.exit("orch_task_calibrations table missing — run scripts/migrations/calibration-log.sql first")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.days)).isoformat()
    cur.execute(
        """SELECT id, title, description, status, started_at, completed_at, outcome
             FROM orchestrator_tasks
            WHERE created_at >= ?
            ORDER BY created_at""",
        (cutoff,),
    )
    rows = cur.fetchall()
    print(f"Found {len(rows)} orch tasks in last {args.days} days")

    inserted = 0
    skipped_existing = 0
    skipped_no_actual = 0
    parse_failures = 0

    for r in rows:
        # Skip if already logged
        cur.execute("SELECT 1 FROM orch_task_calibrations WHERE orch_task_id=?", (r["id"],))
        if cur.fetchone():
            skipped_existing += 1
            continue

        actual = compute_actual_min(r["started_at"], r["completed_at"])
        if actual is None:
            skipped_no_actual += 1
            continue

        estimated = parse_budget(r["description"] or "")
        if estimated is None:
            parse_failures += 1
        ttype = classify_type(r["description"] or r["title"] or "")
        # Worker count from join table
        cur.execute("SELECT COUNT(*) AS c FROM orchestrator_task_workers WHERE task_id=?", (r["id"],))
        wcount = cur.fetchone()["c"]
        # Complexity heuristic
        if actual < 10:
            complexity = "S"
        elif actual < 60:
            complexity = "M"
        elif actual < 180:
            complexity = "L"
        else:
            complexity = "XL"

        multiplier = (actual / estimated) if (estimated and estimated > 0) else None
        completion = r["outcome"] or r["status"] or None

        if args.dry_run:
            print(f"  DRY {r['id'][:8]} est={estimated} act={actual} type={ttype} cplx={complexity} mult={multiplier}")
            continue

        cur.execute(
            """INSERT INTO orch_task_calibrations
                 (orch_task_id, escalated_at, estimated_minutes, actual_minutes, task_type,
                  complexity, workers_used, completion_status, estimation_method, estimate_multiplier, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (r["id"], r["started_at"], estimated, actual, ttype, complexity,
             wcount, completion, "scoping" if estimated else "none", multiplier, None),
        )
        inserted += 1

    # Hand-curated baseline
    handcurated_inserted = 0
    if not args.skip_handcurated:
        for label, est, act, ttype, complexity in HANDCURATED:
            cur.execute(
                "SELECT 1 FROM orch_task_calibrations WHERE notes=? AND orch_task_id IS NULL",
                (f"hand-curated 5/4 baseline: {label}",),
            )
            if cur.fetchone():
                continue
            multiplier = act / est if est > 0 else None
            if args.dry_run:
                print(f"  DRY HAND {label}: est={est} act={act} mult={multiplier:.2f}")
                continue
            cur.execute(
                """INSERT INTO orch_task_calibrations
                     (orch_task_id, escalated_at, estimated_minutes, actual_minutes, task_type,
                      complexity, workers_used, completion_status, estimation_method, estimate_multiplier, notes)
                   VALUES (NULL, ?, ?, ?, ?, ?, 0, 'completed', 'gut', ?, ?)""",
                ("2026-05-04T12:00:00Z", est, act, ttype, complexity, multiplier, f"hand-curated 5/4 baseline: {label}"),
            )
            handcurated_inserted += 1

    if not args.dry_run:
        conn.commit()

    print(f"\nInserted: {inserted} back-filled · {handcurated_inserted} hand-curated")
    print(f"Skipped:  {skipped_existing} already-logged · {skipped_no_actual} no completion timestamp")
    print(f"Parse failures (no budget hint in description): {parse_failures}")

    cur.execute("SELECT COUNT(*) FROM orch_task_calibrations")
    total = cur.fetchone()[0]
    print(f"\nTotal rows in orch_task_calibrations: {total}")

    conn.close()

if __name__ == "__main__":
    main()
