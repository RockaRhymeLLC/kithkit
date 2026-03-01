---
name: delivery-stats
description: Analyze Telegram delivery logs for success rates, retry patterns, and failures.
argument-hint: [recent | failures | layers | dedup]
---

# Delivery Stats

Analyze `logs/delivery.jsonl` to show delivery success rates, retry patterns, dedup frequency, and recent failures. Makes the delivery tracking log actionable for quick debugging.

## Usage

- `/delivery-stats` - Show full summary dashboard
- `/delivery-stats recent` - Show last 20 deliveries with status
- `/delivery-stats failures` - Show only failed/exhausted deliveries
- `/delivery-stats layers` - Breakdown by delivery layer
- `/delivery-stats dedup` - Show duplicate hash analysis

## Log Format

Each line in `logs/delivery.jsonl` is a JSON object:

```json
{
  "ts": "2026-02-03T04:08:33.903Z",
  "event": "delivered",
  "layer": "retry",
  "hookEvent": "PostToolUse",
  "elapsed": 4819,
  "retryAttempt": 8,
  "chatId": "7629737488",
  "len": 84,
  "hash": "3f814d991f47e14e"
}
```

### Fields

| Field | Description |
|-------|-------------|
| `ts` | ISO timestamp |
| `event` | `delivered` or `retry-exhausted` |
| `layer` | Which delivery mechanism succeeded: `stop-hook`, `retry`, `pane-capture`, `background-check` |
| `hookEvent` | The hook event that triggered delivery (PostToolUse, SubagentStop, Stop, UserPromptSubmit) or null |
| `elapsed` | Time in ms from first attempt to delivery (0 for instant stop-hook deliveries) |
| `retryAttempt` | Which retry attempt succeeded (null for stop-hook/background-check) |
| `chatId` | Target Telegram chat ID (null if not resolved at time of delivery) |
| `len` | Message length in characters |
| `hash` | Dedup hash for the message content |

### Delivery Layers (priority order)

1. **stop-hook** - Instant delivery via Claude Code hook (best case, elapsed=0)
2. **retry** - Tight retry loop caught it within seconds
3. **background-check** - Periodic background poll found new content
4. **pane-capture** - Last resort after ~60s, captures from tmux pane

## Implementation

1. **Read the log**: Read `logs/delivery.jsonl` from the project root
2. **Parse entries**: Each line is a JSON object, parse all lines
3. **Compute stats** based on the subcommand (or all for default dashboard)
4. **Format output** using the templates below

### Stats to Compute

**Overall**:
- Total deliveries, success count, failure count, success rate %
- Time range covered (first entry to last entry)

**By Layer**:
- Count and percentage for each layer (stop-hook, retry, pane-capture, background-check)
- Average elapsed time per layer
- Average retry attempt per layer (where applicable)

**Retry Analysis**:
- Average/median/max retry attempts for retry-layer deliveries
- Average/median/max elapsed time for non-instant deliveries

**Dedup**:
- Count of unique hashes vs total entries
- Any hashes that appear 3+ times (potential stuck messages)

**Failures**:
- All `retry-exhausted` events with timestamp, chatId, hash, and elapsed time

## Output Format

### Dashboard (default)

```
## Delivery Stats

**Period**: 2026-02-03 03:44 - 15:16 UTC (11h 32m)
**Total**: 31 deliveries | 30 succeeded | 1 failed | **96.8% success**

### By Layer
| Layer            | Count |    % | Avg Elapsed | Avg Retries |
|------------------|------:|-----:|------------:|------------:|
| stop-hook        |    15 |  50% |          0s |           - |
| retry            |     3 |  10% |        11s  |          15 |
| background-check |     4 |  13% |           - |           - |
| pane-capture     |     8 |  27% |        61s  |          64 |

### Failures (1)
- 2026-02-03 04:13 — chat 7629737488, hash 26c798da, 184 chars, exhausted after 61s

### Dedup
- 31 entries, 28 unique hashes
- Hash `26c798da` appeared 4x (3 delivered + 1 exhausted)
```

### Recent

```
## Recent Deliveries (last 20)

| Time (UTC) | Event     | Layer            | Elapsed | Chat       | Len  |
|------------|-----------|------------------|--------:|------------|-----:|
| 15:16:28   | delivered | retry            |    16s  | 7629737488 |  134 |
| 15:16:11   | delivered | stop-hook        |     0s  | 7629737488 |  261 |
| ...        | ...       | ...              |    ...  | ...        |  ... |
```

### Failures

```
## Delivery Failures

**Total**: 1 failure out of 31 attempts

| Time (UTC)       | Chat       | Hash     | Len | Elapsed | Retries |
|------------------|------------|----------|----:|--------:|--------:|
| 2026-02-03 04:13 | 7629737488 | 26c798da | 184 |    61s  |      64 |
```

### Layers

Same as the "By Layer" table from the dashboard, but with additional per-layer detail:
- Hook event distribution within each layer
- Min/max/median elapsed times

### Dedup

```
## Dedup Analysis

**Total entries**: 31 | **Unique hashes**: 28 | **Duplicates**: 3

### Repeated Hashes
| Hash     | Count | Events              | Chats                    |
|----------|------:|---------------------|--------------------------|
| 26c798da |     4 | 3 delivered, 1 fail | 7629737488               |
| ...      |   ... | ...                 | ...                      |
```

## Notes

- If `logs/delivery.jsonl` doesn't exist or is empty, report "No delivery data found."
- Timestamps are displayed in UTC
- Hashes are truncated to 8 chars in output for readability
- Elapsed time is shown in human-friendly format (ms for <1s, s for <60s, m:ss for >=60s)
- Chat IDs can be cross-referenced with safe-senders.json and 3rd-party-senders.json for names
