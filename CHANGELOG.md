# Changelog

All notable changes to Kithkit are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/RockaRhymeLLC/kithkit/compare/main...HEAD
