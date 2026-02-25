# KithKit Chrome Connect

A Manifest V3 Chrome extension that bridges Chrome's debugger API to a KithKit daemon over WebSocket.

## What it does

Replaces the old `--remote-debugging-port` + SSH tunnel approach with a clean install-once, click-to-connect flow:

1. Install the extension in Chrome
2. Click the toolbar icon
3. Enter the KithKit daemon host and port (defaults: `localhost:3847`)
4. Click **Connect**
5. The extension opens a WebSocket to `ws://<host>:<port>/cowork`, attaches Chrome's debugger to the active tab, and relays CDP commands between the daemon and the tab

## Architecture

```
KithKit Daemon ←—WebSocket—→ Extension Background SW ←—chrome.debugger—→ Active Tab
                ws://.../cowork         (CDP relay)
```

### Message Protocol

| Direction       | Type          | Fields                                      |
|-----------------|---------------|---------------------------------------------|
| Client → Daemon | `hello`       | `userAgent`                                 |
| Daemon → Client | `cdp`         | `id`, `method`, `params`                    |
| Client → Daemon | `cdp-result`  | `id`, `result`                              |
| Client → Daemon | `cdp-error`   | `id`, `error`                               |
| Client → Daemon | `cdp-event`   | `method`, `params`, `sessionId`             |
| Daemon → Client | `list-tabs`   | `id`                                        |
| Client → Daemon | `tab-list`    | `id`, `tabs[]`                              |
| Daemon → Client | `switch-tab`  | `id`, `tabId`                               |
| Client → Daemon | `tab-switched`| `id`, `tabId`                               |
| Client → Daemon | `tab-changed` | `tabId`, `title`, `url`                     |
| Either          | `ping`/`pong` | —                                           |

## Files

```
kkit-chrome-connect/
├── manifest.json          # MV3 manifest
├── background.js          # Service worker — WebSocket + CDP bridge
├── popup.html             # Toolbar popup markup
├── popup.js               # Popup logic
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── scripts/
│   └── generate-icons.py  # Regenerate icons (no deps, pure stdlib)
└── README.md
```

## Installation

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the `kkit-chrome-connect/` directory

## Regenerating icons

```bash
python3 scripts/generate-icons.py
```

No external dependencies — uses only Python stdlib (`struct`, `zlib`).

## Daemon-side WebSocket endpoint

The daemon must accept WebSocket connections at `/cowork`. The extension handles reconnection manually (no auto-reconnect on drop — user must click Connect again). A heartbeat ping is sent every 30 seconds via `chrome.alarms` to keep the service worker alive.

## Permissions used

| Permission   | Why                                                            |
|--------------|----------------------------------------------------------------|
| `debugger`   | Attach to tabs and relay CDP commands                          |
| `activeTab`  | Access the currently active tab on Connect click              |
| `storage`    | Persist host:port config across popup opens                   |
| `tabs`       | Listen for tab switches/removals, query tab list              |
| `alarms`     | Keepalive heartbeat to prevent service worker suspension      |
