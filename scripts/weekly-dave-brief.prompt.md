Compile R2's weekly self-report for Dave (chat_id 7629737488). Gather data from the past 7 days by querying the daemon's local APIs:

1. GET /api/orchestrator/tasks?status=completed and ?status=failed — scan for tasks that had retries, took multiple rounds, or hit blockers. Note patterns.
2. GET /api/todos — list done, blocked, and any stale in_progress todos older than 7 days.
3. POST /api/memory/search with queries like "correction", "feedback", "blocker", "issue" — pull recent feedback entries.
4. GET /api/messages — scan comms↔orchestrator and peer A2A traffic for repeated questions or friction points.
5. **Git divergence (MUST be live — do NOT read from memory or any cached value):**
   Call `GET /status/extended` on the daemon (http://localhost:3847/status/extended) and read `git.aheadOfOrigin`, `git.behindOfOrigin`, and `git.fetchFailed`. The daemon runs `git fetch origin main` immediately before counting, so these numbers are authoritative at report time. If `git.fetchFailed` is true, note "network unavailable at report time — counts may be stale" rather than reporting the raw numbers without qualification.

   If `git.behindOfOrigin` is absent (older daemon without this fix), fall back to the shell sequence (using execFile, no shell interpolation):
   ```
   git fetch origin main --no-tags --quiet
   git rev-list --count HEAD..origin/main
   ```
   Do NOT fall back to memory. A missing field is not the same as zero — report it as unavailable.

Then produce a structured report under 500 words with these sections:

## Issues & Blockers
What went wrong or got stuck this week. Be specific — reference task IDs, PR numbers, peer names. Don't sugarcoat.

## Git Divergence
State the live `commitsAhead` / `commitsBehind` from the extended-status endpoint (or the fallback git command above). If fetch failed or the field was unavailable, say so explicitly. Do NOT omit this section or substitute a memorised number.

## Proposed Enhancements
Concrete changes that would help R2 help Chrissy better. Examples: missing daemon features, UX papercuts, integration gaps (email, calendar, reminders), automation opportunities. Each suggestion should cite the incident that motivated it.

## Peer & Human Coordination
Anything noteworthy about how R2 worked with BMO, Skippy, Dave, or Chrissy — successes, recurring gaps, communication friction.

## Anything Else
Observations, risks R2 is carrying, open questions for Dave.

Deliver by calling POST /api/send with channel=telegram, chat_id=7629737488, and the message body. Wrap the report with a header like "**R2 weekly brief — <date range>**" at the top.

Constraints:
- Under 500 words total (markdown, concise).
- Do NOT fabricate incidents — if the week was uneventful, say so briefly.
- Do NOT include sensitive data (credentials, passwords, tokens).
- Do NOT switch branches; this is a read-only data task, no code changes.
- Do NOT use memory-stored commit counts. Memory is a snapshot; the live extended-status endpoint and git commands are the authoritative source (see step 5).
