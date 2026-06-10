-- Migration 030: add injected_at to messages table
--
-- Ported from fork PR #23 (eaab33cd) — renumbered from 026 because upstream
-- 026-029 are already taken (agent-tokens, approval-workflow, worker-verification-fields,
-- worker-spawned-by). Ties BMO #2202 / kithkit#332.
--
-- injected_at is stamped ONLY after a confirmed successful tmux inject.
-- NULL  = message persisted but not yet injected (pending or failed delivery)
-- TEXT  = ISO-8601 UTC timestamp of confirmed delivery into the comms session
--
-- No backfill: existing rows are NULL (conservative — they will not be
-- re-injected on daemon restart since the comms session context is gone).
--
-- Used by the LAN-inbound A2A path (handleAgentMessage in agent-comms.ts)
-- to implement idempotent inject semantics: a row with injected_at IS NOT NULL
-- is never re-injected, even if the same message arrives again.
--
-- Also enables a future flush/recovery mechanism (#620) to find all pending
-- messages (injected_at IS NULL) and attempt re-delivery when comms returns.

ALTER TABLE messages ADD COLUMN injected_at TEXT;

CREATE INDEX idx_messages_injected_at ON messages(injected_at);
