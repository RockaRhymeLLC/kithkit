---
name: macos-automation
description: macOS automation patterns — AppleScript/osascript, accessibility, clipboard, notifications, window management. Use when automating macOS system tasks.
user-invocable: false
---

# macOS Automation

Reference for controlling and automating macOS from the command line.

## Quick Patterns

### Notifications
```bash
osascript -e 'display notification "Message" with title "Assistant" sound name "Ping"'
```

### Clipboard
```bash
echo "text" | pbcopy    # Copy
pbpaste                  # Paste
```

### Open URLs/Apps
```bash
open "https://example.com"        # URL in default browser
open -a "Calculator"               # Launch app
open -R /path/to/file              # Reveal in Finder
```

### AppleScript
```bash
osascript -e 'tell application "Safari" to activate'
osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'
```

## Permissions

Many automation features require **Accessibility access**:
- System Settings > Privacy & Security > Accessibility > Terminal.app
- Needed for: keystrokes, mouse clicks, menu bar access, window manipulation

Works without permissions: notifications, dialogs, clipboard, Finder scripting, `open` command.

## References

- [reference.md](reference.md) — Full macOS automation reference with AppleScript, Safari, cliclick, Shortcuts, and more
