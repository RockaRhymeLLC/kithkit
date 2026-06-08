# Daemon Watchdog — launchd Installation

The watchdog detects a wedged Kithkit daemon (process alive but event loop
unresponsive) and auto-kickstarts it via `launchctl kickstart`.  It runs
every 2 minutes and includes a circuit breaker that stops firing after 3
kickstarts within 10 minutes.

## Install

```bash
# 1. Substitute the real repo path AND your daemon's launchd label into the template
#    __REPO_PATH__    — absolute path to your kithkit repo checkout
#    __LAUNCHD_LABEL__ — the launchd label of your daemon plist (e.g. com.assistant.daemon)
sed \
    -e 's|__REPO_PATH__|/path/to/your/kithkit-repo|g' \
    -e 's|__LAUNCHD_LABEL__|com.assistant.daemon|g' \
    scripts/launchd/com.kithkit.daemon-watchdog.plist \
    > ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist

# 2. Load the agent
launchctl load ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist

# 3. Verify it loaded
launchctl list | grep daemon-watchdog

# 4. Watch the log
tail -f logs/watchdog.log
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist
rm ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist
```

## Upgrading an existing install

> **Required after pulling this branch.** Every already-loaded watchdog plist was
> installed from the pre-#374 template, which had no `--label` argument in
> `ProgramArguments`.  After pulling, the running plist calls the watchdog
> without `--label`, so the script falls back to the literal `__LAUNCHD_LABEL__`
> placeholder as the kickstart target.  That label does not exist, meaning
> **daemon protection is silently OFF** and a kickstart-failed message is logged
> on every 2-minute cycle.  **Skip this migration and your watchdog runs dead.**

```bash
# 1. Unload the existing watchdog plist
launchctl unload ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist

# 2. Re-substitute both placeholders into the updated template
#    (same sed command as fresh install — regenerates the plist with --label)
sed \
    -e 's|__REPO_PATH__|/path/to/your/kithkit-repo|g' \
    -e 's|__LAUNCHD_LABEL__|com.assistant.daemon|g' \
    scripts/launchd/com.kithkit.daemon-watchdog.plist \
    > ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist

# 3. Load the updated plist
launchctl load ~/Library/LaunchAgents/com.kithkit.daemon-watchdog.plist
```

Replace `/path/to/your/kithkit-repo` and `com.assistant.daemon` with the same
values you used at initial install time.

## Manual test (dry-run)

```bash
# Healthy path (daemon running):
bash scripts/daemon-watchdog.sh --dry-run --label com.assistant.daemon

# Failure path (wrong port):
bash scripts/daemon-watchdog.sh --dry-run --label com.assistant.daemon --health-url http://localhost:59999/health

# Alternatively, set the label via environment variable:
KITHKIT_LAUNCHD_LABEL=com.assistant.daemon bash scripts/daemon-watchdog.sh --dry-run
```

## Logs

| File | Purpose |
|------|---------|
| `logs/watchdog.log` | One-line events: failures, kickstarts, circuit-open alerts |
| `logs/watchdog-state` | Circuit breaker counters (key=value) |
| `logs/watchdog-stdout.log` | launchd stdout capture |
| `logs/watchdog-stderr.log` | launchd stderr capture |

## Circuit breaker

The watchdog will not fire more than **3 kickstarts in any 10-minute window**.
When the breaker trips it logs:

```
CIRCUIT OPEN: daemon may be broken, giving up until manual intervention (N kickstarts in last 10m)
```

To reset manually, delete `logs/watchdog-state` and restart the daemon:

```bash
rm logs/watchdog-state
launchctl kickstart -k gui/$(id -u)/<your-daemon-label>
```
