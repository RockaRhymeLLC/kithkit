# Plan: KithKit Chrome Connect

**Spec**: projects/kkit-chrome-connect/20260224-kkit-chrome-connect.spec.md
**To-Do**: 42
**Created**: 2026-02-24

## Technical Approach

### Two-Repo Architecture

This feature spans two codebases:

1. **kkit-chrome-connect** (new repo: `RockaRhymeLLC/kkit-chrome-connect`) — The Chrome extension. Manifest V3, TypeScript, no build tools beyond tsc. Ships as an unpacked extension (no Chrome Web Store for v1).
2. **KKit-BMO** (this repo) — Daemon-side changes to `cowork-bridge.ts`. Adds token auth, X25519 key exchange, AES-256-GCM encryption, PSK management endpoints, and TOFU fingerprint support.

### Extension Architecture

```
kkit-chrome-connect/
├── manifest.json          # MV3 manifest, chrome.debugger permission
├── tsconfig.json          # TypeScript config (target ES2022, module ES2022)
├── src/
│   ├── background.ts      # Service worker — WebSocket, crypto, CDP relay, keepalive
│   ├── crypto.ts          # X25519 + PSK-HKDF + AES-256-GCM (WebCrypto)
│   ├── popup.ts           # Popup UI logic — connect/disconnect, status, fingerprint
│   ├── popup.html         # Popup markup
│   ├── popup.css          # Popup styles
│   └── keepalive.ts       # Offscreen document script (25s interval ping)
├── keepalive.html         # Offscreen document shell
├── icons/                 # Extension icons (16, 48, 128)
├── dist/                  # tsc output (gitignored)
└── README.md
```

### Daemon-Side Architecture

The existing `cowork-bridge.ts` is upgraded in-place:

- **Token auth**: First message after WebSocket upgrade must be `{ type: "auth", token: "<hex>" }`. Validated against `kithkit.db` config.
- **Key exchange**: After auth, X25519 ephemeral keypair + PSK-authenticated HKDF + hello/hello-ack confirmation.
- **Encryption layer**: `sendFrame` and `handleFrame` gain encrypt/decrypt wrappers. All application messages go through `EncryptedEnvelope`.
- **Sequence counters**: Each direction has an independent counter (1-based), strict `seq === lastSeen + 1` validation.
- **New API endpoints**: `POST /api/cowork/generate-psk`, `POST /api/cowork/rotate-token`, `GET /api/cowork/fingerprint`.
- **PSK storage**: macOS Keychain (`credential-cowork-token`) primary, `kithkit.db` config as runtime cache.

### Crypto Strategy

- Zero external dependencies on both sides
- Extension: WebCrypto API (`crypto.subtle`) — X25519 for ECDH, HKDF-SHA256, AES-256-GCM
- Daemon: Node.js `node:crypto` — `generateKeyPairSync('x25519')`, `diffieHellman`, `hkdfSync`, `createCipheriv`/`createDecipheriv`
- PSK mixed into HKDF salt via HMAC-SHA256(PSK, "kkit-cowork-e2e-v1")
- Nonces: 12 random bytes per message
- AAD: `"cowork:<seq>"` binds ciphertext to sequence number

### Keepalive Strategy

Three layers:
1. **Offscreen document** (primary) — `keepalive.html` with 25s `setInterval` posting `chrome.runtime.sendMessage({ type: 'keepalive' })`
2. **chrome.alarms** (backup) — 30s recurring alarm
3. **Natural WebSocket traffic** — incoming messages reset suspension timer

### Build Order Rationale

Stories are ordered to build foundations first:
1. Repo scaffold + extension skeleton (can be tested immediately)
2. Daemon crypto + token/PSK management (foundation for all secure comms)
3. Extension crypto (mirrors daemon, can be unit-tested independently)
4. Daemon auth + key exchange protocol (integrates 2)
5. Extension WebSocket + key exchange (integrates 3, talks to 4)
6. CDP relay with encryption (builds on 4+5)
7. Popup UI + badge (user-facing, depends on everything above)
8. Keepalive + offscreen document (reliability layer)
9. Tab management (extends CDP relay)
10. TOFU fingerprint display (final polish)
11. Integration testing + README (verification + docs)

## User Perspective

**Primary User**: Hybrid (Dave via popup UI + BMO/agents via daemon REST API)
**How They Interact**: Dave uses the Chrome extension popup to connect/disconnect and verify encryption status. BMO sends CDP commands via `POST /api/cowork/cdp`. Both sides see encrypted traffic.
**Test Approach**: Tests simulate both sides — extension-side WebSocket client behavior AND daemon-side API calls. Crypto tests verify cross-platform interoperability (WebCrypto ↔ Node.js crypto).

## Stories

| ID | Title | Priority | Size | Tests | Blocked By |
|----|-------|----------|------|-------|------------|
| s-c01 | Scaffold extension repo and MV3 manifest | 1 | S | t-001 | — |
| s-c02 | Daemon-side crypto module (X25519 + PSK-HKDF + AES-256-GCM) | 2 | M | t-002, t-003 | — |
| s-c03 | Extension-side crypto module (WebCrypto mirror) | 3 | M | t-004 | — |
| s-c04 | Daemon token auth + PSK management endpoints | 4 | M | t-005, t-006 | s-c02 |
| s-c05 | Daemon key exchange protocol (ECDH + hello/hello-ack) | 5 | M | t-007 | s-c02, s-c04 |
| s-c06 | Extension WebSocket client + key exchange | 6 | M | t-008 | s-c01, s-c03 |
| s-c07 | Encrypted CDP relay (daemon ↔ extension) | 7 | M | t-009, t-010 | s-c05, s-c06 |
| s-c08 | Extension popup UI (connect/disconnect/status) | 8 | M | t-011 | s-c06 |
| s-c09 | MV3 keepalive (offscreen document + alarms) | 9 | S | t-012 | s-c06 |
| s-c10 | Tab management (list/switch/detach handling) | 10 | M | t-013 | s-c07 |
| s-c11 | TOFU fingerprint display in popup | 11 | S | t-014 | s-c05, s-c08 |
| s-c12 | Integration tests + README | 12 | M | t-015, t-016 | s-c07, s-c10 |

## Dependencies

```
s-c01 (scaffold) ─────────────────────┐
s-c02 (daemon crypto) ──┬─> s-c04 ──┬─> s-c05 ──┐
                         │           │            ├─> s-c07 ──┬─> s-c10
s-c03 (ext crypto) ─────┴─> s-c06 ──┴────────────┘           │
                              │                               ├─> s-c12
                              ├─> s-c08 ──> s-c11             │
                              └─> s-c09                       └─> s-c12
```

## Files to Create/Modify

### New Files (kkit-chrome-connect repo)
- `manifest.json` — MV3 manifest with debugger, storage, offscreen permissions
- `tsconfig.json` — TypeScript configuration
- `src/background.ts` — Service worker entry point
- `src/crypto.ts` — WebCrypto encryption module
- `src/popup.ts` — Popup UI logic
- `src/popup.html` — Popup markup
- `src/popup.css` — Popup styles
- `src/keepalive.ts` — Offscreen document keepalive script
- `keepalive.html` — Offscreen document shell
- `icons/icon-16.png`, `icons/icon-48.png`, `icons/icon-128.png` — Extension icons
- `README.md` — Setup instructions, PSK configuration, architecture overview

### Modified Files (KKit-BMO repo)
- `daemon/src/extensions/cowork-bridge.ts` — Token auth, key exchange, encryption layer, sequence counters
- `daemon/src/extensions/index.ts` — Register new cowork API routes (PSK, token rotation, fingerprint)
- `daemon/src/__tests__/cowork-bridge.test.ts` — Update tests for auth + encryption protocol

### New Files (KKit-BMO repo)
- `daemon/src/extensions/cowork-crypto.ts` — Daemon-side crypto module (extracted for testability)
- `daemon/src/__tests__/cowork-crypto.test.ts` — Crypto unit tests

## Notes

- Chrome 114+ minimum — WebCrypto X25519 landed in Chrome 113, 114+ for stability
- No npm dependencies in the extension — all crypto via WebCrypto
- No npm dependencies for daemon crypto — all via `node:crypto`
- Extension is loaded as unpacked for v1 (no Chrome Web Store publishing)
- PSK stored in macOS Keychain (`credential-cowork-token`) — daemon reads from Keychain on startup, caches in `kithkit.db`
- Token auth is separate from PSK — token authenticates the WebSocket, PSK authenticates the key exchange
- TOFU fingerprint: SHA-256 of daemon's X25519 public key, truncated to first 16 hex chars, displayed in popup
- Existing cowork-bridge tests will be updated to account for the new auth/encryption protocol
- The `_resetCoworkBridgeForTesting` helper must also reset crypto state

Tests: 16 tests written, all expected to fail before implementation (red state confirmed).
