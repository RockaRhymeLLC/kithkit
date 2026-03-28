---
name: calendar
description: Checks the user's calendar events from macOS Calendar. Also manages the assistant's internal schedule, reminders, and to-do deadlines. Use when anyone asks about calendar, schedule, events, what's coming up, or needs to add reminders.
argument-hint: [show [date] | add "event" date [time] | remove "event" date]
---

# Calendar

View the user's real calendar and manage the assistant's internal schedule.

## User's Calendar (macOS Calendar via icalBuddy)

The user's actual calendar lives in macOS Calendar.app — synced from iCloud, Exchange, subscriptions. Use `icalBuddy` to read it. This is **read-only** — events are managed by the user in Calendar.app.

### Quick Commands

```bash
export PATH="/opt/homebrew/bin:/usr/bin:$PATH"

# Today's events
icalBuddy eventsToday

# Tomorrow
icalBuddy eventsFrom:'tomorrow' to:'tomorrow'

# Next 7 days
icalBuddy eventsToday+7

# Specific date
icalBuddy eventsFrom:'2026-02-15' to:'2026-02-15'

# Events happening right now
icalBuddy eventsNow

# This week
icalBuddy eventsFrom:'today' to:'saturday'
```

### Discovering Calendars

Calendars vary per user. Run `icalBuddy calendars` to discover available calendars and their types (CalDAV, iCloud, Exchange, Local, etc.).

### Filtering Options

```bash
# Exclude all-day events (holidays, etc.)
icalBuddy -ea eventsToday

# Only specific calendar
icalBuddy -ic "Work" eventsToday+7

# No calendar names in output (cleaner)
icalBuddy -nc eventsToday

# No property names (minimal output)
icalBuddy -npn eventsToday

# Strip ANSI formatting (for parsing)
icalBuddy -f eventsToday

# Combine: clean work events for this week
icalBuddy -nc -npn -f -ic "Work" eventsToday+7
```

### When the User Asks About Their Calendar

If the user asks "what's on my calendar?" or "am I free Thursday?" — **always use icalBuddy**. This is their real calendar with real appointments. Don't look at calendar.md — that's the assistant's internal schedule.

---

## Assistant's Internal Schedule (calendar.md)

The assistant's own scheduling layer for reminders, to-do deadlines, and assistant-managed events. Stored in `.kithkit/state/calendar.md`.

### Commands

Parse $ARGUMENTS to determine the action:

#### Show
- `show` or no arguments — Show upcoming events (next 7 days, both the user's + the assistant's)
- `show today` — Today's events
- `show tomorrow` — Tomorrow
- `show 2026-02-01` — Specific date
- `show week` — This week
- `show month` — This month

**For `show` commands**: Always check **both** icalBuddy (the user's calendar) AND calendar.md (the assistant's schedule), then present a combined view.

#### Add (the assistant's schedule only)
- `add "Event description" 2026-02-01` — All-day event
- `add "Event description" 2026-02-01 14:00` — Timed event
- `add "Event description" 2026-02-01 (reminder:morning)` — With reminder note

#### Remove (the assistant's schedule only)
- `remove "Event description" 2026-02-01` — Remove matching event

#### Link to To-Do
- `add "Work on feature [todo:032]" 2026-02-01` — Reference a to-do

### File Format

```markdown
# Calendar

## 2026-02

### 2026-02-14
- 09:00 - Remind user: Valentine's Day
- Check in on revenue research [todo:095]

### 2026-02-15
- Submit expense report reminder
```

### Entry Format

Each entry is a markdown list item:
- `- HH:MM - Event description` (timed event)
- `- Event description` (all-day event)
- `- Event description [todo:id]` (linked to to-do)
- `- Event description (note)` (with reminder/note)

### Workflow

**Showing events:**
1. Run icalBuddy for the user's calendar events
2. Read calendar.md for the assistant's scheduled items
3. Merge and display by date/time

**Adding events:**
1. Read calendar.md
2. Find or create the year/month section and date heading
3. Insert entry in time order
4. Write updated file, confirm

**Removing events:**
1. Read calendar.md, find matching entry
2. Remove the line, clean up empty sections
3. Confirm removal

## Output Format

### Combined Day View
```
## Today — Tuesday, Feb 11

### User's Calendar
- 9:30 AM - Team Standup (Teams)
- 2:00 PM - Planning Meeting (Teams)

### Assistant's Schedule
- Check research progress [todo:095]
- Send weekly digest email
```

### Week View
```
## This Week (Feb 10-16, 2026)

### Monday, Feb 10
User: No events
Assistant: Morning briefing sent

### Tuesday, Feb 11
User: 9:30 AM Team Standup, 2:00 PM Planning Meeting
Assistant: Weekly check-in

(etc.)
```

## Reminders

Reminder notes in parentheses are for the assistant to act on:
- `(send reminder morning of)` — Prompt to remind user
- `(order flowers by Feb 12)` — Action needed before event

The assistant should:
1. Check calendar at session start
2. Note upcoming events with reminder notes
3. Proactively mention relevant reminders

## Best Practices

- Use ISO dates (YYYY-MM-DD) for consistency
- Use 24-hour time (HH:MM) in calendar.md
- Keep descriptions concise
- Link to to-dos when relevant
- Add reminder notes for actions needed

## Integration

- To-dos referenced via `[todo:id]` syntax
- icalBuddy is read-only for the user's real calendar
- calendar.md is the assistant's read-write scheduling layer
- `/remind` skill creates timed reminders (different from calendar entries)
