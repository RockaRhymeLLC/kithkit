# Changelog

All notable changes to the kithkit framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- CI workflow: automated tests, type-checking, and leak detection on push/PR (#TBD)
- Instance notification workflow: dispatches sync events to personal repos on push to main
- Upstream contribution PR template with leak-check checklist
- `scripts/install-hooks.sh` — installs local pre-push leak check hook

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
