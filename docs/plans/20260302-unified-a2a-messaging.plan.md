# Plan: Unified A2A Messaging Endpoint

**Spec**: `docs/specs/20260302-unified-a2a-messaging.spec.md`
**Created**: 2026-03-02
**Status**: Draft — awaiting BMO review
**Target repo**: kithkit (core, public). All 3 agents get the capability via dependency update.
**PR #**: 134 (spec approved)

---

## Architecture Overview

The unified endpoint (`POST /api/a2a/send`) wraps existing LAN and relay send logic into a shared router module. Old endpoints become thin wrappers that translate field names, call the shared router, and translate responses back.

```
                    POST /api/a2a/send (new)
                            │
POST /agent/send (old) ─────┤
POST /api/network/send ─────┤──► UnifiedA2ARouter.send()
POST /api/network/message ──┤        │
POST /api/network/groups    │    ┌───┴───┐
  /:id/send (old) ──────────┘    │       │
                              sendLAN  sendRelay
                            (existing) (existing)
```

### Key design decisions (from spec review + codebase analysis)

1. **Build in kithkit core** — the router, types, and route handler go in `daemon/src/core/` or a new `daemon/src/a2a/` directory. Extension routes in private repos become thin wrappers.
2. **Two optional config fields** — adds `agent-comms.lan_timeout` (default 3s) and `agent-comms.stale_threshold` (default `2 * heartbeat_interval`) per spec § Constraints. All other config unchanged — uses existing `agent-comms.peers` for LAN resolution and `network.communities` for relay name qualification.
3. **Reserved payload fields** — `from`, `messageId`, `timestamp`, `type` are injected by the daemon into LAN messages. Callers set them in `payload` only to override (not recommended).
4. **Group name resolution** — `group` field accepts a UUID or a configured group name. Names are resolved case-insensitively against `agent-comms.groups` config (per spec § Validation rules and § Relay Send Details). Unresolvable names → `404 GROUP_NOT_FOUND`.
5. **Peer name resolution** — bare names resolve case-insensitively against `agent-comms.peers`. Unique prefix matching included (spec MF-03): e.g., `"r2"` resolves to `"r2d2"` if it's the only prefix match. Ambiguous prefix matches → `400 INVALID_TARGET`.
6. **`route: "lan"` + group → 400** — enforced at validation layer.
7. **LAN timeout** — configurable via `agent-comms.lan_timeout` (default 3s), passed to `sendViaLAN()` connect-timeout. Per spec § LAN Send Details.
8. **Heartbeat threshold (SH-04)** — uses existing `PeerState` cache (`getPeerState()`). Stale threshold configurable via `agent-comms.stale_threshold` (default `2 * heartbeat_interval`). Per spec § SH-04.

---

## Stories

### Story 1: Core Router Module

**Goal**: Extract a standalone `UnifiedA2ARouter` that encapsulates route selection, LAN send, relay send, fallback, and response formatting.

**Files to create**:

| File | Purpose |
|------|---------|
| `daemon/src/a2a/types.ts` | `A2ASendRequest`, `A2ASendResponse`, `A2ASendError`, `DeliveryAttempt` interfaces |
| `daemon/src/a2a/router.ts` | `UnifiedA2ARouter` class — `send(request): Promise<A2ASendResponse \| A2ASendError>` |
| `daemon/src/a2a/index.ts` | Re-exports for clean imports |

**Files to modify**:

| File | Change |
|------|--------|
| `daemon/src/extensions/comms/agent-comms.ts` | Export `sendViaLAN()` as a public function (currently private). Export `resolveP2PName()`. Add `getPeerByName(name)` helper that returns `PeerConfig \| undefined`. |

**Implementation details**:

1. **`types.ts`** — verbatim from spec (§ Request Body Schema, § Response Schema). Add error code constants.

2. **`router.ts`** — `UnifiedA2ARouter` class:
   ```typescript
   class UnifiedA2ARouter {
     constructor(deps: RouterDeps) // stores injected dependencies

     async send(req: A2ASendRequest): Promise<A2ASendResponse | A2ASendError>

     // Internal methods:
     private validate(req: unknown): A2ASendRequest | A2ASendError
     private resolvePeer(name: string): { peer?: PeerConfig; qualified: string }
     private async sendLAN(peer: PeerConfig, messageId: string, payload: Record<string, unknown>): Promise<DeliveryAttempt>
     private async sendRelay(target: string, payload: Record<string, unknown>, isGroup: boolean, groupId?: string): Promise<DeliveryAttempt>
     private resolveGroup(nameOrId: string): { groupId?: string; error?: A2ASendError }
   }
   ```

   - `validate()` — checks exactly-one-of `to`/`group`, payload is object with `type` string, route is valid enum, group+lan → 400, qualified name+lan → 400 INVALID_ROUTE.
   - `resolvePeer()` — resolution order per spec MF-03: (1) exact case-insensitive match against `agent-comms.peers`, (2) unique prefix match — if exactly one peer name starts with the input, resolve to that peer (ambiguous prefix → `INVALID_TARGET`), (3) if name contains `@`, treat as qualified relay name, (4) otherwise return `PEER_NOT_FOUND`.
   - `sendLAN()` — delegates to the exported `sendViaLAN()` from `agent-comms.ts`. Flattens `payload` fields + adds `from`, `messageId`, `timestamp` (per spec § LAN Send Details). Wraps result in `DeliveryAttempt`.
   - `sendRelay()` — calls `getNetworkClient()`, then `network.send()` or `network.sendToGroup()`. Wraps result in `DeliveryAttempt`.
   - `resolveGroup()` — if input matches UUID format, use as-is. Otherwise, case-insensitive lookup against `agent-comms.groups` config. If not found, return `GROUP_NOT_FOUND`.
   - `send()` — orchestrates route selection (auto/lan/relay), invokes transports, handles fallback, builds response. Generates `messageId` (UUID v4) at top.

3. **Latency tracking** — wrap each transport call with `Date.now()` before/after, put `latencyMs` in `DeliveryAttempt`.

4. **SH-04 peer liveness hint** — in auto mode, before trying LAN, call `getPeerState(peerName)`. If `updatedAt` is >5 min ago, skip LAN and go direct to relay.

**Dependencies**: None (this is the foundation).

**Tests** (`daemon/src/__tests__/a2a-router.test.ts`):

| # | Test case | Type |
|---|-----------|------|
| 1 | Valid DM request passes validation | Unit |
| 2 | Valid group request passes validation | Unit |
| 3 | Both `to` and `group` present → INVALID_TARGET | Unit |
| 4 | Neither `to` nor `group` → INVALID_TARGET | Unit |
| 5 | Missing `payload` → INVALID_REQUEST | Unit |
| 6 | `payload` without `type` → INVALID_REQUEST | Unit |
| 7 | `payload.type` not a string → INVALID_REQUEST | Unit |
| 8 | Invalid `route` value → INVALID_REQUEST | Unit |
| 9 | `group` + `route: "lan"` → INVALID_ROUTE | Unit |
| 9a | Qualified name (`bmo@relay.bmobot.ai`) + `route: "lan"` → INVALID_ROUTE | Unit |
| 10 | Peer resolution: bare name found in config → returns peer + qualified name | Unit |
| 11 | Peer resolution: case-insensitive match (`BMO` → `bmo`) | Unit |
| 12 | Peer resolution: qualified name (`bmo@relay.bmobot.ai`) → skips config lookup | Unit |
| 13 | Peer resolution: unknown bare name → PEER_NOT_FOUND | Unit |
| 13a | Peer resolution: prefix match — `"r2"` resolves to `"r2d2"` when it's the only match | Unit |
| 13b | Peer resolution: ambiguous prefix — `"b"` matches both `"bmo"` and `"bender"` → INVALID_TARGET | Unit |
| 13c | Group resolution: UUID passthrough | Unit |
| 13d | Group resolution: configured name → UUID (case-insensitive) | Unit |
| 13e | Group resolution: unknown name → GROUP_NOT_FOUND | Unit |
| 14 | Auto route DM: LAN succeeds → returns `route: "lan"`, one attempt | Integration (mock) |
| 15 | Auto route DM: LAN fails, relay succeeds → returns `route: "relay"`, two attempts | Integration (mock) |
| 16 | Auto route DM: both fail → 502 DELIVERY_FAILED, two attempts in array | Integration (mock) |
| 17 | Auto route group: goes to relay, no LAN attempt | Integration (mock) |
| 18 | Forced LAN: succeeds → single attempt | Integration (mock) |
| 19 | Forced LAN: fails → 502, no relay fallback | Integration (mock) |
| 20 | Forced relay: SDK not initialized → 503 RELAY_UNAVAILABLE | Integration (mock) |
| 21 | Forced relay: succeeds → single attempt | Integration (mock) |
| 22 | SH-04: stale peer heartbeat → skips LAN, goes direct to relay | Integration (mock) |
| 23 | Latency tracked in each DeliveryAttempt | Integration (mock) |
| 24 | messageId is UUID v4 format | Unit |
| 25 | Relay queued status → response `status: "queued"` | Integration (mock) |

**Testing approach**: Mock `sendViaLAN` and `getNetworkClient` at the module level. Use `node:test` + `assert/strict` (existing pattern). No real network calls.

---

### Story 2: HTTP Route Handler

**Goal**: Register `POST /api/a2a/send` in the route registry and wire it to the router.

**Files to create**:

| File | Purpose |
|------|---------|
| `daemon/src/a2a/handler.ts` | HTTP route handler — parses body, calls `router.send()`, formats HTTP response |

**Files to modify**:

| File | Change |
|------|--------|
| `daemon/src/extensions/index.ts` | Import handler, `registerRoute('/api/a2a/*', handleA2ARoute)` alongside existing route registrations |
| `daemon/src/a2a/index.ts` | Re-export handler |

**Implementation details**:

1. **`handler.ts`**:
   ```typescript
   export async function handleA2ARoute(
     req: http.IncomingMessage,
     res: http.ServerResponse,
     pathname: string,
     searchParams: URLSearchParams,
   ): Promise<boolean> {
     const subpath = pathname.replace(/^\/api\/a2a\/?/, '');

     if (subpath === 'send' && req.method === 'POST') {
       const body = await parseBody(req);
       const result = await router.send(body);

       if (result.ok) {
         json(res, 200, result);
       } else {
         const status = ERROR_CODE_TO_HTTP[result.code]; // map from error code table
         json(res, status, result);
       }
       return true;
     }

     return false; // unmatched subpath
   }
   ```

2. **Error code → HTTP status mapping**:
   ```typescript
   const ERROR_CODE_TO_HTTP: Record<string, number> = {
     INVALID_REQUEST: 400,
     INVALID_TARGET: 400,
     INVALID_ROUTE: 400,
     PEER_NOT_FOUND: 404,
     GROUP_NOT_FOUND: 404,
     DELIVERY_FAILED: 502,
     RELAY_UNAVAILABLE: 503,
     LAN_UNAVAILABLE: 503,
   };
   ```

3. **Route registration** — use `/api/a2a/*` prefix pattern so future endpoints (e.g., `GET /api/a2a/status/:messageId` from SH-01) can be added under the same prefix.

**Dependencies**: Story 1 (router module).

**Tests** (`daemon/src/__tests__/a2a-handler.test.ts`):

| # | Test case | Type |
|---|-----------|------|
| 1 | POST /api/a2a/send with valid body → 200 + response body matches schema | HTTP integration |
| 2 | POST /api/a2a/send with invalid JSON → 400 INVALID_REQUEST | HTTP integration |
| 3 | POST /api/a2a/send with missing payload → 400 INVALID_REQUEST | HTTP integration |
| 4 | POST /api/a2a/send with both to+group → 400 INVALID_TARGET | HTTP integration |
| 5 | GET /api/a2a/send → route returns false (unhandled) | HTTP integration |
| 6 | POST /api/a2a/other → route returns false (unmatched subpath) | HTTP integration |
| 7 | Delivery failure → 502 with attempts array | HTTP integration |
| 8 | Relay unavailable → 503 RELAY_UNAVAILABLE | HTTP integration |
| 9 | Response includes `timestamp` field (ISO-8601) | HTTP integration |

**Testing approach**: Spin up a real HTTP server with the handler registered (same pattern as `route-registry.test.ts`). Mock the router at the module level.

---

### Story 3: Old Endpoint Wrappers + Deprecation Headers

**Goal**: Refactor old endpoints to delegate to the unified router, add deprecation headers.

**Files to modify**:

| File | Change |
|------|--------|
| `daemon/src/extensions/comms/agent-comms.ts` | Refactor `sendAgentMessage()` to call `router.send()` internally. Keep the same external signature. The function now translates its args into an `A2ASendRequest`, calls the router, and translates the `A2ASendResponse` back to `AgentMessageResponse`. |
| `daemon/src/extensions/comms/agent-comms.ts` | `handleAgentSend` route handler (`POST /agent/send`): add `Deprecation: true` header to response. |
| `daemon/src/extensions/comms/network/api.ts` | `POST /api/network/send`: add `Deprecation: true` header. Refactor to call router internally. |
| `daemon/src/extensions/comms/network/api.ts` | `POST /api/network/message`: add `Deprecation: true` header. Refactor to call router internally. |
| `daemon/src/extensions/comms/network/api.ts` | `POST /api/network/groups/:id/send` (and `/message`): add `Deprecation: true` header. Refactor to call router internally. |

**Implementation details**:

1. **`sendAgentMessage()` refactor**:
   ```typescript
   export async function sendAgentMessage(
     peerName: string,
     type: string,
     text?: string,
     extra?: Partial<Pick<AgentMessage, ...>>,
   ): Promise<AgentMessageResponse> {
     // Build A2ASendRequest from legacy args
     const request: A2ASendRequest = {
       to: peerName,
       payload: { type, text, ...extra },
       route: 'auto',
     };
     const result = await router.send(request);
     // Translate back to AgentMessageResponse
     return {
       ok: result.ok,
       queued: result.ok && result.status === 'queued',
       error: result.ok ? undefined : result.error,
     };
   }
   ```

2. **Deprecation header** — added to old endpoint responses only (not the unified endpoint):
   ```typescript
   res.setHeader('Deprecation', 'true');
   // Sunset date TBD — not set until Phase 2 adoption is confirmed (per spec)
   ```

3. **Network API relay wrappers** — `POST /api/network/send` and `POST /api/network/message` translate their existing field names (`to`, `payload`/`message`) into `A2ASendRequest` format, call `router.send({ to, payload, route: 'relay' })` (forced relay to preserve existing behavior), and translate the response back to the existing format.

4. **Group send wrapper** — `POST /api/network/groups/:id/send` translates to `router.send({ group: groupId, payload, route: 'relay' })`.

**Dependencies**: Story 1 (router), Story 2 (handler registered so router is initialized).

**Tests** (`daemon/src/__tests__/a2a-deprecation.test.ts`):

| # | Test case | Type |
|---|-----------|------|
| 1 | POST /agent/send returns `Deprecation: true` header | HTTP integration |
| 2 | POST /api/network/send returns `Deprecation: true` header | HTTP integration |
| 3 | POST /api/network/message returns `Deprecation: true` header | HTTP integration |
| 4 | POST /api/network/groups/:id/send returns `Deprecation: true` header | HTTP integration |
| 5 | POST /api/a2a/send does NOT have `Deprecation` header | HTTP integration |
| 6 | `sendAgentMessage()` still returns same response shape after refactor | Unit |
| 7 | Old endpoints produce identical behavior (same success/error patterns) | Regression |

**Testing approach**: Before refactoring, capture current responses from old endpoints. After refactoring, verify responses match (minus the new header).

---

### Story 4: JSONL Logging Integration

**Goal**: Ensure unified router logs all send attempts to `agent-comms.log` with the existing JSONL format.

**Files to modify**:

| File | Change |
|------|--------|
| `daemon/src/a2a/router.ts` | Call `logCommsEntry()` for each delivery attempt (LAN and relay) with appropriate direction and metadata |

**Implementation details**:

1. **LAN attempts**: `direction: 'out'` (success) or `direction: 'out'` with `error` field (failure). Already handled by `sendViaLAN()` — no duplication needed.

2. **Relay attempts**: `direction: 'relay-out'`. Call `logCommsEntry()` after SDK send completes.

3. **Deduplication**: Since `sendViaLAN()` already logs internally, the router should NOT double-log LAN attempts. For relay sends that currently log in `sendAgentMessage()`, move the logging into the router to avoid duplication after Story 3 refactor.

**Dependencies**: Story 1 (router exists), Story 3 (old callers refactored).

**Tests**: Add to `a2a-router.test.ts`:

| # | Test case |
|---|-----------|
| 26 | LAN success → comms log entry with direction "out" |
| 27 | Relay success → comms log entry with direction "relay-out" |
| 28 | Both LAN+relay attempts → two log entries |

---

### Story 5: DB Audit Trail

**Goal**: Log outbound messages through the unified router to the daemon `messages` table for audit trail.

**Files to modify**:

| File | Change |
|------|--------|
| `daemon/src/a2a/router.ts` | After successful send, call `sendMessage()` to persist in DB (same pattern as existing network API handlers) |

**Implementation details**:

1. For DMs: `sendMessage({ from: 'comms', to: 'a2a:<peer>', type: 'text', body: JSON.stringify(payload), metadata: { channel: 'a2a', route, messageId, attempts } })`.

2. For groups: `sendMessage({ from: 'comms', to: 'a2a:group:<groupId>', type: 'text', body: JSON.stringify(payload), metadata: { channel: 'a2a', group_id: groupId, route, messageId } })`.

3. Remove duplicate `sendMessage()` calls from old endpoint handlers in `network/api.ts` (they'll be using the router which handles it).

**Dependencies**: Story 3 (old endpoints refactored to use router).

**Tests**: Add to `a2a-router.test.ts`:

| # | Test case |
|---|-----------|
| 29 | Successful DM → message persisted in DB with correct from/to/metadata |
| 30 | Successful group → message persisted in DB with group_id in metadata |
| 31 | Failed delivery → no message persisted (don't log failed sends) |

---

## Build Order

```
Story 1: Core Router Module
    │
    ├──► Story 2: HTTP Route Handler (can start after Story 1 types are defined)
    │
    └──► Story 3: Old Endpoint Wrappers + Deprecation (depends on Story 1 + 2)
              │
              ├──► Story 4: JSONL Logging (depends on Story 3 — dedup requires old callers refactored)
              │
              └──► Story 5: DB Audit Trail (depends on Story 3)
```

**Parallelizable**: Stories 4 and 5 can be built in parallel after Story 3.
**Sequential**: Story 2 depends on Story 1 types. Story 3 depends on Stories 1+2. Stories 4 and 5 depend on Story 3 (dedup requires old callers refactored first).

**Recommended build sequence**: 1 → 2 → 3 → 4+5 (parallel).

---

## Migration Steps (All 3 Agents)

### Step 1: Build and merge (KKit-Skippy first)

Since the spec calls for building in kithkit core, the new files (`daemon/src/a2a/`) go in the shared daemon source. However, the existing `agent-comms.ts` and `network/api.ts` files live in the extensions directory which is currently per-agent. The plan:

1. **New `daemon/src/a2a/` module** — pure core, no extension dependencies. Receives config and function references via constructor injection (not import from extensions).
2. **Constructor injection pattern**:
   ```typescript
   const router = new UnifiedA2ARouter({
     config,
     sendViaLAN: sendViaLAN.bind(null, config),  // bind config to avoid stale closure
     getNetworkClient: getNetworkClient,          // from sdk-bridge.ts
     getPeerState: getPeerState,                  // from agent-comms.ts
     logCommsEntry: logCommsEntry,                // from agent-comms.ts
   });
   // Note: if sendViaLAN's signature changes, update the RouterDeps interface.
   // The bind pattern ensures the closure captures the current config reference,
   // not a stale copy. If config is mutated at runtime (hot-reload), consider
   // passing a config-getter function instead.
   ```
   This keeps the router in core with no imports from the extension layer.

3. **Extension wires it up** — in `extensions/index.ts`, the `onInit()` creates the router instance and registers the `/api/a2a/*` route.

### Step 2: Deploy to Skippy

- Build daemon: `cd daemon && npm run build`
- Restart daemon: `launchctl kickstart -k gui/$(id -u)/com.assistant.daemon`
- Verify: `curl -s 'http://localhost:3847/api/a2a/send' -d '{"to":"bmo","payload":{"type":"text","text":"test"}}' -H 'Content-Type: application/json'`

### Step 3: Deploy to BMO and R2

Since the router lives in core and the extension just wires it:

1. BMO and R2 pull latest daemon code
2. Both `extensions/index.ts` files add the same router initialization + route registration
3. Build + restart daemon on each machine

**Risk**: BMO and R2 have their own extension entry points. They need to:
- Import `UnifiedA2ARouter` from `daemon/src/a2a/`
- Import their own `sendViaLAN`, `getNetworkClient`, `getPeerState` from their extensions
- Register `/api/a2a/*` route
- This is ~10 lines of glue code per agent

### Step 4: Verify deprecation headers

After all 3 agents are running the new code:
- Verify old endpoints return `Deprecation: true`
- Verify new endpoint works for DM and group sends
- Verify LAN → relay fallback works

---

## Doc Updates

| File | Change |
|------|--------|
| `docs/api-reference.md` | Add `POST /api/a2a/send` section with full request/response schema. Add deprecation notices to `/agent/send`, `/api/network/send`, `/api/network/message`, `/api/network/groups/:id/send` sections. |
| `.claude/skills/agent-comms/SKILL.md` | Update send examples to use `/api/a2a/send`. Note old endpoints as deprecated. |
| `CLAUDE.md` | Add `/api/a2a/send` to the daemon API quick reference table. |
| `kithkit.defaults.yaml` | No changes needed (no new config). |

---

## Risk Areas

### 1. Circular dependency between core router and extension exports

**Risk**: The router needs `sendViaLAN`, `getNetworkClient`, `getPeerState` — all defined in extension code. Importing extension code from core creates a circular dependency.

**Mitigation**: Constructor injection (see Migration Step 1). The router receives function references, not direct imports. The extension layer owns the wiring.

### 2. Double-logging during transition

**Risk**: If old endpoints call the router AND the router logs, we get duplicate JSONL entries and duplicate DB messages.

**Mitigation**: Story 4 and 5 explicitly handle deduplication. The router owns all logging; old endpoint wrappers stop logging after refactor.

### 3. `sendViaLAN()` is currently private

**Risk**: Exporting it changes the module's public API surface.

**Mitigation**: Export with a clear name (`sendViaLAN`) and JSDoc noting it's used by the unified router. It's an internal module, not a public npm package — API surface management is low-risk.

### 4. Relay response shape mismatch

**Risk**: `network.send()` and `network.sendToGroup()` return SDK-specific shapes that may not map cleanly to `DeliveryAttempt`.

**Mitigation**: The router's `sendRelay()` method handles the mapping. Currently, `network.send()` returns `{ status: 'delivered' | 'queued', error?: string }`. The mapping is straightforward: `status: 'delivered'|'queued' → success`, anything else → `failed`.

### 5. Group send response enrichment

**Risk**: The spec defines `A2AGroupSendResponse` with `delivered`, `queued`, `failed` arrays. The SDK's `sendToGroup()` may not return per-member results.

**Mitigation**: If the SDK doesn't provide per-member results, the response returns empty arrays for `delivered`/`queued`/`failed` and a note in the response. This is a known SDK limitation — document it.

---

## Rollback Plan

1. **Feature is additive** — the new `/api/a2a/send` endpoint doesn't break anything. If the router has bugs, old endpoints (which are wrappers around the same router) may break.

2. **Quick rollback**: Revert the Story 3 changes (old endpoint refactoring). This restores old endpoints to their original implementation. The new `/api/a2a/send` can remain registered but unused.

3. **Full rollback**: Revert the entire PR. Remove `daemon/src/a2a/`, remove route registration, restore old endpoint implementations. One `git revert` per merged PR.

4. **No DB migration** — no schema changes, nothing to roll back at the data layer.

5. **No config changes** — rollback doesn't require config file edits on any agent.

---

## Estimated Story Points

| Story | Complexity | Notes |
|-------|------------|-------|
| 1 — Core Router | Large | Core logic, most tests, foundation for everything |
| 2 — HTTP Handler | Small | Thin handler, mostly wiring |
| 3 — Old Wrappers | Medium | Refactoring existing code, regression risk |
| 4 — JSONL Logging | Small | Wiring existing logger |
| 5 — DB Audit Trail | Small | Wiring existing message router |

---

## Out of Scope (Phase 2+)

- Batch send (SH-03) — requires per-recipient tracking design
- Group name → UUID resolution — requires relay SDK support
- Caller migration (skill files, orchestrator, workers)
- Sunset date on old endpoints
- `GET /api/a2a/status/:messageId` delivery tracking endpoint
