# graph-m365-delegated.todos.md

> This file aggregates inline recipe TODOs for fleet tracking. It is NOT an issue-tracker substitute.
> Each entry references the source file and the section where the TODO marker appears.
> Generated from inline `<!-- TODO: ... -->` comments on 2026-05-27.

---

## From: `.claude/skills/kithkit-integration/recipes/graph-m365-delegated.md`

**TODO-D1** — `§4.1 mail.read / Setup / Extension config`
Confirm the extension config key name (`m365_delegated`) and provider value (`graph_delegated`) once the kithkit M365 delegated extension is implemented on the daemon side. The config block in §4.1 is illustrative and may not match the final implementation.

**TODO-D2** — `§4.2 mail.send / Setup / approval_policies config`
Confirm the `approval_policies` config key path and structure matches the `approval-workflow.md` implementation when it is built. The policy block in §4.2 is written against the spec, not a running implementation.

**TODO-D3** — `§4.2 mail.send / Validation Checklist / Pitfall S.3`
Add a link to the Graph API attachment upload session documentation once the canonical Microsoft Docs URL is confirmed. The upload session path (`POST /me/messages/{id}/attachments`) is referenced but not linked.

**TODO-D4** — `§4.5 teams.chat / Setup / Polling config`
Confirm the teams polling config key path (`extensions.m365_delegated.teams.poll_interval_minutes`) once the daemon extension is implemented. The config block in §4.5 is illustrative.

**TODO-D5** — `§4.5 teams.chat / Rollback Notes`
Verify whether `DELETE /me/chats/{chatId}/messages/{messageId}` is available under `Chat.ReadWrite` delegated scope in Graph API v1.0, or whether it requires elevated tenant admin permissions. Update rollback notes to reflect the confirmed path. Currently the rollback instruction is "delete from Teams client" because the API path is unconfirmed.

**TODO-D6** — `§5 End-to-End Acceptance Gate / Step 5`
Add the correct audit log query command once `GET /api/approval/decisions` (or an equivalent history endpoint) is implemented in the daemon. The current Step 5 command uses `GET /api/approval/pending`, which only surfaces in-flight items, not completed decisions. This means the acceptance gate cannot fully verify Step 5 until the history endpoint exists.

**TODO-D7** — `Appendix A — Bot Framework`
Complete Appendix A if reader demand confirms need. Items to document: separate Bot Framework app registration (distinct from the delegated M365 app), Bot Service channel registration in Azure, Teams app manifest creation and sideloading, proactive messaging pattern (conversation reference storage), adaptive card schema basics, and how Bot Framework auth coexists with the delegated OAuth token from §2.

**TODO-D8** — `Appendix B — Change-Notification Subscriptions`
Document full subscription creation, renewal, and teardown procedure if Appendix B is activated. Include delta token handling for catch-up after missed events during a subscription lapse, and a renewal scheduler pattern using the kithkit scheduler API (POST /api/scheduler/tasks).

---

## From: `.claude/skills/kithkit-integration/recipes/approval-workflow.md`

**TODO-A1** — `§Gate / Fail-closed design principle`
Define the full error taxonomy for gate failures: (a) what happens if the approval card delivery fails (Telegram down or unreachable), (b) what happens if the daemon restarts while a gate is pending (in-flight approval is orphaned), (c) what happens if the agent process crashes mid-gate. Document the recovery behavior for each case: does the pending send resume, abort silently, or re-prompt the user?

**TODO-A2** — `§Card / Redaction`
Define policy-flagged pattern detection logic. Options to evaluate: regex-based patterns (e.g., matching API key shapes, SSN formats, credential strings), ML-based classifier, or manually configured pattern list in `kithkit.config.yaml`. Document the chosen trigger criteria, who maintains the pattern list, and how redaction interacts with `content_hash` computation (hash must be over original, not redacted, content).

**TODO-A3** — `§Approval-API / GET /api/approval/pending`
Add filter query parameters (by `agent`, by `channel`, by `status`) for fleet-wide audit visibility and scripted cleanup of stale pending items. Currently the endpoint returns all pending items with no filtering.

**TODO-A4** — `§first_time_recipient / Fuzzy-match note`
Define alias table schema and population strategy. Options: (a) manual config list in `kithkit.config.yaml` mapping alias → primary, (b) Graph API `/me/contacts` lookup cross-referencing display name + domain, (c) heuristic (same display name + same tenant domain = probably the same person). Document the chosen algorithm, its failure mode when resolution is ambiguous, and what the alias table looks like in the database schema.

**TODO-A5** — `§Wiring Sequence / Step 2`
Document the exact channel-router middleware registration pattern once the extension API is finalized. Include: the hook name, the registration call signature, and how router context (channel, recipient, content, sender_agent) is passed into the `approvalGate` function. Reference the extension system docs in the kithkit-integration skill folder once they are updated for the gate middleware hook.

**TODO-A6** — `§Wiring Sequence / Step 3`
Replace the placeholder curl command in Step 3 with the correct daemon endpoint path once the M365 mail.send daemon API route (e.g., `/api/m365/send-mail` or equivalent) is implemented. Until then, readers must trigger a send via the capability's native integration path, which is not yet documented as a daemon route.

**TODO-A7** — `§Wiring Sequence / Step 5`
Add a `GET /api/approval/decisions` (or `/api/approval/history`) endpoint for querying completed decisions with filter params (by agent, by channel, by date range, by decision type). The current `GET /api/approval/pending` only surfaces in-flight items. Without a history endpoint, Step 5 of the wiring sequence and Step 5 of the acceptance gate in `graph-m365-delegated.md` cannot be fully verified programmatically.

---

## Summary

| ID | File | Section | Blocking? |
|----|------|---------|-----------|
| D1 | graph-m365-delegated.md | §4.1 Setup | When daemon M365 extension is built |
| D2 | graph-m365-delegated.md | §4.2 Setup | When approval-workflow is implemented |
| D3 | graph-m365-delegated.md | §4.2 Pitfall S.3 | No — informational link only |
| D4 | graph-m365-delegated.md | §4.5 Setup | When daemon M365 extension is built |
| D5 | graph-m365-delegated.md | §4.5 Rollback | No — fallback (Teams client) is documented |
| D6 | graph-m365-delegated.md | §5 Acceptance Gate Step 5 | Yes — acceptance gate Step 5 is incomplete without history endpoint |
| D7 | graph-m365-delegated.md | Appendix A | No — placeholder; only needed if Bot Framework demand confirmed |
| D8 | graph-m365-delegated.md | Appendix B | No — placeholder; only needed if subscriptions activated |
| A1 | approval-workflow.md | §Gate | Yes — recovery behavior must be defined before gate ships |
| A2 | approval-workflow.md | §Card | No — redaction logic can default to no-redaction initially |
| A3 | approval-workflow.md | §Approval-API GET | No — filter params are convenience, not required for v1 |
| A4 | approval-workflow.md | §first_time_recipient | Yes — alias resolution strategy must be chosen before `first_time_recipient` policy is usable |
| A5 | approval-workflow.md | §Step 2 | Yes — middleware registration pattern must be documented before gate can be wired |
| A6 | approval-workflow.md | §Step 3 | Yes — correct endpoint path needed to run Step 3 |
| A7 | approval-workflow.md | §Step 5 | Yes — history endpoint needed to verify completed decisions |
