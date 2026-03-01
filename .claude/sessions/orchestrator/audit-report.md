# A2A Skills Uniformity Audit Report

## Current State

### KKit-BMO (reference)
- `agent-comms/SKILL.md` — COMPLETE (P2P SDK, python3 JSON, request fields table, response formats, architecture sections)
- `agent-comms/messaging-sop.md` — COMPLETE (endpoint map, common mistakes, error codes, message flow)
- `a2a-network/SKILL.md` — COMPLETE (dispatcher with routing table)
- `a2a-network/connections.md` — COMPLETE
- `a2a-network/discovery.md` — COMPLETE
- `a2a-network/groups.md` — COMPLETE
- `a2a-network/messaging.md` — COMPLETE
- `a2a-network/setup.md` — COMPLETE
- **Issue**: Nested duplicate at `a2a-network/a2a-network/` (should be removed)

### KKit-R2
- `agent-comms/SKILL.md` — OUTDATED (14 differences from BMO, see below)
- `agent-comms/messaging-sop.md` — MISSING
- `a2a-network/*` — ALL MISSING (entire skill not present)

### KKit-Skippy
- Repository is EMPTY (no commits pushed yet)

## R2 agent-comms Differences (14 items)

1. Shorter skill description in frontmatter
2. Missing Scope note differentiating from a2a-network skill
3. References `scripts/agent-send.sh` (may not exist in KKit-R2)
4. Uses raw `--data-raw` curl instead of python3 JSON generation
5. Missing "Always use python3" warning
6. Missing request fields table (peer, type, text, status, action, task, etc.)
7. Missing success/failure response format documentation
8. Old "Relay (Internet Fallback)" section — no P2P SDK docs
9. References `cc4me.config.yaml` instead of `kithkit.config.yaml`
10. References `credential-cc4me-agent-key` instead of `credential-kithkit-agent-key`
11. Uses `[Agent] Name:` tmux prefix instead of `[Network] Name:`
12. Missing P2P SDK and Legacy Relay architecture sections
13. Missing Group Messaging cross-reference note
14. No messaging-sop.md companion file

## Plan

1. BMO's skills ARE the unified reference — already the most complete
2. Only change to BMO: remove nested duplicate `a2a-network/a2a-network/`
3. Create PR for KKit-R2: replace outdated agent-comms + add messaging-sop.md + add full a2a-network
4. KKit-Skippy: repo is empty — note for comms that skills can't be PR'd until Skippy has an initial commit
