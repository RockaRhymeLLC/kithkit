# Skills Reference

Kithkit ships with 21 built-in skills. Skills are Claude Code slash commands (or auto-loaded reference docs) that give your agent structured capabilities. Each skill's full documentation lives in `.claude/skills/<name>/SKILL.md`.

## User-Invocable Skills

These are triggered via `/command` in the Claude Code session.

### Development Workflow

| Skill | Command | Description |
|-------|---------|-------------|
| spec | `/spec` | Create or update specification documents using the spec-driven workflow |
| plan | `/plan` | Create implementation plans with stories and tests from a spec |
| review | `/review` | Pre-build review using a devil's advocate sub-agent and optional peer review |
| build | `/build` | Implement features by working through stories and verifying tests |
| validate | `/validate` | Verify alignment between spec, plan, and implementation |

### State Management

| Skill | Command | Description |
|-------|---------|-------------|
| todo | `/todo` | Persistent cross-session to-dos via the daemon HTTP API |
| memory | `/memory` | Store and retrieve persistent facts across sessions |
| calendar | `/calendar` | Check macOS Calendar events and manage the assistant's schedule, reminders, and deadlines |
| save-state | `/save-state` | Save current session state as a checkpoint before restart or compaction |
| restart | `/restart` | Graceful session restart — save state, notify, and relaunch |

### Automation & Tools

| Skill | Command | Description |
|-------|---------|-------------|
| hooks | `/hooks` | Create and manage Claude Code hooks for automating workflows |
| mode | `/mode` | View or change the assistant's autonomy mode (yolo, confident, cautious, supervised) |
| remind | `/remind` | Set timed reminders delivered via the active notification channel |
| playwright-cli | `/playwright-cli` | Browser automation for web testing, form filling, screenshots, and data extraction |
| kithkit | `/kithkit` | Discover, install, and manage skills from the Kithkit catalog |

## Reference Skills

These are loaded automatically when the agent's current task matches the skill's context. They provide guidance and patterns rather than interactive commands.

| Skill | Auto-loads when... | Description |
|-------|-------------------|-------------|
| browser | Task requires web browsing | Browser automation SOP — choose local Playwright (free) vs Browserbase cloud (metered) |
| email-compose | Sending formatted emails | Professional HTML email templates with responsive layouts and bulletproof buttons |
| keychain | Working with secrets or credentials | macOS Keychain credential storage — naming conventions, store/retrieve/delete patterns |
| macos-automation | Automating macOS tasks | AppleScript/osascript patterns, accessibility, clipboard, notifications, window management |
| web-design | Building web UIs | Modern web design patterns, accessibility standards (WCAG 2.1 AA), responsive layouts |
| skill-create | Creating new skills | Best practices for building new Claude Code skills |

## Adding Your Own Skills

Create a new skill directory in `.claude/skills/` with a `SKILL.md` file. Use `/skill-create` for a guided walkthrough, or see the [Claude Code skills documentation](https://code.claude.com/docs/en/skills) for the format specification.

Agent-specific skills (skills that reference your agent's integrations, personality, or personal data) should live in your agent extension repo, not in the kithkit framework.

## Installing Skills from the Catalog

The Kithkit catalog provides community and official skill packages:

```bash
# Search for skills
npx kithkit search "telegram"

# Install a skill
npx kithkit install @kithkit/telegram

# List installed catalog skills
npx kithkit list
```
