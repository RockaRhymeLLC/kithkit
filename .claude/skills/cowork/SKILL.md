---
name: cowork
description: Shared browser sessions between BMO and Dave. Connect to Dave's Chrome via CDP to see and interact with the same browser. Use when co-browsing, pair-debugging, or sharing a browser session.
argument-hint: [start | stop | look | screenshot | status | help]
user-invocable: true
allowed-tools: Bash(curl*), Bash(node*), mcp__playwright__*
---

# Cowork — Shared Browser Sessions

Connect to Dave's Chrome browser via Chrome DevTools Protocol (CDP) to see and interact with the same pages he's viewing.

## Quick Start

```
/cowork start              # Connect to Dave's Chrome
/cowork look               # Accessibility snapshot of current page
/cowork screenshot         # Save screenshot of current page
/cowork status             # Check connection and list tabs
/cowork stop               # Disconnect (leaves Dave's Chrome running)
```

## How It Works

1. Dave launches Chrome on his MacBook with remote debugging enabled
2. BMO connects via CDP to the same browser instance
3. BMO can see tabs, take snapshots, screenshots, and interact with pages
4. Disconnecting leaves Dave's Chrome untouched

## Commands

Parse `$ARGUMENTS` to determine which command to run.

### `start` — Connect to Dave's Chrome

1. Check if Dave's Chrome is reachable:
```bash
node .claude/skills/cowork/scripts/cdp-status.mjs 192.168.12.147 9222
```

2. If **unreachable**, send Dave the launch instructions via Telegram (see "Dave's Setup" section below). Wait for him to confirm Chrome is running, then retry.

3. If **reachable**, report the connection status and available tabs. The session is now active — use `look` and `screenshot` commands to interact.

### `look` — Accessibility Snapshot

Get the accessibility tree of the active page tab:
```bash
node .claude/skills/cowork/scripts/cdp-snapshot.mjs 192.168.12.147 9222 0
```

The third argument is the tab index (0 = first page tab). Shows page structure, headings, links, buttons, form fields, and text content.

### `screenshot` — Save Screenshot

Capture a PNG screenshot of a page tab:
```bash
node .claude/skills/cowork/scripts/cdp-screenshot.mjs 192.168.12.147 9222 /path/to/output.png 0
```

Arguments: `host port output_path tab_index`

Save screenshots to the session directory:
```
.claude/sessions/orchestrator/cowork-screenshot-$(date +%H%M%S).png
```

After saving, read the screenshot file with the Read tool to view it.

### `status` — Connection Status

```bash
node .claude/skills/cowork/scripts/cdp-status.mjs 192.168.12.147 9222
```

Shows Chrome version, protocol version, and all open page tabs.

### `stop` — Disconnect

No persistent connection to close — each command connects and disconnects automatically. Just stop issuing commands. Dave's Chrome keeps running.

### `help` — Dave's Setup Instructions

Display or send Dave the Chrome launch instructions below.

## Dave's Setup

When Dave needs to start a cowork session, send these instructions via Telegram:

### Launch Command

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  '--remote-allow-origins=*' \
  --user-data-dir=/tmp/chrome-cowork \
  --no-first-run \
  --no-default-browser-check
```

**Important**: The `--remote-allow-origins=*` flag must be quoted in zsh to avoid glob expansion.

### Why Each Flag

| Flag | Purpose |
|------|---------|
| `--remote-debugging-port=9222` | Enable CDP server on port 9222 |
| `--remote-debugging-address=0.0.0.0` | Listen on all interfaces (required for LAN) |
| `--remote-allow-origins=*` | Allow WebSocket connections from BMO's machine |
| `--user-data-dir=/tmp/chrome-cowork` | Separate profile — Chrome blocks CDP on default profile |
| `--no-first-run` | Skip first-run wizard |
| `--no-default-browser-check` | Skip default browser prompt |

### Firewall

If macOS firewall is enabled: **System Settings → Network → Firewall → Options → Allow Chrome**

### Quick Verify

Dave can test locally: `curl http://localhost:9222/json/version`
BMO tests remotely: `curl http://192.168.12.147:9222/json/version`

## CDP Tab Management (Direct REST API)

For simple tab operations, no WebSocket needed:

```bash
# List all tabs
curl -s http://192.168.12.147:9222/json/list

# Open new tab
curl -s http://192.168.12.147:9222/json/new?https://example.com

# Close a tab by ID
curl -s http://192.168.12.147:9222/json/close/{tabId}

# Browser version info
curl -s http://192.168.12.147:9222/json/version
```

## Implementation Notes

- **Scripts use Node.js only** (built-in WebSocket, no dependencies). Located in `scripts/` directory.
- **Each command is stateless** — connects, performs action, disconnects. No persistent connection to manage.
- **Tab index filtering**: Scripts filter to `type: "page"` tabs only, skipping extensions and service workers.
- **WebSocket URL fixup**: Chrome reports `localhost` in WS URLs even when accessed remotely. Scripts auto-replace with the target host.
- **Tested locally**: All scripts verified working against Chrome 145 on macOS with clean exit codes.

## Scripts

| Script | Purpose | Args |
|--------|---------|------|
| `cdp-status.mjs` | Check connection, list tabs | `host port` |
| `cdp-screenshot.mjs` | Capture PNG screenshot | `host port output_path tab_index` |
| `cdp-snapshot.mjs` | Accessibility tree snapshot | `host port tab_index` |

## Stretch Goals (Future)

- **Desktop sharing**: VNC/screen sharing for full desktop access beyond browser
- **Persistent sessions**: Auto-reconnect if Chrome restarts
- **Tab notifications**: Alert BMO when Dave switches tabs
- **Collaborative annotations**: BMO highlights elements for Dave
