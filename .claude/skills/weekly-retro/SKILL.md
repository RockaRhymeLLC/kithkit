---
name: weekly-retro
description: Generate a weekly retrospective summarizing completed todos, git commits, and timeline activity from the past 7 days.
argument-hint: [run | days:N]
---

# Weekly Retrospective

Generate a summary of accomplishments from the past 7 days (or custom range).

## Commands

Parse the arguments to determine behavior:

- No arguments or `run` — Generate retro for last 7 days
- `days:N` — Generate retro for last N days (e.g., `days:14` for two weeks)

## Implementation

When invoked, gather data from three sources and compile a report.

### 1. Completed Todos

Scan `.claude/state/todos/` for files matching `*-completed-*.json`:

```
for each completed todo file:
  parse JSON
  find the completion action (type: "status-change", to: "completed")
  if completion timestamp is within the date range:
    include: [id] title (priority)
    include work notes if any
```

### 2. Git Commits

Run git log for the date range:

```bash
git log --oneline --since="N days ago" --no-merges
```

Filter out merge commits to focus on real work. Group by day if there are many commits.

### 3. Memory Timeline

Read timeline files from `.claude/state/memory/timeline/` that fall within the date range:

```
for each YYYY-MM-DD.md file in range:
  read the frontmatter (highlights, topics, todos)
  read the body entries (### HH:MM — reason lines)
  extract key highlights
```

### 4. Format and Deliver

Compile into a clean report and output it directly. The transcript stream will forward to Telegram if channel is active.

## Output Format

```
## Weekly Retro: [start date] – [end date]

### Completed Todos (N)
- [id] title (priority)

### Git Activity (N commits)
- hash message

### Highlights
- Date: highlight from timeline

### Stats
- Todos completed: N
- Commits: N
- Active days: N/7
```

Keep it concise — this is a snapshot, not an essay. If a section is empty, skip it. If there's nothing to report, say so briefly.

## Notes

- This is a read-only skill — it doesn't modify any files
- Default range is 7 days; use `days:N` for custom ranges
- Merge commits are excluded from git activity to reduce noise
- Timeline entries come from the nightly memory consolidation task
- Adapted from Marvbot's /weekly-retro skill — thanks Marvbot!
