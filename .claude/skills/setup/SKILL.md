---
name: setup
description: Interactive setup wizard for configuring the assistant after cloning. Creates state files and configures identity, autonomy, and integrations.
argument-hint: [start | identity | autonomy | integrations | all]
---

# Setup Wizard

Interactive wizard to configure the assistant after cloning the CC4Me template.

## Pre-Setup Installation

Before running the setup wizard, the user needs to complete these steps (guide them if needed):

### Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| macOS (Ventura 13+) | Yes | - |
| Homebrew | Yes | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` |
| Node.js v18+ | Yes | `brew install node` |
| Claude Code CLI | Yes | `npm install -g @anthropic-ai/claude-code` |
| Claude Pro or Max subscription | Yes | [claude.ai](https://claude.ai) — Max recommended for heavy autonomous use |
| tmux | Yes | `brew install tmux` |
| jq | Yes | `brew install jq` |
| Git | Yes | `brew install git` |
| Cloudflared (for Telegram) | Optional | `brew install cloudflare/cloudflare/cloudflared` |

### Installation Steps

```bash
# 1. Clone the template
git clone https://github.com/RockaRhyme/CC4Me.git my-assistant
cd my-assistant

# 2. Run initialization (checks prerequisites, makes scripts executable)
./scripts/init.sh

# 3. Build the daemon
cd daemon && npm install && npm run build && cd ..

# 4. Copy and customize config
cp cc4me.config.yaml.template cc4me.config.yaml
# Edit cc4me.config.yaml: set agent.name, tmux.session, enable channels as needed

# 5. Set up daemon as background service
cp launchd/com.assistant.daemon.plist.template ~/Library/LaunchAgents/com.assistant.daemon.plist
# Edit plist: replace __PROJECT_DIR__ and __HOME_DIR__ with actual paths
launchctl load ~/Library/LaunchAgents/com.assistant.daemon.plist

# 6. Verify daemon is running
curl http://localhost:3847/health

# 7. Start Claude Code
./scripts/start.sh

# 8. Run the setup wizard
> /setup
```

## Usage

- `/setup` or `/setup start` - Run full setup wizard
- `/setup identity` - Configure identity only
- `/setup autonomy` - Configure autonomy mode only
- `/setup integrations` - Configure integrations only
- `/setup all` - Run all setup steps

## What Gets Configured

### 1. Identity & System Prompt
- Assistant name
- Personality traits (optional)
- Core directives

Creates:
- `.claude/state/identity.json`
- `.claude/state/system-prompt.txt` (loaded at startup via `--append-system-prompt`)

### 2. Autonomy Mode
- Choose default autonomy level
- Explain each mode
- Set initial mode

Creates: `.claude/state/autonomy.json`

### 3. Safe Senders
- Add Telegram user IDs
- Add email addresses
- Configure trust levels

Creates: `.claude/state/safe-senders.json`

### 4. Integrations

#### Claude Subscription
- Verify the user has Claude Pro or Max (not an API key)
- Claude Code authenticates directly through the subscription
- Max plan recommended for heavy autonomous usage

#### Telegram Bot
1. Guide user to create bot via @BotFather
2. Get bot token
3. Store: `security add-generic-password -a "assistant" -s "credential-telegram-bot" -w "TOKEN" -U`
4. Get user's chat ID (message bot, check getUpdates endpoint)
5. Add to safe-senders.json
6. Set up Cloudflare tunnel:
   - Guide through `cloudflared tunnel create`
   - Or run `node scripts/telegram-setup/setup.js` for interactive setup
7. Register webhook with Telegram API
8. Start transcript watcher for responses

#### Email (choose one or both)

**Option A: Fastmail (simplest)**
1. Guide to Fastmail Settings > Privacy & Security > Integrations > API tokens
2. Get email address and API token
3. Store email: `security add-generic-password -a "assistant" -s "credential-fastmail-email" -w "EMAIL" -U`
4. Store token: `security add-generic-password -a "assistant" -s "credential-fastmail-token" -w "TOKEN" -U`
5. Test: `node scripts/email/jmap.js inbox`

**Option B: Microsoft 365 / Graph API (custom domain)**
1. Guide through Azure AD app registration at portal.azure.com
2. Required permissions: Mail.ReadWrite, Mail.Send, User.Read.All
3. Optional permissions: Calendars.ReadWrite, Contacts.ReadWrite, Tasks.ReadWrite.All
4. Create client secret
5. Store credentials:
   - `credential-azure-client-id`
   - `credential-azure-tenant-id`
   - `credential-azure-secret-value`
   - `credential-graph-user-email`
6. Test: `node scripts/email/graph.js inbox`

See `.claude/skills/email/graph-reference.md` for detailed Azure setup.

#### Persistent Session
1. Explain tmux-based persistent sessions
2. Guide through `./scripts/start-tmux.sh --detach`
3. Show `./scripts/attach.sh` for reattaching
4. Explain that the session survives terminal closes

#### Scheduled Jobs
Present available launchd jobs and offer to install selected ones:
- **Email reminder** - Check inbox every 15 minutes
- **Todo reminder** - Check for overdue/high-priority items every 30 minutes
- **Context watchdog** - Monitor context usage, auto-save before limits
- **Gateway** - Keep Telegram webhook receiver running

For each selected job:
1. Copy template from `launchd/` to `~/Library/LaunchAgents/`
2. Replace `YOUR_USERNAME` with actual username
3. Update project directory paths
4. Load with `launchctl load`

#### Channel Preferences
Ask user's preferred notification channel:
- **telegram** - Responses sent via Telegram (requires bot setup)
- **terminal** - Responses shown in terminal only
- **silent** - No automatic notifications; use telegram-send.sh for explicit sends

Write choice to `.claude/state/channel.txt`

### 5. CC4Me Network (Optional)

Enable internet-scale agent-to-agent communication via the CC4Me Relay:

1. Add to `cc4me.config.yaml`:
   ```yaml
   network:
     enabled: true
     relay_url: "https://relay.bmobot.ai"
     owner_email: "agent@example.com"
   ```
2. Restart daemon — it will auto-generate an Ed25519 keypair and register with the relay
3. Identity key stored as `credential-cc4me-agent-key` in Keychain (auto-generated, never manual)
4. Registration starts as "pending" — relay admin must approve via `POST /registry/agents/:name/approve`
5. Once approved, agent can send/receive messages over the internet
6. Add `relay-inbox-poll` task to scheduler (interval: 30s) to poll for incoming messages

Creates: `credential-cc4me-agent-key` in Keychain (auto)

### 6. Memory Initialization
- Copy memory template
- Add initial facts about user (name, preferences mentioned during setup)

Creates: `.claude/state/memory.md`

### 7. Calendar Initialization
- Copy calendar template
- Ready for use

Creates: `.claude/state/calendar.md`

## Workflow

### Full Setup (`/setup` or `/setup start`)

1. **Welcome**
   - Explain what CC4Me is
   - Overview of setup process

2. **Identity Configuration**
   - Ask: "What would you like to call me?"
   - Ask: "Any personality traits? (optional)"
   - Create identity.json
   - Generate system-prompt.txt from template (replaces {{NAME}} and {{PERSONALITY}})

3. **Autonomy Mode**
   - Explain the four modes
   - Ask: "Which mode would you like to start with?"
   - Recommend `confident` for new users
   - Create autonomy.json with chosen mode

4. **Safe Senders**
   - Ask: "Do you want to configure Telegram integration?"
   - If yes: Get chat ID
   - Ask: "Do you want to configure email integration?"
   - If yes: Get email address
   - Create safe-senders.json

5. **Integrations**
   - If Telegram: Guide through bot token + tunnel setup
   - If Email: Present Fastmail vs M365 options, guide through chosen provider
   - Store all credentials in Keychain

6. **Persistent Session**
   - Explain tmux session benefits
   - Offer to start a persistent session now

7. **Scheduled Jobs**
   - Present available launchd jobs
   - Install selected ones

8. **Channel Preferences**
   - Ask preferred notification channel
   - Write to channel.txt

9. **Initialize State Files**
   - Copy memory.md.template to memory.md
   - Copy calendar.md.template to calendar.md

10. **Summary**
    - Show what was configured
    - List all active integrations
    - Show running services
    - Explain next steps

## Output Format

### Welcome
```
# Welcome to CC4Me Setup

I'll help you configure your personal assistant.

We'll set up:
1. My identity (what to call me)
2. Autonomy mode (how much freedom I have)
3. Safe senders (who I trust)
4. Integrations (Telegram, email — optional)
5. Persistent session (tmux)
6. Scheduled jobs (optional)

Ready? Let's begin...
```

### Completion
```
## Setup Complete!

Here's what I configured:
- Identity: "Jarvis"
- Autonomy: confident
- Safe Senders: Telegram (1 user), Email (1 address)
- Integrations: Telegram bot, Fastmail email
- Session: Running in tmux (detached)
- Scheduled Jobs: email-reminder, context-watchdog

Your assistant is ready. Try:
- Send a Telegram message to test the bot
- `/todo add "My first to-do"`
- `/email check`
- `/memory add "Important fact"`
```

## State File Templates

The setup process copies from `.template` files:

- `autonomy.json.template` > `autonomy.json`
- `identity.json.template` > `identity.json`
- `safe-senders.json.template` > `safe-senders.json`
- `memory.md.template` > `memory.md`
- `calendar.md.template` > `calendar.md`
- `system-prompt.txt.template` > `system-prompt.txt` (with {{NAME}} and {{PERSONALITY}} replaced)

## System Prompt

The system prompt file (`.claude/state/system-prompt.txt`) is loaded at startup via `--append-system-prompt`. This provides:

- **Identity**: Name and personality at the system level
- **Core Directives**: Always-on behaviors like checking memory, respecting autonomy
- **Communication Style**: How to interact with the user

To use the system prompt, start Claude with:
```bash
./scripts/start.sh
```

## Troubleshooting

### Daemon won't start
- Verify Node.js 18+: `node --version`
- Check daemon is built: `ls daemon/dist/core/main.js`
- If missing, build it: `cd daemon && npm install && npm run build`
- Check plist paths are correct: `cat ~/Library/LaunchAgents/com.assistant.daemon.plist`
- Check logs: `tail -f logs/daemon-stderr.log`

### tmux session won't start
- Check if session exists: `tmux ls`
- Kill stuck session: `tmux kill-session -t assistant`
- Try again: `./scripts/start-tmux.sh --detach`

### Telegram messages not arriving
- Check daemon is running: `curl http://localhost:3847/health`
- Verify tunnel is active: `cloudflared tunnel list`
- Check bot token: `security find-generic-password -s "credential-telegram-bot" -w`
- Review daemon logs: `tail -f logs/daemon-stderr.log`

### Email sending fails
- Verify credentials: `security find-generic-password -s "credential-fastmail-token" -w`
- For M365: check Azure app permissions in portal.azure.com
- Check daemon status: `curl http://localhost:3847/status`

### Scripts not executable
Run: `chmod +x scripts/*.sh .claude/hooks/*.sh`

### Keychain access issues
- Keychain may need to be unlocked after restart
- Check permissions in Keychain Access app
- Re-store credentials if needed

## Verification

After setup, verify everything works:

```bash
# Check tmux session
tmux ls

# Check daemon health
curl http://localhost:3847/health

# Inside Claude Code:
> /todo list           # Should show empty list
> /memory              # Should show empty memory
> /mode                # Should show current autonomy mode
```

## Updating CC4Me

```bash
# Add upstream remote (one time)
git remote add upstream https://github.com/RockaRhyme/CC4Me.git

# Fetch and merge updates
git fetch upstream
git merge upstream/main

# Re-run init if scripts changed
./scripts/init.sh
```

## Customization

- **Personality**: Edit `.claude/state/system-prompt.txt`
- **Behavior rules**: Edit `.claude/CLAUDE.md`
- **Autonomy**: `/mode <level>` or edit `.claude/state/autonomy.json`
- **Skills**: Add new skills in `.claude/skills/` or use `/skill-create`
- **Hooks**: Configure in `.claude/settings.json` — see `/hooks` skill

## Notes

- Setup can be re-run anytime to update configuration
- Individual sections can be configured separately
- Credentials never stored in plain text (always Keychain)
- User can edit state files directly after setup
