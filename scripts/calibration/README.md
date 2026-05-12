# Orch Task Calibration Tracking

**Purpose:** capture estimate-vs-actual time per orchestrator task so future
budgets are data-driven instead of vibes-driven. todo #488 (Dave directive
5/4 9:23 AM Telegram).

**Why:** measured 5/4 baseline showed BMO over-estimates by 3-30× consistently
across 8 task types. A blind multiplier is brittle; a logged dataset lets the
multiplier evolve as task types and complexity get more legible.

---

## Architecture

- **Table:** `orch_task_calibrations` in the active daemon SQLite DB
  (`~/Library/Application Support/kithkit/kithkit.db`).
- **Schema:** `scripts/migrations/calibration-log.sql`. Apply once via
  `sqlite3 "$DB" < scripts/migrations/calibration-log.sql`.
- **Back-fill:** `scripts/calibration/back-fill.py`. Reads recent
  `orchestrator_tasks`, parses budget hints from descriptions, computes
  actuals from `started_at` → `completed_at`, inserts rows. Also seeds 8
  hand-curated 5/4 baseline entries.
- **Stats:** `scripts/calibration/stats.py`. Dumps overall + per-type +
  per-complexity breakdown plus a "calibrated cheat-sheet" multiplier per
  task_type.

---

## Usage

### Apply the migration (idempotent — `CREATE IF NOT EXISTS`)

```bash
DB="$HOME/Library/Application Support/kithkit/kithkit.db"
sqlite3 "$DB" < scripts/migrations/calibration-log.sql
```

### Back-fill from history

```bash
# Default: last 30 days, all parseable + 8 hand-curated
python3 scripts/calibration/back-fill.py

# Wider window
python3 scripts/calibration/back-fill.py --days 90

# Dry-run (show what would be inserted)
python3 scripts/calibration/back-fill.py --dry-run

# Skip the hand-curated baseline (e.g. when re-running)
python3 scripts/calibration/back-fill.py --skip-handcurated
```

The back-fill is **idempotent on `orch_task_id`** — re-running won't
double-insert auto-back-filled rows. Hand-curated rows are de-duped by their
`notes` field.

### Read the stats

```bash
# Plain text
python3 scripts/calibration/stats.py

# Markdown for embedding in a doc
python3 scripts/calibration/stats.py --markdown --out /tmp/calibration-stats.md
```

---

## Schema columns

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `orch_task_id` | TEXT | nullable — NULL for the hand-curated 5/4 baseline + any pre-system entries |
| `escalated_at` | TEXT | ISO-8601, when orch picked it up |
| `estimated_minutes` | INTEGER | parsed from description budget hints, NULL if unparseable |
| `actual_minutes` | INTEGER | computed from `started_at` → `completed_at` |
| `task_type` | TEXT | research / coding / data / report / docs / framework / comms / other |
| `complexity` | TEXT | S / M / L / XL — heuristic from actual_minutes (S < 10, M < 60, L < 180, XL ≥ 180) |
| `workers_used` | INTEGER | from `orchestrator_task_workers` count |
| `completion_status` | TEXT | success / partial / failed / cancelled |
| `estimation_method` | TEXT | gut / scoping / comparable / none |
| `estimate_multiplier` | REAL | `actual_minutes / estimated_minutes` if both present |
| `notes` | TEXT | free-text; "hand-curated 5/4 baseline: …" for the seed rows |
| `created_at` | TEXT | row insert time |

---

## How to use the data day-to-day

When sizing a new orch task:

1. Run `python3 scripts/calibration/stats.py` to see the current cheat-sheet.
2. Find the row matching the task's likely `task_type`.
3. Multiply your gut estimate by the listed adjustment factor.
4. Communicate the calibrated number, not the gut number.

When closing an orch task:

- Nothing manual needed — the next `back-fill.py` run picks it up
  automatically from `orchestrator_tasks` if a budget hint was in the
  description.
- For tasks where the description had no budget hint, manually `INSERT` a
  row via `sqlite3` if it's notable.

---

## What this DOES NOT do (yet)

- **Does not modify the orch escalation flow.** Optional follow-up: add a
  `POST /api/calibration/log` daemon endpoint that comms calls when escalating
  (passing the gut estimate) and that the daemon auto-fills on task close.
  Proposed but not implemented this round to keep the existing flow stable.
- **Does not auto-classify task_type from richer signal** (only keyword regex
  on description). A future enhancement: classify from work_notes content
  after completion for better accuracy.
- **Does not feed back into the escalation prompt.** Future: when orch is
  spawned with a task description, prepend "Calibration: similar tasks
  (n=X) ran at Y× of stated budget" so the model can self-correct.
