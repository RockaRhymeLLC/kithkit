# Agent Onboarding Runbook

> First documented during Skippy onboarding (2026-02-27). Use this as the playbook for all new agent setups.

## Prerequisites

- Mac mini on the local network with macOS 26+
- SSH access (user must be admin)
- System admin password stored in BMO Keychain as `credential-<name>-system-admin`
- Claude Max subscription assigned and `claude login` completed interactively (Dave)
- Telegram bot created via @BotFather, token stored in BMO Keychain as `credential-<name>-telegram-bot`
- Email account (Fastmail) for GitHub registration

## Step-by-Step

### Phase 1: Machine Prep

1. **Confirm connectivity**: `ping <IP>`, verify SSH works
2. **Enable Remote Management** (if needed):
   ```bash
   ssh <user>@<IP> "sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -activate -configure -access -on -allowAccessFor -allUsers -privs -all"
   ```
3. **Machine audit**: Check macOS version, architecture, RAM, disk space, existing software

### Phase 2: Core Software

4. **Install Homebrew**:
   - SSH PATH does not include `/opt/homebrew/bin` by default
   - Homebrew requires sudo but CANNOT run as root
   - Correct approach: Pre-auth sudo, then run installer as user:
     ```bash
     echo "$PASSWORD" | sudo -Sv && NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
     ```
   - **Issue**: Nested quoting with sshpass is tricky. Write a temp script if needed.

5. **Install Node.js 22+**:
   ```bash
   /opt/homebrew/bin/brew install node@22
   ```
   - **Issue**: Installs as `node@22`, NOT linked to standard PATH. Full path: `/opt/homebrew/Cellar/node@22/<version>/bin/node`
   - `npx`, `npm` also at that path — SSH sessions won't find them without explicit PATH

6. **Install tmux**:
   ```bash
   /opt/homebrew/bin/brew install tmux
   ```
   - Same PATH issue: `/opt/homebrew/bin/tmux`

7. **Install gh CLI** (optional, for GitHub operations):
   ```bash
   /opt/homebrew/bin/brew install gh
   ```

8. **Verify Claude CLI**: Should be at `~/.local/bin/claude` (Dave installs this)

### Phase 3: Kithkit Setup

9. **Generate SSH key for GitHub**:
   ```bash
   ssh-keygen -t ed25519 -C "<email>" -f ~/.ssh/id_ed25519 -N ""
   ```
   - Add public key to GitHub account or org

10. **Clone kithkit**:
    ```bash
    git clone git@github.com:RockaRhymeLLC/kithkit.git ~/kithkit
    ```

11. **Install dependencies**:
    ```bash
    export PATH=/opt/homebrew/Cellar/node@22/<version>/bin:/opt/homebrew/bin:$PATH
    cd ~/kithkit && npm install
    cd daemon && npm install
    ```

12. **Build daemon**:
    ```bash
    npx tsc
    ```

13. **Create identity.md**: Copy from prepared personality file or write new one. Place at `~/kithkit/identity.md`.

14. **Configure kithkit.config.yaml**: Set agent name, identity_file, daemon port, scheduler tasks. Reference existing configs for structure.

15. **Create private repo** (from BMO):
    ```bash
    gh repo create RockaRhymeLLC/KKit-<Name> --private --description "<Name>'s private kithkit instance"
    ```

### Phase 4: Extension & Telegram

16. **Create agent extension**: The base kithkit has no Telegram support. Each agent needs an extension.
    - Reference: Integration skill at `kithkit-skills-catalog/archives/kithkit-integration/recipes/telegram.md`
    - **Issue**: Integration skill is NOT in base kithkit yet (todo #65). Must be downloaded from skills catalog or copied.
    - Create extension at `daemon/src/extensions/<name>/`
    - Include: Telegram polling adapter, channel router registration, agent-comms (A2A)
    - Create `bootstrap.ts` to register extension before daemon starts

17. **Configure Telegram** in kithkit.config.yaml:
    ```yaml
    channels:
      telegram:
        enabled: true
        mode: polling
        poll_interval_ms: 3000
        bot_token: "<token>"
        safe_senders:
          - chat_id: <dave_chat_id>
            name: Dave
    ```
    - Get Dave's chat ID: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'`
    - Dave must send /start to the bot first (Telegram API requirement)

18. **Set up launchd service**:
    - Plist must point to `bootstrap.js` (not `main.js`) so extension loads
    - Service name: `com.assistant.daemon`

### Phase 5: Session & Networking

19. **Fix session-bridge** (until upstream fix lands):
    - `daemon/src/core/session-bridge.ts` line ~58: Change `return loadConfig().agent.name` to `return 'comms1'`
    - Rebuild daemon after this change
    - **Issue**: Session-bridge defaults to agent name, but standard tmux session names are `comms1` and `orch1`

20. **Start comms session**:
    ```bash
    export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH
    cd ~/kithkit
    tmux new-session -d -s comms1 'export PATH=/opt/homebrew/bin:$HOME/.local/bin:$PATH && cd ~/kithkit && claude --dangerously-skip-permissions'
    ```
    - **Issue**: Claude shows trust prompt and bypass permissions prompt. Must accept both interactively.
    - Pre-setting via `.claude/settings.local.json` does NOT bypass the bypass-permissions prompt.

21. **Bind daemon to 0.0.0.0** (for LAN access):
    - Default is now `0.0.0.0` (configurable via `daemon.bind_host` in kithkit.config.yaml)
    - If running an older build, check `main.ts` for `const HOST = '127.0.0.1'` and change it
    - Verify after restart: `grep 'listening on' logs/daemon.log | tail -1` should show `0.0.0.0:<port>`
    - Test from another machine: `curl http://<agent-ip>:3847/health`

22. **A2A network peering**:
    - Add agent-comms module to extension
    - Configure peers in kithkit.config.yaml
    - Store shared secret: `security add-generic-password -s credential-agent-comms-secret -a <name> -w "<secret>"`
    - **Issue**: Keychain operations fail over SSH. Must be done from GUI context or by the agent itself.
    - Notify existing peers to add new agent

23. **Set up email account** (Fastmail) for GitHub identity

24. **Create GitHub account** using the email (if agent needs own identity)

### Phase 6: Verification

25. **Daemon health**: `curl http://localhost:3847/health` — should show extension loaded
26. **Telegram test**: Dave sends message, agent responds via `/api/send`
27. **A2A test**: Send message from BMO, verify delivery
28. **Identity check**: Verify personality is loading correctly
    - **Issue**: Identity file not auto-loaded without a session-start hook. CLAUDE.md says to read it but agent may not.

## Known Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| Homebrew install fails | Can't run as root, needs sudo | Pre-auth sudo, run as user |
| node/npx/npm not found via SSH | `node@22` not on standard PATH | Use full path or export PATH |
| Session-bridge wrong session name | Uses `config.agent.name` not `comms1` | Hardcode `comms1` in session-bridge.ts |
| Agent personality not loading | No session-start hook to inject identity.md | Add hook or explicit CLAUDE.md instruction |
| Keychain fails over SSH | macOS requires GUI context | Run from tmux session or have Dave do it |
| Daemon unreachable from LAN | Binds to 127.0.0.1 | Set `daemon.bind_host: "0.0.0.0"` in config (or update main.ts for older builds) |
| Integration skill missing | Not in base kithkit | Download from skills catalog (todo #65) |
| Claude interactive prompts | Trust + bypass permissions | Must accept manually via tmux send-keys |
| Telegram bot can't initiate | Telegram API requires user first message | Dave sends /start to bot |

## A2A Network Verification (2026-02-27)

### Confirmed Working

| Route | Status | Notes |
|-------|--------|-------|
| BMO → R2 | OK | LAN direct, ~1s latency |
| BMO → Skippy | OK | LAN direct, ~6s latency (higher due to .local mDNS) |
| R2 → BMO | OK | Fixed by bind_host change from 127.0.0.1 to 0.0.0.0 |
| R2 → Skippy | OK | Confirmed by R2 |
| Skippy → BMO | OK | Confirmed reply received |
| Skippy → R2 | OK | Confirmed by R2 |

### Shared Secret

All agents use the same `credential-agent-comms-secret` in macOS Keychain. Bearer token auth on `/agent/message` endpoint.

### A2A Group Messaging

**Status**: LAN broadcast endpoint available (2026-02-27).

**LAN Broadcast (recommended for same-network agents)**:
- `POST /agent/broadcast` — fans out a message to ALL configured peers simultaneously
  ```json
  { "type": "text", "text": "Hello everyone!" }
  ```
  Response includes per-peer delivery results:
  ```json
  { "ok": true, "allDelivered": true, "peerCount": 2, "results": { "r2d2": { "ok": true }, "skippy": { "ok": true } } }
  ```
- `GET /agent/peers` — list configured peer names
- Consensus from R2 and BMO: LAN broadcast is simpler than full SDK group semantics for same-network agents

**P2P SDK Groups (for internet-scale)**:
- The CC4Me Network SDK has full group support: `createGroup()`, `inviteToGroup()`, `sendToGroup()`, `acceptGroupInvitation()`, etc.
- The daemon's sdk-bridge.js already wires `group-message` and `group-invitation` events to the session
- The `/agent/p2p` endpoint handles incoming group message envelopes
- **Not yet exposed via HTTP API** — needed endpoints: `/agent/group/create`, `/agent/group/invite`, `/agent/group/send`, `/agent/group/accept`, `/agent/group/list`
- All agents would need to be registered with the relay and have the cc4me-network SDK running

## Upstream Fixes Needed

These should go into the public kithkit repo so future onboarding is smoother:

1. **Session-bridge**: Use `comms1`/`orch1` constants (not agent name) — memory #159
2. **Integration skill**: Ship with kithkit for bootstrapping — todo #65
3. **Identity loading**: Add session-start hook or auto-read in CLAUDE.md
4. ~~**Daemon bind address**: Make configurable in kithkit.config.yaml (default 0.0.0.0?)~~ — DONE (2026-02-27): `daemon.bind_host` config option added, defaults to `0.0.0.0`
5. **Self-assessment endpoint**: `GET /api/selftest` for setup verification — todo #67
6. **PATH setup**: Document or auto-configure Homebrew/Node paths for SSH sessions
7. ~~**A2A group endpoints**: Expose SDK group operations via `/agent/group/*` HTTP API~~ — PARTIAL (2026-02-27): LAN broadcast (`/agent/broadcast`) deployed. Full SDK group HTTP API still TODO for internet-scale groups.
8. **mDNS latency**: Skippy uses `.local` hostname causing ~6s A2A latency vs ~1s for `.lan` — use IP or `.lan` hostnames
