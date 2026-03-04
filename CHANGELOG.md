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
