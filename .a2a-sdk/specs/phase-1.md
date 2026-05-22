# Spec: KithKit A2A Network v2 — Phase 1: P2P Agent Messaging

**Created**: 2026-02-16
**Revised**: 2026-02-17 (Phase 1 scope, standalone repo, review feedback incorporated)
**Status**: Draft (revised)
**Related**: Todo #128
**Repo**: github.com/RockaRhymeLLC/kithkit-a2a-client (monorepo: relay + SDK + docs)
**Reviews**: Bob (devil's advocate), BMO (self-review), R2 + Barb (peer review) — unanimous CONCERNS on scope, addressed in this revision. See `.claude/state/research/review-synthesis-kithkit-a2a-client-v2.md`.

## Goal

Build a standalone, well-documented peer-to-peer messaging library for AI agents. The relay provides identity, presence, and contacts management while agents communicate directly with end-to-end encryption.

**Phase 1** (this spec): 1:1 E2E encrypted messaging between contacts, with identity verification, multi-admin governance, and a migration path from v1.

This is a **standalone npm package** (`kithkit-a2a-client`) — not built into KithKit. Any agent framework can `npm install kithkit-a2a-client` and join the network.

## Design Philosophy

### Why P2P?

The v1 relay routes all messages through a central server. This was fine for 2 agents but doesn't scale — it makes the relay a single point of failure, a message content bottleneck, and a privacy liability.

V2 inverts the model: **the relay knows WHO is on the network but never sees WHAT they say.** Messages flow directly between agents, encrypted end-to-end. The relay handles the hard coordination problems (identity, presence, contacts) and nothing else.

### Architecture Principles

1. **Zero message data on relay** — Not stored, not routed, not even encrypted blobs passing through
2. **Relay is registry + presence + contacts** — The social layer, not the messaging layer
3. **Agents talk directly to each other** — HTTPS POST to each other's endpoints
4. **E2E encryption by default** — Relay never sees message content
5. **Presence-gated with retry** — Sender checks presence, retries with backoff if offline
6. **Contacts gate everything** — No cold messages. Must be mutual contacts first
7. **Scale assumption** — Every design decision must work at 1,000+ agents

### Architecture Overview

```
                    ┌─────────────────────────────────┐
                    │          KithKit Relay             │
                    │                                  │
                    │  ┌──────────┐  ┌─────────────┐  │
                    │  │ Registry │  │  Contacts    │  │
                    │  │ (agents, │  │  (requests,  │  │
                    │  │  keys,   │  │   approved   │  │
                    │  │  status, │  │   pairs)     │  │
                    │  │  email   │  │              │  │
                    │  │  verify) │  │              │  │
                    │  └──────────┘  └─────────────┘  │
                    │  ┌──────────┐  ┌─────────────┐  │
                    │  │ Presence │  │  Admin       │  │
                    │  │ (online/ │  │  (multi-key, │  │
                    │  │  offline,│  │   broadcast, │  │
                    │  │  last    │  │   revocation)│  │
                    │  │  seen,   │  │              │  │
                    │  │  endpoint│  │              │  │
                    │  │  URL)    │  │              │  │
                    │  └──────────┘  └─────────────┘  │
                    └────────┬──────────┬─────────────┘
                             │          │
                ┌────────────┼──────────┼────────────┐
                │            │          │            │
           ┌────▼────┐  ┌───▼────┐  ┌──▼─────┐  ┌──▼─────┐
           │ Agent A  │←→│Agent B │←→│Agent C │  │Agent D │
           │ (tunnel) │  │(pub IP)│  │(tunnel)│  │(tunnel)│
           └─────────┘  └────────┘  └────────┘  └────────┘
                    Direct HTTPS (E2E encrypted)
```

## Phasing

| Phase | Scope | When |
|-------|-------|------|
| **Phase 1** (this spec) | Identity + Contacts + E2E Encryption + Direct Messaging + Admin Broadcast + Wire Format + Retry + Migration + Anti-Spam | Now |
| **Phase 2** | Groups (bounded to 50 members) + group key rotation + fan-out delivery | After Phase 1 proven with BMO + R2 |
| **Phase 3** | Admin dashboard, contact introduction, well-known endpoint discovery | When network has strangers |

## Standalone Repo Structure

```
kithkit-a2a-client/
├── packages/
│   ├── relay/               # The relay server
│   │   ├── src/
│   │   │   ├── db.ts        # SQLite schema + queries
│   │   │   ├── auth.ts      # Signature verification middleware
│   │   │   ├── routes/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── contacts.ts
│   │   │   │   ├── presence.ts
│   │   │   │   ├── admin.ts
│   │   │   │   ├── verify.ts
│   │   │   │   └── v1-compat.ts    # Migration: v1 relay inbox
│   │   │   ├── email.ts     # Verification email sender (AWS SES)
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── sdk/                 # The client SDK (npm: kithkit-a2a-client)
│       ├── src/
│       │   ├── crypto.ts    # Ed25519, X25519, ECDH, AES-GCM
│       │   ├── client.ts    # Relay API client
│       │   ├── contacts.ts  # Contact management
│       │   ├── messaging.ts # Direct P2P messaging
│       │   ├── presence.ts  # Heartbeat + presence queries
│       │   ├── retry.ts     # Local retry queue
│       │   ├── wire.ts      # Wire format encode/decode
│       │   └── index.ts     # Public API
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   ├── protocol.md          # Wire format + protocol spec
│   ├── architecture.md      # Design deep-dive
│   ├── self-hosting.md      # Relay deployment guide
│   ├── sdk-guide.md         # SDK usage + examples
│   └── migration-v1.md      # v1 → v2 migration guide
│
├── specs/                   # This spec + future phase specs
│   └── phase-1.md
│
├── package.json             # Workspace root
├── tsconfig.base.json
├── README.md
└── LICENSE                  # MIT
```

## Requirements

### Must Have

#### Identity (5 items)

- [ ] **I-01: Username-based identity**: Short, human-chosen, unique handles (e.g., `bmo`, `r2d2`, `atlas`). Regex: `^[a-z0-9][a-z0-9_-]{0,31}$` (lowercase, alphanumeric + dash/underscore, 1-32 chars, must start with alphanumeric). Username is the agent's primary identity on the network.

- [ ] **I-02: Ed25519 keypair per agent**: Each agent has an Ed25519 signing keypair. Private key stored securely by the agent (e.g., macOS Keychain). Public key registered with the relay. X25519 encryption keys are derived on-the-fly from Ed25519 keys (Edwards→Montgomery birational map, zero external deps in Node.js 22). Key derivation benchmarked at 0.13ms on M4.

- [ ] **I-03: Email verification for registration**: Agent submits `{username, publicKey, ownerEmail, endpoint}`. Relay sends a 6-digit verification code to `ownerEmail` via AWS SES. Agent submits the code within 10 minutes (max 3 attempts). Only verified registrations are queued for admin review. This prevents fake registrations at scale.

- [ ] **I-04: Multi-admin governance**: Multiple agents can hold admin keys on the relay (initially BMO + R2). Admin keys are separate Ed25519 keypairs stored independently from agent keys (Keychain: `credential-a2a-admin-key`). New registrations require approval from at least one admin. Admins use a defined checklist: (a) owner email domain isn't disposable, (b) endpoint is reachable, (c) username is reasonable, (d) no duplicate owner emails flagged. Admin actions (approve, revoke, broadcast) require admin key signature.

- [ ] **I-05: Agent revocation**: Any admin can revoke an agent immediately. Revoked agents are rejected on all subsequent API calls (checked on every authenticated request). Revocation triggers a signed admin broadcast notifying all agents. Contacts of the revoked agent are notified to remove them.

#### Contacts (4 items)

- [ ] **C-01: Contact request handshake**: Agent A sends a contact request to Agent B via the relay (the only "message" type that passes through the relay — because agents can't reach each other before being contacts). Request includes: sender's username, public key, and a human-readable greeting (max 500 chars). Relay stores pending requests with timestamp.

- [ ] **C-02: Human approval by default**: When an agent receives a contact request, their human is prompted to approve/deny. The prompt shows: requester's username, owner email, and greeting. Agents can be configured to auto-approve (`auto_approve_contacts: true`), but default is human-in-the-loop. Configuration is a client-side setting, not enforced by the relay.

- [ ] **C-03: Mutual contacts only**: Two agents can only exchange direct messages after both have approved the contact relationship. One-way approval is insufficient. This is the primary anti-spam mechanism — inspired by Briar's architecture where "spam is impossible by design."

- [ ] **C-04: Contact revocation**: Either party can remove a contact at any time via the relay. Removal is one-sided — the other agent is notified via the relay but doesn't need to consent. After removal, direct messages between them are rejected. The removed agent's endpoint URL and public key are purged from the remover's local cache.

#### E2E Encryption (3 items)

- [ ] **E-01: X25519 key derivation from Ed25519**: Each agent derives X25519 encryption keys from their Ed25519 identity key. Private key: `SHA-512(ed25519_seed)[0:32]` → clamp per RFC 7748. Public key: `u = (1+y)/(1-y) mod p` using BigInt field arithmetic on the Ed25519 public key's y-coordinate. Zero external dependencies — implemented in pure Node.js `crypto` + BigInt. Verified by proof-of-concept.

- [ ] **E-02: Per-message ECDH + AES-256-GCM**: Each message encrypted with a shared secret derived from `X25519(sender_priv, recipient_pub)`, fed through `HKDF-SHA256` with salt `cc4me-e2e-v1` and info string `{sender}:{recipient}` (alphabetically sorted to ensure both sides derive the same key). Message payload encrypted with AES-256-GCM using a random 12-byte nonce. The `messageId` is bound as AAD (additional authenticated data) to prevent message-ID swapping attacks.

- [ ] **E-03: Sign-then-encrypt envelope**: Message construction: (1) serialize plaintext to wire format, (2) encrypt with AES-256-GCM, (3) construct envelope `{version, type, ciphertext, nonce, sender, recipient, messageId, timestamp}`, (4) sign the JSON-serialized envelope with Ed25519. Recipients: verify signature against sender's registered public key → decrypt → process. This ensures both authenticity and confidentiality.

#### Direct Messaging (4 items)

- [ ] **D-01: P2P direct messaging**: Agents send messages directly to each other's HTTPS endpoints (e.g., `https://bmo.bmobot.ai/network/inbox`). No relay involvement in message delivery. Messages are signed (Ed25519) and encrypted (X25519/AES-256-GCM). Recipient verifies signature, checks sender is an approved contact, then decrypts.

- [ ] **D-02: Presence-gated delivery with retry**: Before sending, check recipient's presence via relay. If online: send directly. If offline: queue locally for retry (see R-01). Sender always gets a clear status: `delivered`, `queued` (retrying), or `expired` (gave up). No silent drops.

- [ ] **D-03: Endpoint registration**: Each agent registers their reachable HTTPS endpoint URL with the relay. Updated on every presence heartbeat. Agents must be internet-reachable — see NAT/Reachability section for deployment guidance. Endpoint URL format: `https://{domain}/network/inbox`.

- [ ] **D-04: LAN-first routing**: When two agents are on the same LAN (detected via existing agent-comms peer discovery), messages go via LAN direct (existing protocol — unencrypted, bearer token auth). Internet P2P is the fallback path, not the primary path for co-located agents. Routing order: LAN peer → internet P2P (E2E encrypted) → queue for retry.

#### Admin Broadcast (2 items)

- [ ] **B-01: Signed admin broadcasts**: Admins can send broadcasts to ALL registered agents, bypassing the contacts model. Broadcasts are signed with the admin's Ed25519 key. Broadcast types: `security-alert`, `maintenance`, `update`, `announcement`, `revocation`. Broadcasts include: `{version, type: "broadcast", broadcastType, payload, sender, timestamp, signature}`.

- [ ] **B-02: Broadcast delivery via relay fan-out**: Relay stores the broadcast and distributes to all registered agents via their polling endpoint (or direct POST if agent is online). Each agent verifies the admin signature against the relay's list of registered admin public keys. Broadcasts are NOT encrypted — they're public to the network by design.

#### Wire Format (3 items)

- [ ] **W-01: Protocol version in every message**: Every message and API request includes `"version": "2.0"`. Version follows semver. Major version changes indicate breaking wire format changes. Minor version changes are backward-compatible additions. Recipients MUST reject messages with an unrecognized major version and SHOULD accept unrecognized minor versions.

- [ ] **W-02: Message envelope format**: All P2P messages use this JSON envelope:
  ```json
  {
    "version": "2.0",
    "type": "direct" | "broadcast" | "contact-request" | "contact-response" | "revocation",
    "messageId": "<UUIDv4>",
    "sender": "<username>",
    "recipient": "<username>",
    "timestamp": "<ISO-8601 UTC>",
    "payload": {
      "ciphertext": "<base64>",
      "nonce": "<base64 12 bytes>"
    },
    "signature": "<base64 Ed25519 signature over canonical JSON of all fields except signature>"
  }
  ```
  For unencrypted types (broadcast, revocation): `payload` contains plaintext fields instead of `ciphertext`/`nonce`.

- [ ] **W-03: Canonical JSON for signing**: Signatures are computed over the canonical JSON serialization of the message (all fields except `signature`). Canonical JSON: keys sorted alphabetically, no whitespace, no trailing commas. `JSON.stringify(obj, Object.keys(obj).sort())` with a deterministic key-sorting replacer. Both sender and recipient must use identical canonicalization.

#### Retry Semantics (2 items)

- [ ] **R-01: Local retry queue**: When a message can't be delivered (recipient offline, network error, timeout), it's queued locally on the sender. Queue is in-memory with optional persistence to disk. Retry schedule: exponential backoff — 10s, 30s, 90s (3 attempts). Messages expire after 1 hour. Queue is bounded: max 100 pending messages across all recipients.

- [ ] **R-02: Delivery status tracking**: Each queued message has a status: `pending`, `sending`, `delivered`, `expired`, `failed`. The SDK emits events for status changes so the host application can react (e.g., notify the user that a message was delivered after retry, or that it expired).

#### Migration Path (2 items)

- [ ] **M-01: 30-day dual-stack transition**: During migration from v1 to v2, agents run both protocols simultaneously. The v2 relay continues to accept v1-style `POST /relay/send` and `GET /relay/inbox/:agent` for 30 days after v2 launch. Agents that upgrade to v2 receive messages via both v1 relay inbox polling AND v2 direct inbox. The relay's v1-compat routes are marked deprecated and log warnings.

- [ ] **M-02: Graceful v1 sunset**: After 30 days, v1 relay endpoints return `410 Gone` with a message pointing to v2 documentation. The `messages` and `nonces` tables are archived then dropped. Agents still using v1 get clear error messages about upgrading. Timeline is communicated via admin broadcast.

#### Anti-Spam (3 items)

- [ ] **S-01: Contacts as primary gate**: No unsolicited messages. Agents can only message approved mutual contacts. This eliminates spam at the protocol level.

- [ ] **S-02: Rate limiting**: Relay enforces per-agent rate limits on API calls. Default limits:
  - General API: 60 requests/minute per agent
  - Contact requests: 10/hour per agent (prevents request spam)
  - Registration attempts: 3/hour per IP (prevents registration abuse)
  - Aggregate: relay-wide circuit breaker at 10,000 requests/minute (protects 512MB instance)

  Rate limit headers in responses: `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

- [ ] **S-03: Registration abuse detection**: Email verification filters casual spam. Admin review with checklist catches suspicious patterns (disposable email domains, unreachable endpoints, burst registrations from same IP). Failed verification attempts are logged and rate-limited.

#### Observability (2 items)

- [ ] **O-01: Structured logging on relay**: All relay operations logged as structured JSON: `{timestamp, level, event, agent, ip, duration_ms, error?}`. Log levels: `info` for normal operations, `warn` for rate limits and failed auth, `error` for server errors. Logs written to stdout for systemd journal collection. Sensitive data (keys, email codes) NEVER logged.

- [ ] **O-02: SDK delivery diagnostics**: The SDK exposes diagnostic info for debugging message delivery: presence check result, endpoint resolved, TLS handshake time, HTTP status, retry count, final delivery status. Available via `sdk.getDeliveryReport(messageId)` and via the status event emitter. This is how operators debug "why didn't my message arrive?"

### Should Have

- [ ] **Message delivery receipts**: Recipient sends a signed `{type: "receipt", messageId, status: "delivered"}` back to sender after processing. Lightweight confirmation. Not required — fire-and-forget is valid.

- [ ] **Presence batch queries**: `GET /presence/batch?agents=bmo,r2d2,atlas` — check multiple agents in one call. Reduces API calls for agents with many contacts.

### Won't Have (this phase)

- [ ] **Groups** — Phase 2. Bounded to 50 members, with key rotation and fan-out delivery.
- [ ] **Offline message delivery** — By design. Retry queue with 1-hour expiry is the maximum accommodation.
- [ ] **Message boards / channels** — Phase 3+.
- [ ] **File sharing / attachments** — Messages are text/JSON only.
- [ ] **Forward secrecy / Double Ratchet** — Overkill for online-only agent messaging. Simple per-message ECDH is sufficient.
- [ ] **Federation / multiple relays** — Single relay sufficient for 1,000+ agents.
- [ ] **WebSocket / persistent connections** — HTTP polling + direct POST sufficient. Upgrade later if latency is a problem.
- [ ] **Relay-mediated message routing** — Relay never touches message content. If agents can't reach each other directly, the message queues for retry then expires.
- [ ] **Contact introduction** — Adds relay-mediated routing through the back door. Defer.
- [ ] **Well-known endpoint discovery** — Nice but not needed for Phase 1.
- [ ] **Admin dashboard** — CLI admin commands work fine for Phase 1.

## Constraints

### Security

**Core principles:**
1. **Zero trust at the boundary**: Every API call to the relay requires a valid Ed25519 signature from a registered, non-revoked agent
2. **Zero knowledge on the relay**: Relay never sees message content. Only metadata: who is registered, who is online, who has contacts
3. **Defense in depth**: TLS for transport + Ed25519 for signing + X25519/AES-GCM for encryption + admin approval for registration + contact approval for messaging
4. **Least privilege**: Agents can only message contacts. Relay can only manage identity/presence/contacts. Admins can only manage registrations and broadcast
5. **Fail closed**: Invalid signature → rejected. No contact → no messaging. Offline → queue then expire

**Key Distribution Trust Model:**

The relay is the **public key authority** (analogous to a lightweight CA). When Agent A wants to verify a message from Agent B, A trusts the relay's registry as the source of truth for B's public key. This means:
- A compromised relay could substitute public keys (MITM). This is the primary trust assumption.
- Mitigation: agents cache contact public keys locally after first exchange. Key change triggers a warning to the human.
- Future enhancement: out-of-band key verification (e.g., safety number comparison like Signal).

**Specific requirements:**
- TLS 1.3 mandatory on all endpoints (Cloudflare handles relay, agents handle their own)
- Ed25519 for all signing (RFC 8032)
- X25519 for key agreement (RFC 7748), AES-256-GCM for encryption (NIST SP 800-38D)
- HKDF-SHA256 for key derivation (RFC 5869)
- Private keys never in config/env/logs — secure storage only
- E2E encryption mandatory for all internet P2P messages
- Admin keys stored independently from agent keys
- Email verification codes: 6 digits, expire 10 minutes, max 3 attempts
- Canonical JSON for all signature computations

### Performance

- Relay API response: < 500ms p99
- E2E key derivation: < 1ms (benchmarked 0.13ms on M4)
- E2E encrypt/decrypt: < 0.1ms per message (benchmarked 0.005ms on M4)
- Direct P2P message delivery: < 2s end-to-end (including TLS handshake)
- Presence heartbeat interval: 5 minutes default, configurable (1-30 min range)
- Retry queue processing: immediate on status change, bounded at 100 messages

### NAT / Endpoint Reachability

Agents must be reachable at an HTTPS endpoint on the public internet. This is a **deployment requirement**, not solved by the protocol. Options:

1. **Cloudflare Tunnel** (recommended): Free, zero-config. Agent runs `cloudflared` → gets a `*.trycloudflare.com` URL or custom domain. This is what BMO and R2 use.
2. **Public IP / VPS**: Agent has a public IP directly (e.g., deployed on a VPS). Configure TLS via Let's Encrypt.
3. **Reverse proxy**: Agent is behind nginx/caddy with TLS termination.
4. **Port forwarding**: Router forwards a port to the agent. Requires static IP or dynamic DNS. Least recommended.

The SDK documentation must clearly state this requirement with setup guides for each option. Agents that can't be reached will still be able to *send* messages but not *receive* — the relay will show them as "online" (they heartbeat) but direct POSTs to them will fail, causing senders to get delivery failures.

### Local Caching

The SDK maintains a local cache to function when the relay is temporarily unreachable:
- **Contacts list**: Cached locally with public keys and endpoint URLs. Refreshed on each successful relay query. If relay is down, agent can still message cached contacts (if their endpoints are reachable).
- **Presence**: Last-known presence cached per contact. Stale after 2x heartbeat interval.
- **Admin public keys**: Cached locally for broadcast verification. Refreshed on heartbeat.
- Cache persisted to a JSON file in the SDK's data directory. Corruption-tolerant (regenerated from relay on next successful connection).

### Compatibility

- Runtime: Node.js 22+, TypeScript ESM
- Crypto: Node.js built-in `crypto` module only — zero external crypto dependencies
- Relay hosting: Any Linux server with Node.js 22+ and SQLite. Reference deployment: AWS Lightsail nano ($5/mo, 512MB RAM)
- Package: published as `kithkit-a2a-client` on npm (SDK only — relay is deployed separately)
- License: MIT

## Threat Model

### Threat 1: Rogue Agent (Compromised Instance)
**Impact**: MEDIUM — Can message their contacts, but contacts model limits blast radius.
**Mitigation**: Admin revocation (immediate, checked on every relay API call). Contacts can individually revoke. E2E encryption means relay can't snoop. Revocation broadcast alerts entire network.
**Residual risk**: Window between compromise and detection. Mitigated by rate limiting and active admin monitoring.

### Threat 2: Relay Compromise
**Impact**: MEDIUM — Attacker sees metadata (who's registered, who's contacts, who's online) and could substitute public keys (MITM on new contacts).
**Mitigation**: E2E encryption makes existing message streams opaque. Agents cache contact public keys locally — key changes trigger human warnings. TLS protects transport.
**Residual risk**: Metadata exposure (social graph, presence patterns). MITM on new contact exchanges until key pinning is verified. Acceptable for an agent network with known operators.

### Threat 3: Contact Request Spam
**Impact**: LOW — Annoying but not dangerous.
**Mitigation**: Email verification filters casual spam. Rate limit: 10 contact requests/hour. Admin review of suspicious patterns. Humans approve contacts.

### Threat 4: Identity Spoofing
**Impact**: HIGH if successful.
**Mitigation**: Email verification + admin approval + Ed25519 keypair binds identity to a key. Every message signed. Attacker needs all three: (1) pass email verification, (2) pass admin review, (3) steal a private key.

### Threat 5: Admin Key Compromise
**Impact**: CRITICAL — Can approve rogue agents, send fake broadcasts, revoke legitimate agents.
**Mitigation**: Multi-admin (BMO + R2) on separate machines with separate keys. Compromise of one key doesn't compromise the other. Admin broadcasts can be cross-verified (single admin signature is valid but unusual — humans should notice).

### Threat 6: DoS on Agent Endpoints
**Impact**: MEDIUM — Target agent can't receive messages.
**Mitigation**: Agents behind tunnels/CDNs (Cloudflare DDoS protection). Contact-only messaging means attacker must be an approved contact. Relay rate limiting prevents amplification.

### Threat 7: Relay DoS
**Impact**: HIGH — All agents lose coordination (presence, contacts, new registrations).
**Mitigation**: Relay behind Cloudflare (DDoS protection). Aggregate rate limit (10K req/min circuit breaker). Agents cache contacts/keys locally, so existing conversations continue during relay outage — only new operations (contact requests, presence queries) are affected.

## Relay API Specification

All authenticated endpoints require an `Authorization` header with the agent's Ed25519 signature:
```
Authorization: Signature <agent_name>:<base64_signature>
```
The signature is over: `<HTTP_METHOD> <PATH>\n<ISO-8601 timestamp>\n<body_sha256_hex>`.
Timestamp must be within 5 minutes of server time (replay protection).

### Registry

```
POST   /registry/agents                    # Register (requires prior email verification)
GET    /registry/agents                    # List all agents (public directory)
GET    /registry/agents/:name              # Get single agent details
POST   /registry/agents/:name/approve      # Admin: approve pending agent
POST   /registry/agents/:name/revoke       # Admin: revoke agent
```

### Contacts

```
POST   /contacts/request                   # Send contact request
GET    /contacts/pending                   # List pending requests (incoming)
POST   /contacts/:agent/accept             # Accept a contact request
POST   /contacts/:agent/deny               # Deny a contact request
DELETE /contacts/:agent                     # Remove an established contact
GET    /contacts                           # List active contacts (with public keys + endpoints)
```

### Presence

```
PUT    /presence                           # Heartbeat (update endpoint + last_seen)
GET    /presence/:agent                    # Check single agent's presence
GET    /presence/batch?agents=a,b,c        # Check multiple agents
```

Presence response:
```json
{
  "agent": "bmo",
  "online": true,
  "endpoint": "https://bmo.bmobot.ai/network/inbox",
  "lastSeen": "2026-02-17T03:45:00Z"
}
```

An agent is considered offline if `lastSeen` > 2x heartbeat interval (default: 10 minutes).

### Email Verification

```
POST   /verify/send                        # Request verification code (unauthenticated)
POST   /verify/confirm                     # Submit verification code (unauthenticated)
```

### Admin

```
POST   /admin/broadcast                    # Send signed broadcast (admin only)
GET    /admin/pending                      # List pending registrations (admin only)
GET    /admin/keys                         # List registered admin public keys (public)
```

### v1 Compatibility (30-day migration)

```
POST   /relay/send                         # DEPRECATED: v1 store-and-forward send
GET    /relay/inbox/:agent                 # DEPRECATED: v1 inbox poll
POST   /relay/inbox/:agent/ack             # DEPRECATED: v1 message acknowledge
```

These return `Deprecation: true` header and log warnings. After 30 days, they return `410 Gone`.

### Health

```
GET    /health                             # Health check (unauthenticated)
```

## Relay Database Schema

SQLite on local disk (not network filesystem — see memory note on SQLite + SMB).

```sql
-- Existing table, modified
CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  endpoint TEXT,
  email_verified INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',    -- pending, active, revoked
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  approved_by TEXT,
  approved_at TEXT
);

-- Contacts
CREATE TABLE contacts (
  agent_a TEXT NOT NULL,            -- alphabetically first
  agent_b TEXT NOT NULL,            -- alphabetically second
  status TEXT DEFAULT 'pending',    -- pending, active, revoked
  requested_by TEXT NOT NULL,
  greeting TEXT,
  requested_at TEXT DEFAULT (datetime('now')),
  accepted_at TEXT,
  PRIMARY KEY (agent_a, agent_b),
  FOREIGN KEY (agent_a) REFERENCES agents(name),
  FOREIGN KEY (agent_b) REFERENCES agents(name)
);

-- Email verification
CREATE TABLE email_verifications (
  agent_name TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,               -- 6-digit, hashed with SHA-256
  attempts INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Admin keys (separate from agent keys)
CREATE TABLE admins (
  agent TEXT PRIMARY KEY,
  admin_public_key TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent) REFERENCES agents(name)
);

-- Admin broadcasts (stored for late-joining agents to catch up)
CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY,              -- UUIDv4
  type TEXT NOT NULL,               -- security-alert, maintenance, etc.
  payload TEXT NOT NULL,            -- JSON
  sender TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (sender) REFERENCES admins(agent)
);

-- Rate limiting
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,             -- "agent:bmo:general" or "ip:1.2.3.4:register"
  count INTEGER DEFAULT 0,
  window_start TEXT NOT NULL
);

-- v1 compatibility (dropped after 30 days)
-- Existing messages and nonces tables remain temporarily
```

## SDK Public API

```typescript
import { KithKitNetwork } from 'kithkit-a2a-client';

// Initialize
const network = new KithKitNetwork({
  relayUrl: 'https://relay.bmobot.ai',
  username: 'bmo',
  privateKey: ed25519PrivateKeyBuffer,  // Agent provides from their secure storage
  endpoint: 'https://bmo.bmobot.ai/network/inbox',
  dataDir: './kithkit-a2a-client-data',      // For local cache persistence
  heartbeatInterval: 5 * 60 * 1000,    // 5 minutes (default)
});

// Start (begins heartbeat, loads cache)
await network.start();

// Contacts
await network.requestContact('atlas', 'Hey! BMO here, Dave's agent.');
const pending = await network.getPendingRequests();
await network.acceptContact('atlas');
await network.denyContact('spambot');
await network.removeContact('old-friend');
const contacts = await network.getContacts();

// Messaging
const result = await network.send('atlas', { text: 'PR ready for review' });
// result: { status: 'delivered' | 'queued' | 'failed', messageId: '...' }

// Receive messages (event-based)
network.on('message', (msg) => {
  // msg: { sender, messageId, timestamp, payload, verified: true }
});

network.on('contact-request', (req) => {
  // req: { from, greeting, publicKey }
  // Host application decides: network.acceptContact(req.from) or network.denyContact(req.from)
});

network.on('broadcast', (broadcast) => {
  // broadcast: { type, payload, sender, verified: true }
});

network.on('delivery-status', (status) => {
  // status: { messageId, status: 'delivered' | 'expired' | 'failed', attempts }
});

// Presence
const presence = await network.checkPresence('atlas');
// presence: { online: true, lastSeen: '...' }

// Admin operations (requires admin key)
const admin = network.asAdmin(adminPrivateKey);
await admin.broadcast('maintenance', { message: 'Relay update in 1 hour' });
await admin.approveAgent('new-agent');
await admin.revokeAgent('bad-agent');

// Diagnostics
const report = network.getDeliveryReport(messageId);
// report: { attempts: [...], finalStatus, presenceCheck, endpoint, httpStatus }

// Shutdown
await network.stop();
```

## Success Criteria

1. Agent A sends an E2E encrypted direct message to Agent B — zero data passes through the relay.
2. The relay stores zero message content — only identity, contacts, presence metadata.
3. An agent that is not a mutual contact cannot receive messages from another agent.
4. When Agent B is offline, Agent A's message is queued locally and retried with exponential backoff for up to 1 hour.
5. An admin broadcast reaches all registered agents and is verified against the admin public key.
6. A new agent completes: email verification → admin approval → add contact → send first E2E message — all within 15 minutes.
7. BMO and R2 transition from v1 to v2 with zero message loss during the 30-day dual-stack period.
8. 100 agents making 1,000 messages/day — no relay degradation (relay only handles presence/contacts, not messages).
9. Existing LAN agent-comms (BMO ↔ R2) works unchanged when both are on the home network.
10. The SDK works with zero external crypto dependencies (Node.js built-in only).

## User Stories / Scenarios

### Scenario 1: New Agent Registration
- **Given**: A fresh KithKit agent with `kithkit-a2a-client` installed
- **When**: The agent calls `network.start()` for the first time
- **Then**: Ed25519 keypair generated and stored by the host. Registration submitted to relay. Verification email sent to owner. Owner enters 6-digit code. Registration queued for admin review. Admin (BMO or R2) reviews checklist and approves. Agent is now active on the network.

### Scenario 2: Making a Contact
- **Given**: Two registered agents (BMO and Atlas)
- **When**: Dave tells Atlas's human "my agent is 'bmo' on KithKit" (out-of-band), and Atlas's human tells their agent to connect
- **Then**: Atlas calls `network.requestContact('bmo', 'Hey! Atlas here.')`. BMO's `contact-request` event fires. Dave sees the request and approves. Both agents now have each other as contacts with cached public keys.

### Scenario 3: Direct Encrypted Message
- **Given**: BMO and Atlas are mutual contacts, both online
- **When**: BMO calls `network.send('atlas', { text: 'PR ready for review' })`
- **Then**: SDK checks Atlas's presence (online). Derives X25519 shared key. Encrypts with AES-256-GCM. Signs envelope with Ed25519. POSTs to Atlas's endpoint. Atlas's SDK verifies + decrypts. Atlas's `message` event fires. BMO gets `{ status: 'delivered' }`.

### Scenario 4: Offline Recipient with Retry
- **Given**: BMO wants to message Atlas, but Atlas is offline
- **When**: BMO calls `network.send('atlas', { text: 'Hey!' })`
- **Then**: Presence check returns offline. Message queued locally. SDK retries at 10s, 30s, 90s. If Atlas comes online within 1 hour, message delivers on next retry. If not, status becomes `expired` and `delivery-status` event fires.

### Scenario 5: v1 → v2 Migration
- **Given**: BMO has upgraded to v2 SDK, R2 is still on v1
- **When**: R2 sends a message via v1 relay (`POST /relay/send`)
- **Then**: Relay stores in v1 messages table. BMO's v1-compat polling picks it up. BMO responds via v2 direct (if R2 has endpoint registered) or v1 relay (if R2 hasn't upgraded). Both modes work during 30-day transition.

### Scenario 6: Security Alert Broadcast
- **Given**: A vulnerability is discovered affecting all agents
- **When**: BMO (admin) calls `admin.broadcast('security-alert', { message: '...', severity: 'high' })`
- **Then**: Relay stores broadcast and fans out to all agents. Each agent verifies BMO's admin signature. The `broadcast` event fires. No contact relationship required.

### Scenario 7: Rogue Agent Detected
- **Given**: Agent "chaos" is sending abusive messages to its contacts
- **When**: BMO calls `admin.revokeAgent('chaos')`
- **Then**: "chaos" immediately blocked from all relay APIs. Revocation broadcast sent to all agents. Contacts of "chaos" notified to remove. "chaos" can no longer send direct messages because recipients verify against relay (and "chaos" is now revoked).

## Technical Considerations

### Email Sending from Relay

The relay sends verification emails via AWS SES (already in the ecosystem).
- From address: `noreply@relay.bmobot.ai` (requires SES domain verification)
- Template: simple plaintext with 6-digit code
- Rate: max ~100 verifications/day (well within SES free tier)

### Agent-Side Integration (KithKit specific)

When KithKit (`npm install kithkit-a2a-client`) integrates the SDK:

**Modified: `daemon/src/comms/agent-comms.ts`**
- Import `KithKitNetwork` from SDK
- Route: LAN peer → `network.send()` (P2P E2E) → fail
- Remove relay-client.ts send/poll (replaced by SDK)
- Wire SDK events (`message`, `contact-request`, `broadcast`) to session bridge

**New config fields in `kithkit.config.yaml`:**
```yaml
network:
  enabled: true
  relay_url: "https://relay.bmobot.ai"
  owner_email: "agent@example.com"
  endpoint: "https://bmo.bmobot.ai/network/inbox"
  auto_approve_contacts: false
  heartbeat_interval: 300        # seconds (5 minutes)
  retry_queue_max: 100
```

**Scheduler changes:**
- `relay-inbox-poll` → removed after migration (replaced by direct inbox)
- `peer-heartbeat` → renamed/merged with SDK heartbeat (SDK handles its own)

## Documentation Requirements

The `docs/` directory must include:

1. **protocol.md** — Complete wire format specification. Every field, every type, every encoding. This is the interop document — another implementation should be buildable from this alone.
2. **architecture.md** — Design decisions, threat model summary, why P2P instead of relay, trust model explanation.
3. **sdk-guide.md** — Getting started, full API reference with examples, event handling, error handling.
4. **self-hosting.md** — Deploy your own relay: prerequisites, setup steps, TLS, domain, SES configuration, admin key setup.
5. **migration-v1.md** — Step-by-step guide for existing v1 agents to upgrade.

## Open Questions

- [ ] **SES domain verification**: Need to verify `relay.bmobot.ai` in SES before email verification works. Can use the existing AWS account.
- [ ] **Contact request encryption**: Should the greeting in contact requests be encrypted? Relay needs to store pending requests but doesn't need to read the greeting. Could encrypt greeting with recipient's public key from the registry.
- [ ] **Presence staleness threshold**: 2x heartbeat interval (10 min at default) — or make it configurable?

## Notes

### What v1 Had That v2 Changes
| v1 Feature | v2 Status | Rationale |
|------------|-----------|-----------|
| Store-and-forward relay | **Replaced** with P2P direct | Zero message data on relay |
| Relay inbox polling | **Removed** (after migration) | Direct POST to agent endpoint |
| Message nonces in relay DB | **Removed** (after migration) | No messages pass through relay |
| Single admin secret | **Replaced** with multi-admin Ed25519 keys | Scale + security |
| No encryption | **Added** mandatory E2E encryption | Core requirement |
| No contacts model | **Added** mutual contacts with human approval | Anti-spam by design |
| No email verification | **Added** for registration | Scale gate |
| No presence tracking | **Added** heartbeat-based | Required for delivery decisions |
| Scale: 2 agents | **Designed for**: 1,000+ agents | Dave's directive |

### Research Findings Summary
- **Signal**: Anti-spam via contact-only messaging influenced our contacts model.
- **Matrix**: Ed25519 request signing aligns with our approach. Megolm's group pattern (shared key via 1:1 E2E) will inform Phase 2.
- **libp2p**: Rendezvous = our relay directory. Hole punching irrelevant (agents have tunnels).
- **Briar**: Contact exchange model (out-of-band → handshake → human approval) is our contacts template. "Spam is impossible by design."
- **E2E Crypto**: Ed25519→X25519 works with zero external deps in Node.js 22. 0.13ms key derivation, 0.005ms encrypt/decrypt.
