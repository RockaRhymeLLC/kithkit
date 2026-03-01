---
name: timer
description: Set agent self-reminder timers via the daemon API. Fires once, nags every 30s until acknowledged, auto-expires after 10min. Use for async follow-ups — NOT for human reminders (use /remind for that).
argument-hint: [<delay> "message"] | [list] | [ack <id>] | [snooze <id>] | [cancel <id>]
---

> **Agent self-reminders only.** This skill sets timers that fire into the agent's own tmux session.
> For human reminders delivered via Telegram, use `/remind` instead.

# Agent Self-Timer

Set timers that inject a nag message directly into the agent's tmux session after a delay. Essential for async follow-ups after spawning workers, escalating tasks, or waiting on external events — **without using `bash sleep`** (which is forbidden).

## What This Is

- **Agent timers** — the daemon injects the message into the agent's tmux session when the timer fires
- Not visible to the human directly (they're session nudges for the agent)
- For human reminders delivered to Dave via Telegram, use `/remind` instead
- **HARD RULE**: Never use `bash sleep` for async waits. Set a timer, then stop and wait.

## Commands

Parse $ARGUMENTS to determine the action:

### Set a Timer
```
<delay> "message"
```
Examples:
- `90s "check worker results"`
- `2m "check orch task status"`
- `300 "follow up on PR #76"`
- `5m "verify deploy completed"`

Delay can be:
- A number (seconds): `90`, `300`
- A string with unit: `"90s"`, `"2m"`, `"5m"`

### List Timers
```
list
```
Show all active timers (pending, fired, snoozed).

### Acknowledge a Timer
```
ack <id>
```
Stop nagging for a fired timer. Use this once you've handled the follow-up.

### Snooze a Timer
```
snooze <id>
```
Reschedule a fired timer (default 5 minutes). Optionally append a delay: `snooze <id> 2m`.

### Cancel a Timer
```
cancel <id>
```
Cancel a pending timer before it fires.

## API Reference

All endpoints on `localhost:3847`:

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | /api/timer | `{"delay": "90s" or 90, "message": "text", "agent": "comms"}` | `{id, fires_at, message, status}` (201) |
| GET | /api/timers | — | `{timers: [...], count}` |
| POST | /api/timer/:id/ack | — | `{id, acknowledged: true}` |
| POST | /api/timer/:id/snooze | `{"delay": "5m"}` (optional) | `{id, snoozed: true, fires_at}` |
| DELETE | /api/timer/:id | — | `{id, cancelled: true}` |

**Agent field**: `"comms"` (default) or `"orchestrator"` — controls which tmux session receives the injection.

**Delay format**: number (seconds) or string with unit (`"90s"`, `"2m"`).

## Behavior

- Timer fires once at the scheduled time, injecting the message into the agent's tmux session
- After firing, nags every **30 seconds** via tmux injection until acknowledged
- **Auto-expires** after 10 minutes of nagging if not acknowledged
- Persists in SQLite — survives daemon restart
- Status lifecycle:
  - `pending` → `fired` → `acknowledged` / `expired` / `cancelled`
  - `pending` → `snoozed` → `fired` → ...
- On daemon restart: pending/snoozed timers are rescheduled, fired timers resume nagging

## Use Cases

| Situation | Timer to set |
|-----------|-------------|
| After spawning a worker | `90s "check worker <id> results"` |
| After escalating to orchestrator | `2m "check orch task status"` |
| Waiting for PR review | `5m "check PR #76 review status"` |
| After triggering a deploy | `3m "verify deploy completed"` |
| Any async wait | Set a timer, say "waiting", stop. Never `bash sleep`. |

## Workflow

1. Parse `$ARGUMENTS` to determine action (set / list / ack / snooze / cancel)
2. **Set**: extract delay and message → `POST /api/timer` with `{"delay": ..., "message": ..., "agent": "comms"}`
3. **List**: `GET /api/timers` → display formatted table
4. **Ack**: extract ID → `POST /api/timer/:id/ack`
5. **Snooze**: extract ID (and optional delay) → `POST /api/timer/:id/snooze` with optional body
6. **Cancel**: extract ID → `DELETE /api/timer/:id`
7. Report result to user

## Output Formats

### Set Confirmation
```
Timer set!
- Message: "check worker abc123 results"
- Fires in: 90 seconds
- ID: f47ac10b-58cc-4372-a567-0e02b2c3d479
- Agent: comms
```

### List Output
```
## Active Timers (2)

[f47ac10b] pending  — fires in 1m 23s
  "check worker abc123 results"

[9b2e3f1a] fired    — nagging every 30s (3m elapsed)
  "check orch task status"
```

### Ack Confirmation
```
Timer acknowledged: f47ac10b
  "check worker abc123 results"
Nagging stopped.
```

### Snooze Confirmation
```
Timer snoozed: 9b2e3f1a
  "check orch task status"
  Fires again at: 2026-03-01 14:35:00
```

### Cancel Confirmation
```
Timer cancelled: f47ac10b
  "check worker abc123 results"
```

## Notes

- This is NOT for human reminders — use `/remind` for Telegram delivery to humans
- Timer IDs are UUIDs
- The `agent` field controls which tmux session receives the injection (`comms` or `orchestrator`)
- Ack promptly after handling the follow-up — don't let timers nag indefinitely

## See Also

- `/remind` — Human reminders via Telegram (launchd one-shot jobs, fires at a specific date/time)
