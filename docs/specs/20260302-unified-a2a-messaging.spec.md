# Spec: Unified A2A Messaging Endpoint

**Created**: 2026-03-02
**Status**: Draft
**Related**: Todo #95 (Dave directive), Issue #118 (P2P field name standardization)
**Repo**: kithkit (public core)
**Reviews**: BMO (required), R2 (recommended — shared daemon capability)

## Goal

Replace the three separate outbound A2A messaging paths (`/agent/send`, `/api/network/send`, `/api/network/groups/:id/send`) with a single endpoint that auto-selects the best transport (LAN direct or relay) and falls back transparently.

## Design Philosophy

### Why Unify

Today callers must know which transport to use and call different endpoints with different field names:

| Current Endpoint | Transport | DM/Group | Key Fields |
|---|---|---|---|
| `POST /agent/send` | LAN-first, relay fallback | DM only | `peer`, `type`, `text` |
| `POST /api/network/send` | Relay only | DM only | `to`, `payload: {type, text}` |
| `POST /api/network/message` | Relay only | DM only | `to`, `message` (string shorthand) |
| `POST /api/network/groups/:id/send` | Relay only | Group only | `payload: {type, text}` (group ID in URL) |

This forces every caller to understand transport details, creates inconsistent field names (Issue #118), and makes fallback logic ad-hoc. The daemon should own routing decisions — callers should just say "send this to X."

### Architecture

```
Caller
  │
  ▼
POST /api/a2a/send   ◄── single entry point
  │
  ├─ resolve target (DM vs group)
  │
  ├─ select route (auto / lan / relay)
  │   │
  │   ├─ LAN direct ──► curl http://<peer>:<port>/agent/message
  │   │                     (Bearer auth, AgentMessage format)
  │   │
  │   └─ Relay/P2P ──► network.send() or network.sendToGroup()
  │                       (E2E encrypted, WireEnvelope)
  │
  ├─ if preferred route fails, try fallback (when route=auto)
  │
  └─ return unified result
```

## Requirements

### Must Have

#### Endpoint (5 items)
- [ ] **EP-01: Single endpoint**: `POST /api/a2a/send` accepts all outbound A2A messages (DMs and groups)
- [ ] **EP-02: Unified request schema**: One JSON body format for all message types (see [Request Body Schema](#request-body-schema) below)
- [ ] **EP-03: Route parameter**: Optional `route` field (`"auto"` | `"lan"` | `"relay"`) to control transport selection; defaults to `"auto"`
- [ ] **EP-04: Unified response schema**: One response format for all delivery results (see [Response Schema](#response-schema) below)
- [ ] **EP-05: Localhost only**: Bind to `127.0.0.1` — no authentication required (same as existing endpoints)

#### Routing Logic (4 items)
- [ ] **RT-01: Auto routing for DMs**: When `route=auto`, try LAN first; if LAN fails, fall back to relay. Return which route succeeded.
- [ ] **RT-02: Auto routing for groups**: When `route=auto` and target is a group, use relay (groups are relay-only today). No LAN fallback for groups.
- [ ] **RT-03: Forced LAN**: When `route=lan`, attempt LAN only. Return error if LAN unreachable. Reject group messages (groups require relay).
- [ ] **RT-04: Forced relay**: When `route=relay`, attempt relay only. Return error if SDK not initialized.

#### Fallback Behavior (3 items)
- [ ] **FB-01: Transparent fallback**: On `route=auto`, if the preferred transport fails, try the alternate without caller intervention. Report both attempts in the response.
- [ ] **FB-02: Failure detail**: When a route fails, include the error from that route in the response `attempts` array so callers can debug.
- [ ] **FB-03: No silent swallowing**: Never return `200 OK` if all delivery attempts failed. Return `502` with full attempt details.

#### Message Format (4 items)
- [ ] **MF-01: Payload passthrough**: The `payload` object is delivered to the recipient as-is. The daemon does not modify, validate, or impose structure on payload contents beyond requiring it to be a JSON object.
- [ ] **MF-02: Standard envelope fields**: The daemon adds `from`, `messageId`, and `timestamp` to outbound LAN messages automatically. Callers do not need to set these.
- [ ] **MF-02a: Reserved payload fields**: The field names `from`, `messageId`, `timestamp`, and `type` are reserved at the envelope level. If a caller includes `from`, `messageId`, or `timestamp` in `payload`, the envelope value wins — the caller's duplicate is silently dropped. The `type` field is sourced from `payload.type` (it IS the canonical type). Document this in the API reference with a warning box.
- [ ] **MF-03: Peer name resolution**: The `to` field resolves in this order: (1) exact case-insensitive match against `agent-comms.peers` config names, (2) prefix match — e.g., `"r2"` resolves to `"r2d2"` if it's the only prefix match (ambiguous prefixes → `400 INVALID_TARGET`), (3) if no config match, treat as a qualified relay name (`"name@host"` format required, else `404 PEER_NOT_FOUND`).

#### Migration (3 items)
- [ ] **MG-01: Old endpoints remain**: Existing endpoints (`/agent/send`, `/api/network/send`, `/api/network/message`, `/api/network/groups/:id/send`) continue to function unchanged during the migration period.
- [ ] **MG-02: Deprecation headers**: Old endpoints return `Deprecation: true` and `Sunset: <date>` HTTP headers (date TBD after adoption stabilizes).
- [ ] **MG-03: Internal callers migrate first**: `sendAgentMessage()` in `agent-comms.ts` is refactored to use the new unified routing logic internally. Old endpoints become thin wrappers that call the same unified router.

### Should Have

- [ ] **SH-01: Delivery receipt tracking**: Return a `messageId` that can be used to query delivery status later via `GET /api/a2a/status/:messageId` (future endpoint, not part of this spec).
- [ ] **SH-02: Retry on queue**: When relay returns `status: "queued"`, the response indicates this clearly. The relay SDK handles retries internally — no new retry logic in the daemon.
- [ ] **SH-03: Batch send**: Accept an array of recipients in `to` for multi-DM fan-out (same payload to multiple peers). Response includes per-recipient results.
- [ ] **SH-04: Peer liveness hint**: When `route=auto`, if the peer-heartbeat system knows a peer is unreachable via LAN (stale heartbeat exceeds the configured threshold), skip LAN attempt and go straight to relay. Stale threshold defaults to `2 * heartbeat_interval` and is configurable via `agent-comms.stale_threshold` in `kithkit.config.yaml`. Reduces latency for known-offline LAN peers.
  _Dependency: SH-04 relies on the existing `peer-heartbeat` scheduled task (configured in `kithkit.config.yaml` scheduler). The task currently pings peers every 60s and records liveness in the daemon DB. If `peer-heartbeat` is disabled, SH-04 is a no-op (auto route always attempts LAN first)._

### Won't Have (This Phase)

- [ ] Dynamic peer discovery — peers remain statically configured in `kithkit.config.yaml`
- [ ] LAN support for group messages — groups are relay-only (relay handles member resolution and fan-out)
- [ ] Message persistence/history in the daemon — the daemon is a router, not a message store
- [ ] Delivery confirmations / read receipts — depends on relay-side support (separate spec)
- [ ] Rate limiting per peer — defer to existing daemon-wide rate limits in config

## API Specification

### Endpoint

```
POST /api/a2a/send
Content-Type: application/json
```

Localhost only. No authentication required.

### Request Body Schema

```typescript
interface A2ASendRequest {
  // Exactly one of `to` or `group` must be present
  to?: string;       // Peer name (e.g., "bmo") or qualified name ("bmo@relay.bmobot.ai")
  group?: string;    // Group UUID or group name (e.g., "home-agents")

  // Message content — required, must be a JSON object
  payload: {
    type: string;    // Message type (e.g., "text", "status", "coordination", "pr-review")
    text?: string;   // Message body (optional — depends on type)
    [key: string]: unknown;  // Additional fields passed through
  };

  // Transport selection — optional, defaults to "auto"
  route?: "auto" | "lan" | "relay";
}
```

**Validation rules:**
- Exactly one of `to` or `group` must be present. Both present → `400`. Neither present → `400`.
- `payload` is required and must be a non-null object with at least a `type` field.
- `payload.type` must be a non-empty string.
- `route` is optional. Invalid values → `400`.
- `group` + `route: "lan"` → `400` (groups are relay-only).
- `group` accepts a UUID or a configured group name. Names are resolved to UUIDs via `agent-comms.groups` config first, then via relay lookup. Unresolvable names → `404 GROUP_NOT_FOUND`.
- `to` with a qualified name (`name@host`) + `route: "lan"` → `400 INVALID_ROUTE` (qualified names are relay-only).
- Unknown top-level fields are ignored (forward-compatible).

### Response Schema

#### Success (HTTP 200)

```typescript
interface A2ASendResponse {
  ok: true;
  messageId: string;         // UUID assigned by the daemon
  target: string;            // Resolved target ("bmo" or group UUID)
  targetType: "dm" | "group";
  route: "lan" | "relay";    // Which route actually delivered
  status: "delivered" | "queued";  // "queued" = relay accepted but not yet delivered
  attempts: DeliveryAttempt[];     // Ordered list of what was tried
  timestamp: string;               // ISO-8601
}

// For group sends, additional fields:
interface A2AGroupSendResponse extends A2ASendResponse {
  targetType: "group";
  delivered: string[];       // Peer names successfully delivered
  queued: string[];          // Peer names queued for retry
  failed: string[];          // Peer names that failed
}

interface DeliveryAttempt {
  route: "lan" | "relay";
  status: "success" | "failed";
  error?: string;            // Present when status is "failed"
  latencyMs: number;         // Time taken for this attempt
}
```

> **Implementation note**: The `delivered`, `queued`, and `failed` arrays in `A2AGroupSendResponse` are aspirational. Today the relay SDK's `sendToGroup()` returns only a boolean success/failure for the entire group send — it does not report per-member delivery status. Phase 1 will return `delivered` and `failed` as empty arrays, with the overall result indicated by `status`. Per-member tracking depends on relay SDK enhancements (tracked separately).

#### Failure (HTTP 4xx / 5xx)

```typescript
interface A2ASendError {
  ok: false;
  error: string;             // Human-readable error message
  code: string;              // Machine-readable error code (see table below)
  attempts?: DeliveryAttempt[];  // Present if delivery was attempted
  timestamp: string;
}
```

**Error codes:**

| HTTP | Code | Condition |
|------|------|-----------|
| 400 | `INVALID_REQUEST` | Missing/invalid fields, JSON parse error |
| 400 | `INVALID_TARGET` | Both `to` and `group` present, or neither; ambiguous peer prefix match |
| 400 | `INVALID_ROUTE` | `route: "lan"` with group target, or `route: "lan"` with a qualified relay name (`name@host`) |
| 404 | `PEER_NOT_FOUND` | `to` peer not in config and not a qualified relay name |
| 404 | `GROUP_NOT_FOUND` | `group` UUID/name not recognized by config or relay |
| 502 | `DELIVERY_FAILED` | All delivery attempts failed (includes `attempts` array) |
| 503 | `RELAY_UNAVAILABLE` | `route: "relay"` but SDK not initialized |
| 503 | `LAN_UNAVAILABLE` | `route: "lan"` but agent-comms disabled or no secret |

### Route Selection Logic

```
Input: to/group, route preference
                │
                ▼
         ┌─────────────┐
         │ route param? │
         └──────┬──────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
  "lan"      "auto"      "relay"
    │           │           │
    │     ┌─────┴─────┐    │
    │     │ group msg? │    │
    │     └─────┬─────┘    │
    │       yes │ no        │
    │        │  │           │
    │        │  ▼           │
    │        │ LAN available│
    │        │ + peer in    │
    │        │ config?      │
    │        │  │           │
    │        │ yes  no      │
    │        │  │    │      │
    │        │  ▼    │      │
    │        │ Try   │      │
    │        │ LAN   │      │
    │        │  │    │      │
    │        │ ok? fail     │
    │        │  │    │      │
    │        │  ▼    ▼      │
    │        │ done  │      │
    │        │       │      │
    ▼        ▼       ▼      ▼
   LAN     Relay   Relay  Relay
   only    only    (fall-  only
    │        │     back)    │
    ▼        ▼       ▼      ▼
  Result   Result  Result  Result
```

**Detailed rules:**

1. **`route: "auto"` (default)**
   - **Group message**: Use relay. No LAN attempt (groups are relay-only).
   - **DM, peer in config, agent-comms enabled**: Try LAN first. On failure, fall back to relay (if SDK initialized). On relay failure, return `502 DELIVERY_FAILED` with both attempts.
   - **DM, peer NOT in config**: Use relay only (no LAN info available). Must be a qualified name.
   - **DM, peer in config but LAN unreachable hint (SH-04)**: Skip LAN, go direct to relay.

2. **`route: "lan"`**
   - **Group**: Reject with `400 INVALID_ROUTE`.
   - **Qualified name** (e.g., `bmo@relay.bmobot.ai`): Reject with `400 INVALID_ROUTE` — qualified names are relay-only by definition.
   - **DM**: Attempt LAN only. Fail with `503 LAN_UNAVAILABLE` if agent-comms disabled, or `502 DELIVERY_FAILED` if LAN send fails.

3. **`route: "relay"`**
   - **Any target**: Attempt relay only. Fail with `503 RELAY_UNAVAILABLE` if SDK not initialized, or `502 DELIVERY_FAILED` if relay send fails.

### LAN Send Details

When the unified router chooses LAN:

1. Resolve peer from `agent-comms.peers` config: exact case-insensitive match first, then unique prefix match.
2. Build `AgentMessage`:
   ```json
   {
     "from": "<this agent name>",
     "type": "<payload.type>",
     "text": "<payload.text>",
     "messageId": "<generated UUID>",
     "timestamp": "<ISO-8601 now>",
     ...remaining payload fields spread at top level
   }
   ```
3. Try hosts in order: `peer.ip` → `peer.host` (`.lan`→`.local`) → `peer.host` as-is.
4. `curl -s --connect-timeout <configured_timeout> -X POST http://<host>:<port>/agent/message -H 'Authorization: Bearer <secret>'`
   LAN connect timeout defaults to 3 seconds and is configurable via `agent-comms.lan_timeout` in `kithkit.config.yaml`.
5. Parse response. HTTP 200 with `{ ok: true }` = success.

**Note:** LAN messages flatten `payload` fields to the top level of `AgentMessage` (adding `from`, `messageId`, `timestamp`). This preserves backward compatibility with the existing `/agent/message` receiver. The receiver does not need changes.

**Reserved field precedence**: When flattening payload for LAN delivery, envelope fields (`from`, `messageId`, `timestamp`) always overwrite any same-named fields in `payload`. The `type` field is sourced from `payload.type` (it IS the canonical type). Callers should avoid setting `from`, `messageId`, or `timestamp` in payload — they will be overwritten without warning at send time, though a debug-level log is emitted.

### Relay Send Details

When the unified router chooses relay:

1. For DMs: resolve peer name. If bare name and peer has `community` config, qualify as `name@relayHost`. Call `network.send(recipient, payload)`.
2. For groups: resolve group target — if a name was provided, look up UUID from `agent-comms.groups` config or relay. Call `network.sendToGroup(groupId, payload)`.
3. The SDK handles encryption, signing, retry queuing, and community failover internally.
4. Map SDK result to unified response format.

## Constraints

### Security

1. The endpoint binds to `127.0.0.1` only — no remote access, no authentication needed.
2. LAN sends use Bearer auth from the macOS Keychain (existing behavior, unchanged).
3. Relay sends use E2E encryption with Ed25519/X25519/AES-256-GCM (existing SDK behavior, unchanged).
4. No new secrets or credentials are introduced.
5. Payload contents are opaque to the daemon — no logging of payload body (existing policy).

### Performance

- LAN sends should complete in < 500ms (existing ~100-300ms typical with configurable connect timeout, default 3s).
- Relay sends depend on network conditions; timeout is SDK-managed.
- Auto-route with fallback adds at most one extra round-trip (LAN timeout + relay attempt).
- **SH-04** (peer liveness hint) eliminates the LAN timeout for known-offline peers.

### Compatibility

- **Runtime**: Node.js 22+, ESM only.
- **Receiver unchanged**: The `/agent/message` and `/agent/p2p` inbound endpoints on peers are NOT modified. The unified endpoint only changes the outbound side.
- **SDK optional**: If `kithkit-a2a-client` is not installed, relay routes are unavailable. LAN-only operation still works.
- **Config**: Two new optional fields in `agent-comms`: `lan_timeout` (default 3s) and `stale_threshold` (default `2 * heartbeat_interval`). All other config unchanged. Uses existing `agent-comms.peers` and network SDK configuration.

## Migration Path

### Phase 1: Add Unified Endpoint (This Spec)

1. Extract routing logic from `sendAgentMessage()` into a new `UnifiedA2ARouter` class/module.
2. Register `POST /api/a2a/send` route in the daemon's route setup.
3. Route handler validates request, calls the unified router, returns unified response.
4. `sendAgentMessage()` is refactored to delegate to the unified router internally.
5. Old endpoints (`/agent/send`, `/api/network/send`, `/api/network/message`, `/api/network/groups/:id/send`) become thin wrappers:
   - They translate their existing field names into the unified format.
   - They call the unified router.
   - They translate the unified response back to their existing response format.
   - They add `Deprecation: true` header.

### Phase 2: Migrate Callers (Separate Spec)

1. Update the `agent-comms` skill to document the new endpoint.
2. Update all internal callers (comms agent, orchestrator, workers) to use `/api/a2a/send`.
3. Update `kithkit-a2a-client` SDK if it has any direct daemon call patterns.
4. Update peer agents (BMO, R2) — their daemons need the same endpoint.
5. Update or replace `agent-send.sh` convenience script — it becomes a thin wrapper around `curl POST /api/a2a/send`.

### Phase 3: Deprecate Old Endpoints (Separate Spec)

1. Set `Sunset` date on old endpoints.
2. After all callers migrated, remove old endpoints.
3. Clean up wrapper code.

### Backward Compatibility During Migration

- Old endpoints are preserved and functional throughout Phase 1 and Phase 2.
- Internal routing logic is shared — no behavioral drift between old and new endpoints.
- Old endpoints add deprecation headers but return identical responses to today.
- No config changes required — works with existing `kithkit.config.yaml`.

## Success Criteria

1. `POST /api/a2a/send` with `to: "bmo"` delivers via LAN when BMO is reachable on the local network.
2. `POST /api/a2a/send` with `to: "bmo"` falls back to relay when LAN is unreachable and SDK is initialized.
3. `POST /api/a2a/send` with `group: "<uuid>"` delivers via relay to all group members.
4. `POST /api/a2a/send` with `group: "home-agents"` resolves the group name to UUID and delivers via relay.
5. `POST /api/a2a/send` with `route: "lan"` skips relay entirely.
6. `POST /api/a2a/send` with `route: "relay"` skips LAN entirely.
7. Response `attempts` array accurately reports which routes were tried and their outcomes.
8. Old endpoints (`/agent/send`, `/api/network/send`, `/api/network/message`, `/api/network/groups/:id/send`) continue working with existing field names and return identical behavior.
9. Old endpoints include `Deprecation: true` header after migration.
10. No changes to receiving endpoints (`/agent/message`, `/agent/p2p`) — existing peers work without updates.

## User Stories

### Scenario 1: Comms Agent Sends a DM (Auto Route)
- **Given**: BMO is configured as a LAN peer and is reachable
- **When**: Comms calls `POST /api/a2a/send {"to":"bmo","payload":{"type":"text","text":"Hello"}}`
- **Then**: Message is delivered via LAN, response shows `route: "lan"`, `status: "delivered"`, `attempts: [{route:"lan", status:"success"}]`

### Scenario 2: LAN Fails, Falls Back to Relay
- **Given**: BMO is configured as a LAN peer but the machine is off; relay SDK is initialized
- **When**: Comms calls `POST /api/a2a/send {"to":"bmo","payload":{"type":"text","text":"Hello"}}`
- **Then**: LAN attempt fails (3s timeout), relay attempt succeeds, response shows `route: "relay"`, `attempts: [{route:"lan", status:"failed", error:"connect timeout"}, {route:"relay", status:"success"}]`

### Scenario 3: Group Message (by Name)
- **Given**: Home-agents group exists on relay
- **When**: Comms calls `POST /api/a2a/send {"group":"home-agents","payload":{"type":"text","text":"Team update"}}`
- **Then**: Group name resolved to UUID, relay delivers to group, response shows `route: "relay"`, `status: "delivered"`

### Scenario 4: Force LAN Route
- **Given**: Caller explicitly wants LAN only
- **When**: Comms calls `POST /api/a2a/send {"to":"bmo","payload":{"type":"text","text":"Ping"},"route":"lan"}`
- **Then**: Only LAN is attempted. If peer is unreachable, returns `502 DELIVERY_FAILED` — no relay fallback.

### Scenario 5: Relay Not Available
- **Given**: `kithkit-a2a-client` is not installed
- **When**: Caller sends `POST /api/a2a/send {"to":"bmo","payload":{"type":"text","text":"Hi"},"route":"relay"}`
- **Then**: Returns `503 RELAY_UNAVAILABLE`

### Scenario 6: Group + LAN Route (Invalid)
- **Given**: Caller incorrectly specifies LAN for a group
- **When**: Caller sends `POST /api/a2a/send {"group":"uuid","payload":{"type":"text","text":"Hi"},"route":"lan"}`
- **Then**: Returns `400 INVALID_ROUTE` — groups require relay

### Scenario 7: Old Endpoint Still Works
- **Given**: Legacy caller uses old endpoint
- **When**: Caller sends `POST /agent/send {"peer":"bmo","type":"text","text":"Hello"}`
- **Then**: Message delivers as before. Response includes `Deprecation: true` header.

### Scenario 8: Qualified Name + Forced LAN (Invalid)
- **Given**: Caller uses a qualified relay name but forces LAN route
- **When**: Caller sends `POST /api/a2a/send {"to":"bmo@relay.bmobot.ai","payload":{"type":"text","text":"Hi"},"route":"lan"}`
- **Then**: Returns `400 INVALID_ROUTE` — qualified names are relay-only

### Scenario 9: Peer Name Prefix Match
- **Given**: `r2d2` is configured as a LAN peer
- **When**: Caller sends `POST /api/a2a/send {"to":"r2","payload":{"type":"text","text":"Ping"}}`
- **Then**: `"r2"` resolves to `"r2d2"` (unique prefix match), message delivers normally

## Technical Considerations

- **Shared router module**: The core routing logic should be a standalone module (e.g., `daemon/src/routes/a2a-router.ts`) that both the new endpoint and old endpoint wrappers call. This prevents behavioral drift.
- **LAN message flattening**: LAN recipients expect `AgentMessage` format (flat fields: `from`, `type`, `text`, `messageId`, `timestamp`). The router must flatten `payload` fields when sending via LAN. This is the existing behavior in `sendViaLAN()`.
- **Relay message wrapping**: Relay sends pass `payload` as-is to `network.send()`. The SDK handles encryption and envelope wrapping.
- **Peer name resolution**: Bare names (e.g., `"bmo"`) are resolved against `agent-comms.peers` config: exact case-insensitive match first, then unique prefix match (e.g., `"r2"` → `"r2d2"`). Ambiguous prefix matches return `400 INVALID_TARGET`. Qualified names (e.g., `"bmo@relay.bmobot.ai"`) bypass LAN lookup and go straight to relay.
- **Group name resolution**: Group targets accept either a UUID or a configured name. Names are resolved from `agent-comms.groups` config (exact case-insensitive match), then from relay lookup. Unresolvable names return `404 GROUP_NOT_FOUND`.
- **messageId lifecycle**: The daemon generates a `messageId` (UUID v4) at the top of the handler. This ID is used in both LAN and relay sends, and returned in the response. For relay sends, the SDK may assign its own `messageId` — the response should include both if they differ.
- **Latency tracking**: Each delivery attempt should be timed (start/end) and the duration included in the `attempts` array for observability.

## Documentation Impact

- [ ] Update `docs/api-reference.md` with the new `POST /api/a2a/send` endpoint
- [ ] Add deprecation notices to the old endpoint sections in `docs/api-reference.md`
- [ ] Update `.claude/skills/agent-comms/SKILL.md` to reference the unified endpoint
- [ ] Update `.claude/skills/a2a-network/SKILL.md` to reference the unified endpoint and deprecation of direct relay calls
- [ ] Update `CLAUDE.md` if any behavioral instructions reference old endpoint paths

## Open Questions

- [x] ~~Should the unified endpoint live in the `kithkit` core or start in `KKit-Skippy`?~~ **Resolved**: Build in `kithkit` public core from day one. All agents share this capability — no reason to start in a private repo.
- [ ] What `Sunset` date should old endpoints get? Recommendation: defer until Phase 2 adoption is confirmed.
- [ ] Should SH-03 (batch send) share a single `messageId` or generate one per recipient? Recommendation: one per recipient for independent tracking.
- [ ] Should the `attempts` array include timing for the peer-liveness check (SH-04) or only actual send attempts? Recommendation: only actual sends — liveness check is an internal optimization.
