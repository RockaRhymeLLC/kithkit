# BMO Migration Punchlist: CC4Me-BMO → KKit-BMO

Migration from `~/CC4Me-BMO` (CC4Me v1) to `~/KKit-BMO` (Kithkit v2 framework).

**Authoritative source for what moves where**: `/Users/bmo/Public/migration-inventory.csv`

**Key principle**: Integrations (Telegram, email, voice, A2A, browser) are rebuilt fresh via recipe skills once running in KKit-BMO, using CC4Me-BMO as reference material — not ported.

---

## Pre-Move (do while still running from CC4Me-BMO)

- [ ] **1. Verify daemon builds and starts** — `cd ~/KKit-BMO && npm run build && node daemon/dist/main.js` — confirm health check passes
- [ ] **2. Fix system prompt wiring** — `start.sh` reads `.claude/state/system-prompt.txt` but kithkit uses `identity.md`. Either update `start.sh` to read `identity.md` or symlink/copy
- [ ] **3. Create logs/ directory** — `mkdir ~/KKit-BMO/logs` — daemon and launchd plists need it
- [ ] **4. Update launchd plists** — all 3 point to CC4Me-BMO, need to point to KKit-BMO:
  - `com.bmo.daemon.plist` — WorkingDirectory + daemon entry point path (`daemon/dist/main.js` not `daemon/dist/core/main.js`)
  - `com.assistant.bmo.plist` — WorkingDirectory + start-tmux.sh path
  - `com.bmo.restart-watcher.plist` — WorkingDirectory + restart-watcher.sh path
- [ ] **5. Set up Claude Code project memory** — create `~/.claude/projects/-Users-bmo-KKit-BMO/memory/MEMORY.md` (or migrate from CC4Me-BMO equivalent)
- [ ] **6. Ensure projects/ dir exists at repo root** — `mkdir -p ~/KKit-BMO/projects` for specs/plans/stories/tests

## Post-Move (verify after cutover)

- [ ] **7. Daemon health** — `curl http://localhost:3847/health` returns OK
- [ ] **8. Session starts with identity** — BMO personality loads, system prompt present
- [ ] **9. Context watchdog fires** — verify scheduler task runs (check logs)
- [ ] **10. Selectively import state from CC4Me-BMO** (O-06 from inventory):
  - Review and import relevant memories (many reference old patterns — rewrite stale refs)
  - Review and import relevant todos (check accuracy against new architecture)
  - Import calendar entries if any are still active
- [ ] **11. Set up Telegram** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/comms/adapters/telegram.ts` and `~/CC4Me-BMO/scripts/telegram-send.sh`
- [ ] **12. Set up email** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/comms/adapters/email/`
- [ ] **13. Set up A2A / agent-comms** — install cc4me-network SDK fresh, rebuild integration, reference `~/CC4Me-BMO/daemon/src/comms/network/`
- [ ] **14. Set up voice** — rebuild via recipe, reference `~/CC4Me-BMO/daemon/src/voice/` and `~/CC4Me-BMO/voice-client/`
- [ ] **15. Verify Telegram delivery** — send + receive works both directions
- [ ] **16. Verify agent-comms with R2** — send a ping, confirm she receives it
- [ ] **17. Verify all scheduler tasks fire** — check logs for errors on configured tasks
- [ ] **18. Save-state → restart cycle works** — test full context management loop

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
