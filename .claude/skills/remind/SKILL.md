---
name: remind
description: Set timed reminders delivered via Telegram. Creates self-cleaning launchd jobs. Use when the user asks to be reminded of something at a specific time.
argument-hint: ["message" at <time> on <date>] | [list] | [cancel <id>]
---

# Timed Reminders

Set reminders that fire at a specific date/time via Telegram, even when you're not in an active session. Uses launchd one-shot jobs that self-clean after delivery.

## Commands

Parse $ARGUMENTS to determine the action:

### Set a Reminder
- `"message" at 10:30 tomorrow`
- `"message" at 14:00 on 2026-02-01`
- `"message" tomorrow morning` (defaults to 9:00 AM)
- `"message" tonight` (defaults to 8:00 PM)
- `"Pick up groceries" at 5pm on Friday`

### List Reminders
- `list` - Show all pending reminders

### Cancel a Reminder
- `cancel <id>` - Cancel a pending reminder by its date-based ID

## How It Works

Each reminder creates two files:
1. **Script**: `scripts/reminders/remind-<id>.sh` — sends the Telegram message, then deletes itself and its plist
2. **Plist**: `~/Library/LaunchAgents/com.assistant.reminder.<id>.plist` — launchd job that fires at the scheduled time

The `<id>` is derived from the date/time: `YYYYMMDD-HHMM` (e.g., `20260131-1030`).

## Workflow

### Setting a Reminder

1. **Parse the request**: Extract message, date, and time from arguments
2. **Resolve relative dates**: "tomorrow", "Friday", "tonight", etc. into absolute dates
3. **Validate**: Ensure the date/time is in the future
4. **Get chat ID**: Look up the user's Telegram chat ID from memory or safe-senders.json
5. **Create the script**:

```bash
#!/bin/bash
# Reminder: <id> — <message summary>
# Fires: YYYY-MM-DD at HH:MM
# Self-cleaning: removes plist and script after running

export PATH="/opt/homebrew/bin:/usr/bin:/bin:$PATH"
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"$BASE_DIR/scripts/telegram-send.sh" "CHAT_ID" "REMINDER_MESSAGE"

# Clean up
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.assistant.reminder.ID.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.assistant.reminder.ID.plist
rm -f "$0"
```

6. **Make executable**: `chmod +x` the script
7. **Create the plist**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.assistant.reminder.ID</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>PROJECT_DIR/scripts/reminders/remind-ID.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Month</key>
        <integer>MONTH</integer>
        <key>Day</key>
        <integer>DAY</integer>
        <key>Hour</key>
        <integer>HOUR</integer>
        <key>Minute</key>
        <integer>MINUTE</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>PROJECT_DIR/logs/reminder-ID.log</string>
    <key>StandardErrorPath</key>
    <string>PROJECT_DIR/logs/reminder-ID.log</string>
</dict>
</plist>
```

8. **Load the plist**: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.assistant.reminder.ID.plist`
9. **Verify**: `launchctl list | grep reminder.ID`
10. **Confirm**: Tell the user when the reminder will fire

### Listing Reminders

1. Glob for `~/Library/LaunchAgents/com.assistant.reminder.*.plist`
2. For each, read the matching script in `scripts/reminders/` to extract the message
3. Display: ID, scheduled time, message

### Canceling a Reminder

1. Unload: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.assistant.reminder.ID.plist`
2. Delete plist: `rm ~/Library/LaunchAgents/com.assistant.reminder.ID.plist`
3. Delete script: `rm scripts/reminders/remind-ID.sh`
4. Confirm cancellation

## Date/Time Parsing

Resolve natural language to absolute dates:

| Input | Resolves to |
|-------|-------------|
| `tomorrow` | Next day |
| `tomorrow morning` | Next day 9:00 AM |
| `tonight` | Today 8:00 PM |
| `Monday`, `Friday`, etc. | Next occurrence of that day |
| `in 2 hours` | Current time + 2 hours |
| `2026-02-01` | Specific date |
| `5pm`, `17:00`, `5:30 PM` | Specific time |

If no time given, default to **9:00 AM**.

## Output Format

### Set Confirmation
```
Reminder set!
- Message: "Time to leave for the game"
- When: Saturday Jan 31, 2026 at 10:30 AM
- ID: 20260131-1030
- Delivery: Telegram
```

### List Output
```
## Pending Reminders (2)

[20260131-1030] Sat Jan 31 at 10:30 AM
  "Time to leave for the game"

[20260205-0900] Wed Feb 5 at 9:00 AM
  "Follow up on CC4Me setup"
```

### Cancel Confirmation
```
Reminder canceled: 20260131-1030
  "Time to leave for the game"
```

## File Locations

| What | Where |
|------|-------|
| Reminder scripts | `scripts/reminders/remind-<id>.sh` |
| launchd plists | `~/Library/LaunchAgents/com.assistant.reminder.<id>.plist` |
| Logs | `logs/reminder-<id>.log` |

## Notes

- Reminders fire even when you're not in an active Claude Code session
- Each reminder is one-shot and self-cleaning (deletes its own script + plist after firing)
- If the Mac is asleep when a reminder is due, launchd fires it on next wake
- Get chat ID from safe-senders.json or memory. Override by specifying a different recipient.
- Always use `telegram-send.sh` for reminders (not the transcript stream) since reminders fire outside sessions
- Ensure `scripts/reminders/` directory exists before creating scripts
