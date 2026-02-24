---
name: cowork
description: Shared browser sessions between BMO and Dave. Connect to Dave's Chrome via CDP over SSH tunnel to see and interact with the same browser. Use when co-browsing, pair-debugging, or sharing a browser session.
argument-hint: [start | stop | look | screenshot | status | help]
user-invocable: true
allowed-tools: Bash(curl*), Bash(node*), Bash(ssh*), Bash(pgrep*), Bash(kill*), mcp__playwright__*
---

# Cowork — Shared Browser Sessions

Connect to Dave's Chrome browser via Chrome DevTools Protocol (CDP) over an SSH tunnel to see and interact with the same pages he's viewing.

## Quick Start

```
/cowork start              # Set up tunnel + connect to Dave's Chrome
/cowork look               # Accessibility snapshot of current page
/cowork screenshot         # Save screenshot of current page
/cowork status             # Check connection and list tabs
/cowork stop               # Tear down SSH tunnel
```

## How It Works

1. Dave launches Chrome on his MacBook with remote debugging on localhost
2. BMO sets up an SSH tunnel: local port 9223 → Dave's localhost:9222
3. BMO connects via CDP through the tunnel to the same browser instance
4. BMO can see tabs, take snapshots, screenshots, and interact with pages
5. Disconnecting tears down the tunnel; Dave's Chrome keeps running

## Commands

Parse `$ARGUMENTS` to determine which command to run.

### `start` — Connect to Dave's Chrome

1. **Set up the SSH tunnel** (if not already running):
```bash
# Check if tunnel is already up
pgrep -f "ssh.*-L 9223:localhost:9222" > /dev/null 2>&1 || \
  ssh -f -N -L 9223:localhost:9222 davidhurley@192.168.12.151
```

2. **Check if Dave's Chrome is reachable through the tunnel:**
```bash
node .claude/skills/cowork/scripts/cdp-status.mjs
```

3. If **unreachable**, send Dave the launch instructions via Telegram (see "Dave's Setup" section below). Wait for him to confirm Chrome is running, then retry.

4. If **reachable**, report the connection status and available tabs. The session is now active — use `look` and `screenshot` commands to interact.

### `look` — Accessibility Snapshot

Get the accessibility tree of the active page tab:
```bash
node .claude/skills/cowork/scripts/cdp-snapshot.mjs
```

Pass a tab index as the third argument to target a specific tab (0 = first page tab):
```bash
node .claude/skills/cowork/scripts/cdp-snapshot.mjs localhost 9223 1
```

Shows page structure, headings, links, buttons, form fields, and text content.

### `screenshot` — Save Screenshot

Capture a PNG screenshot of a page tab:
```bash
node .claude/skills/cowork/scripts/cdp-screenshot.mjs localhost 9223 /path/to/output.png 0
```

Arguments: `host port output_path tab_index`

Save screenshots to the session directory:
```
.claude/sessions/orchestrator/cowork-screenshot-$(date +%H%M%S).png
```

After saving, read the screenshot file with the Read tool to view it.

### `status` — Connection Status

```bash
node .claude/skills/cowork/scripts/cdp-status.mjs
```

Shows Chrome version, protocol version, and all open page tabs.

### `stop` — Disconnect

Tear down the SSH tunnel:
```bash
pkill -f "ssh.*-L 9223:localhost:9222" 2>/dev/null && echo "Tunnel closed" || echo "No tunnel running"
```

Dave's Chrome keeps running.

### `help` — Dave's Setup Instructions

Display or send Dave the Chrome launch instructions below.

## Dave's Setup

When Dave needs to start a cowork session, send these instructions via Telegram:

### Launch Command

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-cowork \
  --no-first-run \
  --no-default-browser-check
```

That's it — Chrome only needs to listen on localhost. BMO connects through an SSH tunnel.

### Why Each Flag

| Flag | Purpose |
|------|---------|
| `--remote-debugging-port=9222` | Enable CDP server on port 9222 (localhost only) |
| `--user-data-dir=/tmp/chrome-cowork` | Separate profile — Chrome blocks CDP on default profile |
| `--no-first-run` | Skip first-run wizard |
| `--no-default-browser-check` | Skip default browser prompt |

**Removed flags**: `--remote-debugging-address=0.0.0.0` and `--remote-allow-origins=*` are no longer needed. Chrome 145+ ignores the address flag, and the SSH tunnel connects as localhost so no CORS bypass is required.

### Quick Verify

Dave can test locally: `curl http://localhost:9222/json/version`
BMO tests through tunnel: `curl http://localhost:9223/json/version`

## SSH Tunnel Details

BMO establishes the tunnel from its machine:

```bash
ssh -f -N -L 9223:localhost:9222 davidhurley@192.168.12.151
```

| Flag | Purpose |
|------|---------|
| `-f` | Run in background after authenticating |
| `-N` | No remote command — tunnel only |
| `-L 9223:localhost:9222` | Forward local 9223 → Dave's localhost:9222 |

**Benefits over direct CDP**:
- Works through firewalls (only needs SSH port 22)
- Encrypted transport
- Simpler Chrome flags for Dave (no LAN exposure)
- Chrome 145+ compatible (doesn't rely on `--remote-debugging-address`)

## CDP Tab Management (Direct REST API)

For simple tab operations, no WebSocket needed:

```bash
# List all tabs
curl -s http://localhost:9223/json/list

# Open new tab
curl -s http://localhost:9223/json/new?https://example.com

# Close a tab by ID
curl -s http://localhost:9223/json/close/{tabId}

# Browser version info
curl -s http://localhost:9223/json/version
```

## Implementation Notes

- **Scripts use Node.js only** (built-in WebSocket, no dependencies). Located in `scripts/` directory.
- **Each command is stateless** — connects, performs action, disconnects. No persistent connection to manage.
- **Tab index filtering**: Scripts filter to `type: "page"` tabs only, skipping extensions and service workers.
- **SSH tunnel**: Scripts default to `localhost:9223` — the tunneled port. When running through the tunnel, Chrome's localhost WebSocket URLs are already correct (no fixup needed).
- **Tested working**: All scripts verified against Chrome 145 on macOS via SSH tunnel.

## Scripts

| Script | Purpose | Args |
|--------|---------|------|
| `cdp-status.mjs` | Check connection, list tabs | `[host] [port]` (default: localhost 9223) |
| `cdp-screenshot.mjs` | Capture PNG screenshot | `[host] [port] [output_path] [tab_index]` |
| `cdp-snapshot.mjs` | Accessibility tree snapshot | `[host] [port] [tab_index]` |

## Stretch Goals (Future)

- **Desktop sharing**: VNC/screen sharing for full desktop access beyond browser
- **Persistent sessions**: Auto-reconnect if Chrome restarts
- **Tab notifications**: Alert BMO when Dave switches tabs
- **Collaborative annotations**: BMO highlights elements for Dave
