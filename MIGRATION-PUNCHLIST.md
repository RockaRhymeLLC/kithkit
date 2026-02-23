# BMO Migration Punchlist: CC4Me-BMO → KKit-BMO

Migration from `~/CC4Me-BMO` (CC4Me v1) to `~/KKit-BMO` (Kithkit v2 framework).

**Authoritative source for what moves where**: `/Users/bmo/Public/migration-inventory.csv`

**Key principle**: Integrations (Telegram, email, voice, A2A, browser) are rebuilt fresh via recipe skills once running in KKit-BMO, using CC4Me-BMO as reference material — not ported.

---

## Pre-Move (do while still running from CC4Me-BMO)

- [x] **1. Verify daemon builds and starts** — ✅ 2026-02-22
- [x] **2. Fix system prompt wiring** — ✅ 2026-02-22 (identity.md at repo root)
- [x] **3. Create logs/ directory** — ✅ 2026-02-22
- [x] **4. Update launchd plists** — ✅ 2026-02-22. **NOTE**: Use `bootstrap.js` not `main.js` — see SOP gotcha #2
- [x] **5. Set up Claude Code project memory** — ✅ 2026-02-22
- [x] **6. Ensure projects/ dir exists at repo root** — ✅ 2026-02-22

## Post-Move (verify after cutover)

- [x] **7. Daemon health** — ✅ 2026-02-22. `{"status":"ok","extension":"bmo"}` with 19 scheduler tasks
- [x] **8. Session starts with identity** — ✅ 2026-02-22. BMO personality loads, `/status` shows agent: BMO
- [x] **9. Context watchdog fires** — ✅ 2026-02-22. Required fix: core tasks weren't registered (see SOP gotcha #4). Fixed by calling `registerCoreTasks()` in extension init.
- [x] **10. Selectively import state from CC4Me-BMO** — ✅ 2026-02-22
  - Imported 8 future calendar events (BCPS camp, Madrid trip, cert expirations)
  - Imported 5 active todos (3 blocked, 1 in-progress, 1 pending) + 2 new follow-up todos
  - Memories: deferred — CC4Me had 1,469 memories, will import high-value ones incrementally via daemon memory API
- [ ] **11. Set up Telegram** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/comms/adapters/telegram.ts` and `~/CC4Me-BMO/scripts/telegram-send.sh`
- [ ] **12. Set up email** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/comms/adapters/email/`
- [ ] **13. Set up A2A / agent-comms** — install cc4me-network SDK fresh, rebuild integration, reference `~/CC4Me-BMO/daemon/src/comms/network/`
- [ ] **14. Set up voice** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/voice/`. **NOTE**: voice is disabled in config until Python venv is set up (see SOP gotcha #3)
- [ ] **15. Verify Telegram delivery** — send + receive works both directions
- [ ] **16. Verify agent-comms with R2** — send a ping, confirm she receives it
- [x] **17. Verify all scheduler tasks fire** — ✅ 2026-02-22. 19 tasks registered, context-watchdog manually triggered: success
- [ ] **18. Save-state → restart cycle works** — infrastructure verified (hook, state files, daemon), full cycle test pending

## Not Migrating (per inventory decisions)

These are deliberately excluded — see migration-inventory.csv for rationale:
- Transcript stream (D-B05) — replaced by explicit POST /send
- Session-start hook (H-B01) — replaced by daemon bootstrap API
- Notify-response hook (H-B03) — replaced by explicit POST /send
- Email/setup/telegram/upstream/worker-agent skills (S-B04/08/09/10/11) — retired or replaced by framework
- File-based state (.claude/state/ bulk) — SQLite handles state; only assistant-state.md remains as file
- append-state-log.sh, telegram-send.sh, agent-send.sh scripts — reference only for recipe builds

## Reference

- **Migration inventory**: `/Users/bmo/Public/migration-inventory.csv`
- **CC4Me-BMO**: `~/CC4Me-BMO/` — keep as reference during post-move integration work
- **Kithkit public repo**: `~/kithkit/` — framework upstream @ c39a7be
- **KKit-BMO private repo**: `~/KKit-BMO/` — BMO's instance @ ef15680
