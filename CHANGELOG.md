# Changelog

All notable changes to the kithkit framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- CI workflow: automated tests, type-checking, and leak detection on push/PR (#TBD)
- Instance notification workflow: dispatches sync events to personal repos on push to main
- Upstream contribution PR template with leak-check checklist
- `scripts/install-hooks.sh` — installs local pre-push leak check hook
- CI/CD sync pipeline (Phases 1-4) — automated downstream sync, health checks, auto-rollback

---

## [Phase 7: Migration & Operational] — PRs #234–#241 (2026-04-14)

### Added
- `.claude/` → `.kithkit/` migration framework with automated migration script (#234)
- `docs` agent profile for documentation-focused worker tasks (#237)
- Keychain unlock step in daemon startup wrapper for unattended launch (#239)
- Orchestrator plan-approval workflow — tasks requiring human sign-off before execution (#240)
- 10-4 acknowledgment directive for inter-agent message reliability (#241)

### Fixed
- Match `todo-reminder` nudge behavior to approved spec (#236)
- Safety guards added to `migrate.sh` to prevent accidental data loss (#238)

### Changed
- Recipe paths updated throughout docs for `.kithkit/` migration (#235)

---

## [Phase 6: Self-Improvement & Behavioral Rules] — PRs #222–#231 (2026-03-27)

### Added
- Self-improvement loop: agents learn from outcomes, store insights, and share across peers (#222)
- `kkit-reflection` scheduler task for periodic agent self-review (#231)

### Fixed
- Remove duplicate Telegram/Voice initialization from base extension (#224)
- `wttr.in` fallback now returns temperatures in Fahrenheit correctly (#225)
- Remove FIFO fallback in message-router to eliminate stale-pipe errors (#227)

### Changed
- Docs: Verification Rule and Approved Content Rule added to CLAUDE.md (#223)
- Docs: Rationalization Prevention section added to CLAUDE.md (#226)
- Docs: "may have" / "would have" added to rationalization prevention word list (#229)

---

## [Phase 5: Agent Infrastructure] — PRs #203–#221 (2026-03-14)

### Added
- Timer skill for agent self-reminders (`POST /api/timer`) (#210)
- Task sleep/snooze API endpoints (#214)
- Worker agent profiles for orchestrator delegation (#218)
- Auto-store memories on task/todo completion (#219)

### Fixed
- `save-state` skill now performs read-before-write to prevent clobber (#207)
- Config-driven skip-permissions mode — no longer hardcoded (#209)
- Context-monitor statusline wired into defaults (#215)
- Complete watchdog/restart infrastructure for crashed agent recovery (#220)
- Bump worker `maxTurns` and update delegation rules (#221)

### Changed
- Comms adapters refactored to be agent-agnostic (#205)
- `safe-senders.json` removed; sender configuration consolidated into config (#216)

### Removed
- BMO-specific blog skill removed from framework (#203)

---

## [Phase 4: Security & Networking] — PRs #192–#202 (2026-03-09)

### Added
- HMAC signature verification for `/agent/p2p` endpoint (#194)
- Rate limiting on `/agent/p2p` endpoint (#195)
- LAN peer discovery with relay-first routing strategy (#197)
- Status and priority query filters on `GET /api/todos` (#202)

### Fixed
- Remove bearer auth requirement from `/agent/message` endpoint (#192)
- Strip sensitive fields from `/health` response for external requests (#193)
- Restore session-start auto-inject prompt after refactor regression (#196)
- Promote top-level `chat_id` into metadata for correct Telegram routing (#199)
- Only persist reply `chat_id` for private/DM chats, not group contexts (#201)

### Changed
- Docs: comprehensive documentation update across API reference and skills (#198)
- Docs: task tracking directive added for comms agent (#200)

---

## [Phase 3: Infrastructure Hardening] — PRs #154–#191 (2026-03-06)

### Added
- Configurable `db_path` support in daemon config (#154)
- CalDAV API integration replacing `icalbuddy` dependency (#187)
- `GET /api/usage/history` endpoint with cross-agent proxy support (#191)

### Fixed
- Group B+C daemon fixes: zombie session cleanup and stale status resolution (#155)
- Daemon now binds to `127.0.0.1` by default (was `0.0.0.0`) (#171)
- Rate limiting applied to spawn and escalate endpoints (#173)
- Timeout added to in-process task handlers (#174)
- `daily-digest` task uses correct status value `'completed'` (#175)
- Capture handler return value in `task_results` table (#176)
- `morning-briefing` task wired to channel router (#177)
- Sanitize and bound tmux `send-keys` input to prevent injection (#178)
- Server-side role lookup for contacts access control (#179)
- Telegram adapter: retry logic, timeout handling, `sendPhoto` boolean fix, HTTP 502 handling (#180)
- Invalid agent profile files are now handled gracefully (#181)
- Guard nag cycle against stale intervals to prevent ghost timers (#182)
- Ghost timer bug: orphaned nag cycles now cleaned up on timer completion (#186)
- Remove `maxBudgetUsd` worker budget cap (#188)

### Changed
- Replace wrapper script with `--profile` flag for agent launch (#156)
- Hardcoded tool paths extracted to config (#183)
- Hardcoded constants (part 2) extracted into config (#184)
- Hardcoded URL endpoints extracted to config (#185)

### Removed
- Dead code and deprecated auto-inject hook removed (#190)

---

## [Phase 2: CI/CD & Bug Fixes] — PRs #144–#153 (2026-03-04)

### Added
- CI/CD workflows for public repo (Phase 2) (#144)
- Deliver-once notification semantics to prevent duplicate message delivery (#146)
- Task retry and cancellation support (#147)
- Direct message injection: sets `notified_at` on delivery (#148)

### Fixed
- Exclude `notify-instances.yml` from instance sync to prevent circular dispatch (#145)
- SDK bridge type cleanup (#150)
- Memory-context hook: prompt field correction, hybrid search support, Telegram skip fix (#151)
- Upstream-sync workflow YAML parse error (#152)
- Renumber duplicate migration `014` to `015` (#153)

---

## [Phase 1 Framework Sync] — PR #142

### Added
- Unified A2A messaging endpoint (`POST /api/a2a/send`) with auto/LAN/relay routing
- Orphan cleanup system (`daemon/src/core/orphan-cleanup.ts`) for interrupted agent jobs
- `daily-digest` scheduler task for aggregated activity summaries
- `013-task-work-notes.sql` migration — adds `work_notes` column to `orchestrator_tasks`
- `011-worker-spawned-by.sql` migration update — tracks which orchestrator spawned each worker
- API metrics aggregation improvements
- Comms heartbeat improvements — unread message nudging
- Orchestrator idle monitor improvements
- `GET /api/orchestrator/tasks/:id` now includes `work_notes` and full activity log
- `PUT /api/orchestrator/tasks/:id` supports `append_work_notes` flag
- `session-start.sh` hook upgraded to v4 with comms gate and memory loading
- `agent-comms` skill documenting the comms↔orchestrator messaging protocol
- Extended API reference (`docs/api-reference.md`) covering all new endpoints

### Fixed
- `readKeychain` key corrected from `agent-comms-secret` to `credential-agent-comms-secret` in `extensions/index.ts`
- Message router reliability improvements
- Tmux agent session state detection fixes

### Changed
- `extensions/index.ts` refactored — comms initialization delegated to `commsExtension`
- `message-delivery` task overhauled for reliability
- `todo-reminder` task updated

---

## [0.1.0] - 2026-02-22

### Added
- Initial public release of kithkit framework
- Daemon: HTTP API, SQLite state, agent lifecycle, message routing
- CLI: init, install, search, update commands
- Extension system with dynamic instance loading
- Memory system with keyword and vector search
- Scheduler with cron and interval tasks
- Channel router (Telegram, email, A2A)
- Agent profiles with YAML frontmatter
- Orphan resource cleanup on daemon restart

---

[Unreleased]: https://github.com/RockaRhymeLLC/kithkit/compare/main...HEAD
