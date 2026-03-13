# A2A Messaging Flow — End-to-End Trace

Complete trace of agent-to-agent messaging in Kithkit, covering outbound sends, routing/delivery, and inbound reception.

---

## Architecture Overview

```
Agent A (sender)                              Agent B (receiver)
┌──────────────┐                              ┌──────────────┐
│ POST          │                              │              │
│ /api/a2a/send │                              │  Comms tmux  │
└──────┬───────┘                              │  session     │
       │                                      └──────▲───────┘
       ▼                                             │
┌──────────────┐    ┌─────────┐               ┌──────┴───────┐
│ UnifiedA2A   │───▶│ LAN     │──curl POST──▶│ /agent/       │
│ Router       │    │ (direct)│  Bearer auth  │ message       │
│              │    └─────────┘               └──────────────┘
│              │    ┌─────────┐               ┌──────────────┐
│              │───▶│ Relay   │──SDK send───▶│ /agent/p2p    │
│              │    │ (P2P)   │  encrypted    │ (envelope)    │
└──────────────┘    └─────────┘               └──────────────┘
       │                                             │
       ▼                                             ▼
┌──────────────┐                              ┌──────────────┐
│ messages DB  │                              │ messages DB  │
│ (audit)      │                              │ (storage)    │
└──────────────┘                              └──────────────┘
```

Two delivery paths:
- **LAN** — direct HTTP POST via `curl` to peer's `/agent/message`, authenticated with shared Bearer token
- **Relay** — encrypted P2P envelope via the Network SDK through a relay server

---

## Outbound Flow

### Step 1: Route Registration

**File:** `daemon/src/extensions/index.ts` lines 253–283
**Function:** `onInit()`

The agent extension creates `UnifiedA2ARouter` with injected dependencies and registers the HTTP route:

```ts
const router = new UnifiedA2ARouter({
  config, sendViaLAN, getNetworkClient,
  getAgentCommsSecret: () => readKeychain('credential-agent-comms-secret'),
  logCommsEntry, sendMessage,
});
setA2ARouter(router);
registerRoute('/api/a2a/*', handleA2ARoute);
```

### Step 2: HTTP Endpoint Handler

**File:** `daemon/src/a2a/handler.ts` lines 28–64
**Function:** `handleA2ARoute()`

Parses the request body, delegates to `router.send()`, and maps the result to HTTP status codes:

| Error Code | HTTP Status |
|------------|-------------|
| `INVALID_REQUEST`, `INVALID_TARGET`, `INVALID_ROUTE` | 400 |
| `PEER_NOT_FOUND`, `GROUP_NOT_FOUND` | 404 |
| `DELIVERY_FAILED` | 502 |
| `RELAY_UNAVAILABLE`, `LAN_UNAVAILABLE` | 503 |

### Step 3: Request Validation

**File:** `daemon/src/a2a/router.ts` lines 91–146
**Function:** `validate()`

Checks:
- Exactly one of `to` (DM) or `group` (group message) — not both, not neither
- `payload` is an object with a required `type` string field
- `route` (if present) is one of `'auto' | 'lan' | 'relay'`
- Groups cannot use `route: 'lan'` (groups are relay-only)

### Step 4: Send Orchestration

**File:** `daemon/src/a2a/router.ts` lines 248–283
**Function:** `send()`

```
validate(body)
  → normalizePayload()     // aliases: message→text, unwraps double-wrapped objects
  → generate messageId (UUID)
  → if group: resolveGroupId() → sendGroup()
  → if DM:   resolvePeer()   → sendDM()
```

### Step 5: Peer Resolution (DM)

**File:** `daemon/src/a2a/router.ts` lines 150–180
**Function:** `resolvePeer()`

1. If name contains `@` — already a qualified relay name, skip config lookup
2. Exact match (case-insensitive) against configured peers
3. Fallback: unique prefix match (e.g., `"bm"` → `"bmo"`)
4. Qualify for relay: append `@{primaryCommunity}` (e.g., `"bmo"` → `"bmo@relay.bmobot.ai"`)

Returns `{ peer?: PeerConfig, qualified: string }`.

### Step 6: DM Routing Strategy

**File:** `daemon/src/a2a/router.ts` lines 287–419
**Function:** `sendDM()`

| Route | Behavior |
|-------|----------|
| `'lan'` (forced) | Peer must be in config. `attemptLAN()` only. No fallback. |
| `'relay'` (forced) | `attemptRelay()` only. No fallback. |
| `'auto'` (default) | If peer in config: try LAN first → on failure, fallback to relay. If no peer config: relay only. |

Each attempt is recorded as a `DeliveryAttempt { route, status, latencyMs, error?, relayStatus? }`.

### Step 7: LAN Delivery

**Router layer:** `daemon/src/a2a/router.ts` lines 519–570 — `attemptLAN()`
**Transport layer:** `daemon/src/extensions/comms/agent-comms.ts` lines 256–362 — `sendViaLAN()`

Flow:
1. Read shared secret from Keychain (`credential-agent-comms-secret`)
2. Build `AgentMessage` from payload (flatten, add `from`, `messageId`, `timestamp`)
3. `curl` POST to `http://{peer.host}:{peer.port}/agent/message`
   - Headers: `Content-Type: application/json`, `Authorization: Bearer {secret}`
   - Timeouts: 5s connect, 10s total
4. If hostname fails and peer has `ip` field → retry with IP as fallback
5. Parse HTTP response (status code + JSON body)
6. Log to `logs/agent-comms.log` (JSONL)

### Step 8: Relay Delivery

**File:** `daemon/src/a2a/router.ts` lines 574–650
**Function:** `attemptRelay()`

1. Get Network SDK client via `deps.getNetworkClient()`
2. If SDK not available → return `{ status: 'failed', error: 'Network SDK not available' }`
3. Call `network.send(qualifiedName, payload)`
4. SDK encrypts payload, signs envelope, sends to relay server
5. Result: `{ status: 'delivered' | 'queued' | 'failed', messageId, error? }`
6. Log to `logs/agent-comms.log` with `direction: 'relay-out'`

**SDK Bridge:** `daemon/src/extensions/comms/network/sdk-bridge.ts` lines 37–120

### Step 9: Group Message Send

**File:** `daemon/src/a2a/router.ts` lines 423–515
**Function:** `sendGroup()`

Groups always use relay (no LAN option):
1. Resolve group — UUID passthrough or name lookup via `network.getGroups()`
2. Call `network.sendToGroup(groupId, payload)`
3. Returns per-member breakdown: `{ delivered: [], queued: [], failed: [] }`

### Step 10: Database Audit Trail (Outbound)

**File:** `daemon/src/a2a/router.ts` lines 654–687
**Function:** `logDBSuccess()`

After successful delivery, persists via `sendMessage()`:
- DM: `to_agent = "a2a:{target}"`, metadata includes `{ channel: 'a2a', route, messageId, attempts }`
- Group: `to_agent = "a2a:group:{groupId}"`, metadata includes `{ channel: 'a2a', group_id, route, messageId }`

**Message Router:** `daemon/src/agents/message-router.ts` lines 84–204 — `sendMessage()`
- Deduplication (5-second window by content hash)
- `INSERT INTO messages` (from_agent, to_agent, type, body, metadata)

### Step 11: Response to Caller

**File:** `daemon/src/a2a/handler.ts` lines 44–51

DM success response:
```json
{
  "ok": true,
  "messageId": "550e8400-...",
  "target": "bmo",
  "targetType": "dm",
  "route": "lan",
  "status": "delivered",
  "attempts": [
    { "route": "lan", "status": "success", "latencyMs": 42 }
  ],
  "timestamp": "2026-03-05T14:23:45.123Z"
}
```

Auto-route fallback response (LAN failed, relay succeeded):
```json
{
  "ok": true,
  "messageId": "...",
  "target": "bmo",
  "targetType": "dm",
  "route": "relay",
  "status": "delivered",
  "attempts": [
    { "route": "lan", "status": "failed", "error": "Connection refused", "latencyMs": 5023 },
    { "route": "relay", "status": "success", "latencyMs": 187 }
  ]
}
```

---

## Inbound Flow

### Entry Point A: LAN Messages (`/agent/message`)

**Route registration:** `daemon/src/extensions/comms/index.ts` line 143
**Handler:** `daemon/src/extensions/comms/agent-comms.ts` lines 177–253 — `handleAgentMessage()`

Flow:
1. Extract `Authorization: Bearer {token}` from request
2. Read local secret from Keychain (`credential-agent-comms-secret`)
3. Compare tokens — 401 if mismatch
4. Validate message structure: `from`, `type`, `messageId`, `timestamp` required
5. Validate `type` ∈ `['text', 'status', 'coordination', 'pr-review']`

**Status pings** (lines 202–227):
- Type `'status'` messages are acknowledged but NOT injected into tmux
- Prevents token burn from 5-minute heartbeats
- Logged to JSONL only

**Real messages** (lines 228–252):
- Format: `[Agent] {name}: {text}`
- Inject into comms tmux session via `injectText()`
- Log to `logs/agent-comms.log` with `direction: 'in'`

### Entry Point B: P2P Relay Messages (`/agent/p2p`)

**Route registration:** `daemon/src/extensions/comms/index.ts` lines 168–181
**Handler:** `daemon/src/extensions/comms/network/sdk-bridge.ts` lines 178–203 — `handleIncomingP2P()`

Flow:
1. Receive `WireEnvelope` (encrypted, signed)
2. If group: `_network.receiveGroupMessage(envelope)`
3. If DM: `_network.receiveMessage(envelope)`
4. SDK decrypts payload, verifies Ed25519 signature
5. Fires event: `'message'` or `'group-message'`

### Event Wiring (SDK → DB → tmux)

**File:** `daemon/src/extensions/comms/network/sdk-bridge.ts`

#### DM Reception (lines 219–261)
```
_network.on('message', (msg) => {
  // Skip status pings
  if (msg.payload?.type === 'status') return;

  const formatted = `[Network] ${displayName}: ${text}`;

  sendMessage({
    from: `network:${msg.sender}`,
    to: 'comms',
    type: 'text',
    body: formatted,
    metadata: { source: 'a2a-network', sender, messageId, verified },
    direct: true,   // ← triggers immediate tmux injection
  });

  logCommsEntry({ direction: 'in', from, to, type, text, messageId });
});
```

#### Group Message Reception (lines 263–301)
```
_network.on('group-message', (msg) => {
  const formatted = `[Group:${groupTag}] ${displayName}: ${text}`;

  sendMessage({
    from: `network:${msg.sender}`,
    to: 'comms',
    type: 'text',
    body: formatted,
    metadata: { source: 'a2a-network', sender, messageId, groupId, verified },
    direct: true,
  });
});
```

#### Contact Requests (lines 330–375)
```
_network.on('contact-request', (req) => {
  sendMessage({
    from: `network:${req.from}`,
    to: 'comms',
    body: `[Network] Contact request from ${displayName}...`,
    metadata: { source: 'a2a-network', type: 'contact-request' },
    direct: true,
  });
});
```

#### Group Invitations (lines 303–328)
```
_network.on('group-invitation', (inv) => {
  sendMessage({
    from: `network:${inv.invitedBy}`,
    to: 'comms',
    body: `[Network] Group invitation: "${inv.groupName}"...`,
    metadata: { source: 'a2a-network', type: 'group-invitation', groupId },
    direct: true,
  });
});
```

### Database Storage (Inbound)

**File:** `daemon/src/agents/message-router.ts` lines 84–112 — `sendMessage()`

All inbound messages are persisted:
```sql
INSERT INTO messages (from_agent, to_agent, type, body, metadata)
VALUES ('network:bmo@relay.bmobot.ai', 'comms', 'text',
        '[Network] BMO: hello!',
        '{"source":"a2a-network","sender":"bmo@relay.bmobot.ai","messageId":"...","verified":true}');
```

### Delivery to Comms Agent (tmux Injection)

**File:** `daemon/src/agents/message-router.ts` lines 164–182

When `direct: true`:
1. Check `isPersistentAgent('comms')` → true
2. Call `tmuxInjector('comms', body)`

**tmux Injection:** `daemon/src/core/session-bridge.ts` lines 172–226

```
sessionExists('comms1')              // verify tmux session alive
  → add EST timestamp prefix
  → execFile('tmux', ['send-keys', '-t', 'comms1:', '-l', text])
  → wait 300ms
  → execFile('tmux', ['send-keys', '-t', 'comms1:', 'Enter'])
  → retry Enter with backoff (3 attempts: 300/500/800ms)
  → verify injection by checking pane content
```

After successful injection:
```sql
UPDATE messages SET processed_at = NOW(), read_at = NOW(), notified_at = NOW()
WHERE id = ?;
```

If comms session is down, message stays in DB with `processed_at = NULL`, delivered on next session start.

### Fallback: Notification System

**File:** `daemon/src/agents/message-router.ts` line 189

If `direct` is not set or injection fails:
- `notifyNewMessage()` triggers the message-delivery scheduler task
- Scheduler picks up undelivered messages and retries injection

---

## Security

| Layer | Mechanism | Details |
|-------|-----------|---------|
| **LAN auth** | Bearer token | Shared secret from Keychain (`credential-agent-comms-secret`) |
| **Relay encryption** | E2E encryption | Ciphertext + nonce in wire envelope |
| **Relay signing** | Ed25519 | Signature on every wire envelope |
| **Key storage** | macOS Keychain | `credential-agent-comms-secret` (LAN), `credential-cc4me-agent-key` (P2P) |
| **Deduplication** | Content hash | 5-second window prevents replay in message-router |
| **Anti-spoofing** | Router sets `from` | `from` field set by router from config, not from caller input |

---

## Configuration

**Peer config** in `kithkit.config.yaml`:
```yaml
agent-comms:
  enabled: true
  peers:
    - name: bmo
      host: davids-mac-mini.lan
      port: 3847
      ip: 192.168.12.169    # DNS fallback
    - name: skippy
      host: 192.168.12.142
      port: 3847
```

**Network SDK config**:
```yaml
network:
  enabled: true
  endpoint: "https://r2.bmobot.ai/agent/p2p"
  communities:
    - name: home
      primary: https://relay.bmobot.ai
  heartbeat_interval: 300000
  auto_approve_contacts: true
```

---

## Logging & Audit

| Destination | Format | What |
|-------------|--------|------|
| `logs/agent-comms.log` | JSONL | All send/receive events with direction, latency, status |
| `messages` table (SQLite) | Rows | All messages with metadata, timestamps, delivery status |
| Daemon stdout/stderr | Structured log | Errors, warnings, debug traces |

JSONL fields: `ts`, `direction` (`in`, `out`, `relay-out`), `from`, `to`, `type`, `text`, `messageId`, `latencyMs`, `status`, `error`, `httpStatus`

Log rotation: 5 MB max, 3 rotated files.

---

## File Index

| File | Purpose |
|------|---------|
| `daemon/src/a2a/router.ts` | Core routing logic — validation, peer resolution, LAN/relay attempts, fallback |
| `daemon/src/a2a/handler.ts` | HTTP handler for `POST /api/a2a/send` |
| `daemon/src/a2a/types.ts` | TypeScript interfaces (request, response, error codes) |
| `daemon/src/extensions/index.ts` | Router instantiation and route registration |
| `daemon/src/extensions/comms/index.ts` | Comms extension init, route wiring |
| `daemon/src/extensions/comms/agent-comms.ts` | LAN transport (`sendViaLAN`, `handleAgentMessage`), JSONL logging |
| `daemon/src/extensions/comms/network/sdk-bridge.ts` | Network SDK init, P2P inbound handler, event wiring |
| `daemon/src/extensions/comms/network/sdk-types.ts` | SDK type definitions |
| `daemon/src/extensions/comms/network/crypto.ts` | Key generation, Ed25519 identity |
| `daemon/src/agents/message-router.ts` | DB persistence, dedup, tmux injection routing |
| `daemon/src/core/session-bridge.ts` | tmux send-keys injection |
| `daemon/src/__tests__/a2a-router.test.ts` | 31+ test cases |

---

## Sequence Diagrams

### Outbound DM (auto route, LAN succeeds)

```
Caller              Handler         Router          LAN             DB
  │                    │               │              │              │
  │ POST /api/a2a/send │               │              │              │
  │───────────────────▶│               │              │              │
  │                    │ router.send() │              │              │
  │                    │──────────────▶│              │              │
  │                    │               │ validate()   │              │
  │                    │               │ resolvePeer() │              │
  │                    │               │ attemptLAN() │              │
  │                    │               │─────────────▶│              │
  │                    │               │              │ curl POST    │
  │                    │               │              │ /agent/message
  │                    │               │  success     │              │
  │                    │               │◀─────────────│              │
  │                    │               │ logDBSuccess()│              │
  │                    │               │──────────────────────────── ▶│
  │                    │               │              │    INSERT    │
  │                    │  {ok: true}   │              │              │
  │                    │◀──────────────│              │              │
  │  200 {ok, route:   │               │              │              │
  │       "lan"}       │               │              │              │
  │◀───────────────────│               │              │              │
```

### Outbound DM (auto route, LAN fails → relay fallback)

```
Caller              Router          LAN           Relay           DB
  │                    │              │              │              │
  │  send(body)        │              │              │              │
  │───────────────────▶│              │              │              │
  │                    │ attemptLAN() │              │              │
  │                    │─────────────▶│              │              │
  │                    │   FAILED     │              │              │
  │                    │◀─────────────│              │              │
  │                    │              │              │              │
  │                    │ attemptRelay()│              │              │
  │                    │──────────────────────────── ▶│              │
  │                    │              │   delivered  │              │
  │                    │◀────────────────────────────│              │
  │                    │ logDBSuccess()│              │              │
  │                    │──────────────────────────────────────────▶ │
  │  {ok, route:       │              │              │              │
  │   "relay",         │              │              │              │
  │   attempts: [      │              │              │              │
  │     {lan: failed}, │              │              │              │
  │     {relay: ok}]}  │              │              │              │
  │◀───────────────────│              │              │              │
```

### Inbound LAN Message

```
Remote Agent        /agent/message    agent-comms     session-bridge   DB
     │                    │               │               │            │
     │ curl POST          │               │               │            │
     │ Bearer {secret}    │               │               │            │
     │───────────────────▶│               │               │            │
     │                    │ handleAgent   │               │            │
     │                    │ Message()     │               │            │
     │                    │──────────────▶│               │            │
     │                    │               │ verify token  │            │
     │                    │               │ validate msg  │            │
     │                    │               │ format text   │            │
     │                    │               │ injectText()  │            │
     │                    │               │──────────────▶│            │
     │                    │               │               │ tmux       │
     │                    │               │               │ send-keys  │
     │                    │               │ logCommsEntry()│            │
     │                    │               │───────────────────────────▶│
     │                    │               │               │   JSONL    │
     │  200 {ok: true}    │               │               │            │
     │◀───────────────────│               │               │            │
```

### Inbound Relay (P2P) Message

```
Relay Server      /agent/p2p      SDK Bridge       SDK Events     msg-router    tmux
     │                │               │               │              │           │
     │ POST envelope  │               │               │              │           │
     │───────────────▶│               │               │              │           │
     │                │ handleIncoming│               │              │           │
     │                │ P2P()        │               │              │           │
     │                │──────────────▶│               │              │           │
     │                │               │ receiveMsg()  │              │           │
     │                │               │──────────────▶│              │           │
     │                │               │               │ decrypt      │           │
     │                │               │               │ verify sig   │           │
     │                │               │               │              │           │
     │                │               │   'message'   │              │           │
     │                │               │   event       │              │           │
     │                │               │◀──────────────│              │           │
     │                │               │               │              │           │
     │                │               │ sendMessage(direct:true)     │           │
     │                │               │─────────────────────────────▶│           │
     │                │               │               │              │ INSERT    │
     │                │               │               │              │ messages  │
     │                │               │               │              │           │
     │                │               │               │              │ tmuxInject│
     │                │               │               │              │──────────▶│
     │                │               │               │              │  send-keys│
     │                │               │               │              │           │
     │                │               │               │              │ UPDATE    │
     │                │               │               │              │ processed │
     │  200 ok        │               │               │              │           │
     │◀───────────────│               │               │              │           │
```
