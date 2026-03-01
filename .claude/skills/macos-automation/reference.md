# macOS Automation Guide

Reference for controlling and automating macOS from the command line.

## Current Status (Tested 2026-01-28)

### Works Without Extra Permissions
- Display notifications
- Display dialogs (with buttons)
- Clipboard read/write (osascript and pbcopy/pbpaste)
- List running applications (System Events)
- Finder scripting (paths, folders)
- Safari URL reading and opening
- Terminal script execution (new tabs)
- Chrome scripting (when windows open)

### Requires Accessibility Permissions
- Keystrokes (System Events)
- Mouse clicks
- Menu bar access
- Window manipulation
- Button clicks in other apps

**Error seen**: "osascript is not allowed assistive access" (-1719)

To enable: System Settings > Privacy & Security > Accessibility > Add Terminal.app

## AppleScript / osascript

Run AppleScript commands from bash:

```bash
# Basic syntax
osascript -e 'tell application "Finder" to activate'

# Multi-line
osascript <<EOF
tell application "Safari"
    activate
    open location "https://example.com"
end tell
EOF
```

### Common AppleScript Commands

```applescript
# Open an app
tell application "Safari" to activate

# Get frontmost app
tell application "System Events" to get name of first process whose frontmost is true

# Click menu item
tell application "System Events"
    tell process "Safari"
        click menu item "New Window" of menu "File" of menu bar 1
    end tell
end tell

# Keystroke
tell application "System Events"
    keystroke "v" using command down  -- Cmd+V (paste)
end tell

# Notification
display notification "Hello!" with title "Assistant" sound name "default"
```

## Accessibility Permissions

Many automation features require accessibility access:

1. **System Settings > Privacy & Security > Accessibility**
2. Add Terminal.app (or the app running commands)
3. Toggle on

Check if enabled:
```bash
# This will fail if accessibility is not granted
osascript -e 'tell application "System Events" to keystroke ""'
```

## Playwright (Browser Automation)

Best for complex browser interactions. Already configured as MCP server.

```javascript
// Via Playwright MCP
// Use playwright_navigate, playwright_click, playwright_fill, etc.
```

Advantages:
- Handles dynamic pages
- Waits for elements automatically
- Screenshots, PDFs

Limitations:
- Can't bypass CAPTCHAs (Cloudflare "verify you're human")
- Some sites detect automation

## open Command

Built-in macOS command for opening files/URLs/apps:

```bash
# Open URL in default browser
open "https://example.com"

# Open file in default app
open document.pdf

# Open with specific app
open -a "Safari" "https://example.com"

# Open app
open -a "Calculator"

# Reveal in Finder
open -R /path/to/file
```

## Window Management

```bash
# List windows (requires accessibility)
osascript -e 'tell application "System Events" to get name of every window of every process'

# Get window of specific app
osascript -e 'tell application "Safari" to get bounds of front window'

# Move/resize window
osascript <<EOF
tell application "Safari"
    set bounds of front window to {0, 0, 1200, 800}
end tell
EOF
```

## Clipboard

```bash
# Copy to clipboard
echo "Hello" | pbcopy

# Paste from clipboard
pbpaste

# Copy file contents
pbcopy < file.txt
```

## Notifications

```bash
# Display notification
osascript -e 'display notification "Message" with title "Title"'

# With sound
osascript -e 'display notification "Message" with title "Title" sound name "Ping"'

# Alert dialog (blocks)
osascript -e 'display dialog "Hello" with title "Assistant"'
```

## System Information

```bash
# Screen size
system_profiler SPDisplaysDataType | grep Resolution

# Current user
whoami

# Hostname
hostname

# macOS version
sw_vers

# Running processes
ps aux

# Active network
networksetup -listallhardwareports
```

## cliclick (Keyboard/Mouse Simulation)

Install: `brew install cliclick`

```bash
# Click at coordinates
cliclick c:100,200

# Double-click
cliclick dc:100,200

# Move mouse
cliclick m:100,200

# Type text
cliclick t:"Hello World"

# Key press
cliclick kp:return
cliclick kp:cmd+v
```

Note: Requires accessibility permission.

## Finder Operations

```bash
# Get selected files in Finder
osascript -e 'tell application "Finder" to get selection as alias list'

# Open folder in new Finder window
osascript -e 'tell application "Finder" to make new Finder window to folder "Documents" of home'

# Set Finder view
osascript -e 'tell application "Finder" to set current view of front window to list view'
```

## Safari Automation

```bash
# Open URL
osascript -e 'tell application "Safari" to open location "https://example.com"'

# Get current URL
osascript -e 'tell application "Safari" to get URL of current tab of front window'

# Get page source
osascript -e 'tell application "Safari" to get source of document 1'

# Execute JavaScript
osascript -e 'tell application "Safari" to do JavaScript "document.title" in current tab of first window'
```

## Shortcuts App

Create complex automations in Shortcuts.app, run from CLI:

```bash
# Run a shortcut
shortcuts run "My Shortcut"

# With input
echo "Hello" | shortcuts run "My Shortcut"

# List shortcuts
shortcuts list
```

## Useful Patterns

### Wait for App to Launch
```bash
osascript <<EOF
tell application "Safari" to activate
delay 2
tell application "Safari" to open location "https://example.com"
EOF
```

### Check if App is Running
```bash
osascript -e 'tell application "System Events" to (name of processes) contains "Safari"'
```

### Get Frontmost App Name
```bash
osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'
```

## Limitations

1. **CAPTCHA/Bot Detection**: Sites like Cloudflare can detect automation
2. **Accessibility Required**: Many operations need explicit permission
3. **Timing Issues**: May need delays between actions
4. **App Sandboxing**: Some apps restrict automation
5. **Security Prompts**: macOS may show permission dialogs

## Best Practices

1. **Use native tools when possible**: `open`, `pbcopy`, etc. don't need special permissions
2. **Request permissions upfront**: Note what accessibility permissions are needed
3. **Add delays**: Use `sleep` or AppleScript `delay` for timing
4. **Error handling**: Check command exit codes
5. **Prefer Playwright for web**: More reliable than AppleScript for browser automation
