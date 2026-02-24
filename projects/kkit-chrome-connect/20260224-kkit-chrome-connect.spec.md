# Spec: KithKit Chrome Connect

**Created**: 2026-02-24
**Status**: Draft
**Reviewed**: Bob (devil's advocate), R2 (peer review)

## Goal

Replace the fragile `--remote-debugging-port` + SSH tunnel approach for shared browser sessions with a clean, secure Chrome extension that bridges Chrome's debugger API to a KithKit daemon over an encrypted WebSocket channel — ensuring Cloudflare (or any TLS-terminating proxy) cannot read CDP payloads or chat messages.

## Requirements

### Must Have

- [ ] Manifest V3 Chrome extension with service worker architecture
- [ ] WebSocket connection from extension to daemon at `wss://<host>/cowork`
- [ ] Relay CDP commands between daemon and active tab via `chrome.debugger` API
- [ ] Tab management: list tabs, switch tabs, track active tab changes
- [ ] Toolbar popup for connect/disconnect with host configuration
- [ ] Service worker keepalive strategy (see [MV3 Keepalive Strategy](#mv3-service-worker-keepalive-strategy))
- [ ] Token-based authentication on WebSocket connect (see [Token Auth](#token-authentication))
- [ ] End-to-end encryption of all CDP payloads and chat messages (see Security section)
- [ ] X25519 key exchange with PSK-authenticated HKDF for MITM protection (see [Key Exchange](#key-exchange-on-websocket-connect-after-token-auth))
- [ ] AES-256-GCM symmetric encryption for all message payloads
- [ ] Chrome WebCrypto API on extension side, Node.js `crypto` on daemon side
- [ ] Cloudflare sees only opaque encrypted blobs — no plaintext CDP or chat data
- [ ] Key exchange occurs after token auth, before any application messages
- [ ] Graceful degradation: clear error if encryption handshake fails
- [ ] Popup state recovery via `chrome.storage.session` (popup loses state on close in MV3)

### Should Have

- [ ] Visual indicator (badge) showing encryption status (encrypted vs. plaintext fallback)
- [ ] Exportable session transcript (decrypted locally, never on server)
- [ ] `chrome.debugger.onDetach` handler with user-facing notification

### Won't Have (v1)

- No persistent identity keys in the extension (ephemeral per session — forward secrecy)
- No multi-party encryption (single daemon ↔ single extension session)
- No certificate pinning for the WebSocket TLS connection
- No auto-reconnect (user must click Connect again — simpler for v1, revisit if UX is painful)
- No session key rotation / rekey protocol (deferred to v2 — see [Deferred: Rekey Protocol](#deferred-rekey-protocol-v2))

## Constraints

### Security

End-to-end encryption is a **first-class requirement**, not an afterthought. The threat model: Cloudflare terminates TLS for the WebSocket endpoint, meaning Cloudflare infrastructure can observe plaintext WebSocket frames. All sensitive data must be encrypted before it enters the WebSocket.

#### Threat Model

| Threat | Mitigation |
|--------|------------|
| Cloudflare sees plaintext CDP traffic | E2E encryption — all payloads encrypted before WebSocket send |
| MITM substitutes ECDH keys (e.g. Cloudflare or proxy) | **PSK mixed into HKDF derivation** — attacker without the PSK derives a different session key, hello/hello-ack fails immediately (see [R2 Review: PSK Fix](#r2-review-psk-mitm-fix)) |
| Replay attacks | AES-256-GCM with unique nonce per message + message sequence counter with strict validation |
| Session hijacking after token theft | Token only authenticates; session key requires ECDH + PSK — token alone is insufficient to decrypt |
| Compromised session key | Ephemeral keys — new ECDH keypair per WebSocket connection, old keys are discarded |
| Tampered ciphertext | GCM authentication tag detects tampering; connection terminates on auth failure |

#### Token Authentication

The extension must authenticate before the ECDH key exchange begins. Token details:

- **Format**: Random 256-bit token, hex-encoded (64 characters)
- **Generation**: Created by the daemon on first start, stored in `kithkit.db` config table
- **Storage (extension)**: Entered by user in popup, stored in `chrome.storage.session` (cleared on browser close)
- **Validation**: Extension sends `{ type: "auth", token: "<hex>" }` as the first message after WebSocket connect. Daemon validates against stored token. On failure: close WebSocket with code 4000 ("Authentication failed").
- **Rotation**: `POST /api/cowork/rotate-token` generates a new token and invalidates the old one.

> **Note**: The token is transmitted over TLS (visible to Cloudflare). It authenticates the client but does NOT protect message confidentiality — that's what E2E encryption is for. The PSK (below) provides the MITM-proof binding that the token cannot.

#### Encryption Protocol

The encryption protocol follows the same pattern as the KithKit A2A agent-comms protocol (see `.a2a-sdk/packages/sdk/src/crypto.ts`), adapted for the WebSocket session context, with the addition of a pre-shared key (PSK) to authenticate the ECDH exchange.

##### R2 Review: PSK MITM Fix

**BLOCKING finding from R2's peer review**: The original ECDH key exchange was unauthenticated. A TLS-terminating proxy (Cloudflare, corporate proxy, or any MITM) could substitute both sides' ECDH public keys, establishing two separate encrypted sessions and relaying traffic transparently. The HKDF `info` field contained public keys, but the MITM simply uses their own keys — both sides derive valid (but different) session keys with the MITM in the middle.

**Fix**: Mix a pre-shared key (PSK) into the HKDF salt. The PSK is configured locally on both the daemon and the extension, and is **never transmitted over the wire**. Without the PSK, an attacker who substitutes ECDH keys will derive a different session key, and the hello/hello-ack confirmation will fail immediately (GCM auth tag mismatch).

- **PSK format**: Random 256-bit value, hex-encoded (64 characters)
- **PSK generation**: Created by the daemon via `POST /api/cowork/generate-psk`, stored in `kithkit.db`
- **PSK distribution**: Displayed to Dave once (or copied from daemon CLI). Dave enters it in the extension popup. **Never transmitted over any network channel.**
- **PSK storage (extension)**: `chrome.storage.local` (persists across sessions — unlike the auth token which uses `chrome.storage.session`)
- **PSK storage (daemon)**: `kithkit.db` config table

##### Key Exchange (on WebSocket connect, after token auth)

```
1. Extension generates ephemeral X25519 keypair using WebCrypto:
   const extensionKeyPair = await crypto.subtle.generateKey(
     { name: 'X25519' }, false, ['deriveBits']
   );

2. Daemon generates ephemeral X25519 keypair using Node.js crypto:
   const daemonKeyPair = crypto.generateKeyPairSync('x25519');

3. Extension sends its public key:
   → { type: "key-exchange", publicKey: "<base64 raw X25519 public key>" }

4. Daemon receives, computes shared secret, sends its public key:
   ← { type: "key-exchange", publicKey: "<base64 raw X25519 public key>" }

5. Both sides derive the symmetric AES-256 key (PSK-authenticated):
   sharedSecret = X25519(myPrivate, theirPublic)
   sessionKey = HKDF-SHA256(
     ikm: sharedSecret,
     salt: HMAC-SHA256(key: PSK, data: "kkit-cowork-e2e-v1"),
     info: "<extensionPublicKey>:<daemonPublicKey>" (sorted alphabetically),
     length: 32 bytes
   )

   The salt is derived from the PSK rather than being a static string.
   This ensures that without the correct PSK, the derived session key
   is different — a MITM who substitutes ECDH keys but lacks the PSK
   will derive a session key that doesn't match either endpoint.

6. Extension sends encrypted "hello" to confirm key agreement:
   → { type: "encrypted", payload: "<base64 ciphertext>", nonce: "<base64 12-byte nonce>" }
   (plaintext: { type: "hello", userAgent: "..." })

7. Daemon decrypts, verifies, and responds with encrypted ack:
   ← { type: "encrypted", payload: "<base64 ciphertext>", nonce: "<base64 12-byte nonce>" }
   (plaintext: { type: "hello-ack" })

   If decryption fails at step 6 or 7 (GCM auth tag mismatch), the
   session is immediately terminated. This is the MITM detection point —
   a key-substitution attack is caught here because the derived session
   keys won't match.

8. Session is now encrypted. All subsequent messages use the "encrypted" envelope.
```

##### Message Encryption

Once the key exchange completes, **every message** uses this envelope:

```typescript
// Wire format (what Cloudflare sees)
interface EncryptedEnvelope {
  type: "encrypted";
  seq: number;           // Monotonically increasing sequence number
  payload: string;       // Base64-encoded AES-256-GCM ciphertext
  nonce: string;         // Base64-encoded 12-byte random nonce
}
```

Encryption details:
- **Algorithm**: AES-256-GCM
- **Key**: 32-byte session key derived from ECDH + PSK + HKDF (see above)
- **Nonce**: 12 random bytes, unique per message (generated by sender)
- **AAD** (Additional Authenticated Data): the string `"cowork:<seq>"` where `<seq>` is the message sequence number (prevents reordering/replay)
- **Auth tag**: 16 bytes, appended to ciphertext (standard GCM behavior)

The plaintext is the JSON-serialized original message (e.g., `{ type: "cdp", id: 1, method: "Page.navigate", params: {...} }`).

##### Sequence Counter Validation

Each direction maintains its own independent sequence counter, starting at 1.

**Strict validation rule**: The receiver MUST check that `seq === lastSeenSeq + 1` (not just `seq > lastSeenSeq`). This is gap-detection, not just replay-detection:

- `seq === lastSeenSeq + 1` → accept, update lastSeenSeq
- `seq <= lastSeenSeq` → replay or reorder → close with code 4003
- `seq > lastSeenSeq + 1` → gap (dropped message) → close with code 4003

Rationale: WebSocket guarantees in-order delivery over a single connection, so a gap means corruption or tampering, not network reordering. Closing on gap is the correct behavior.

##### Extension-Side Crypto (WebCrypto API)

```javascript
// Key generation
const keyPair = await crypto.subtle.generateKey(
  { name: 'X25519' }, true, ['deriveBits']
);

// ECDH shared secret
const sharedBits = await crypto.subtle.deriveBits(
  { name: 'X25519', public: theirPublicKey },
  myPrivateKey,
  256  // 32 bytes
);

// PSK-authenticated HKDF salt derivation
// Import PSK as HMAC key, compute HMAC-SHA256("kkit-cowork-e2e-v1")
const pskKey = await crypto.subtle.importKey(
  'raw', hexToBuffer(pskHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
);
const salt = new Uint8Array(
  await crypto.subtle.sign('HMAC', pskKey, encoder.encode('kkit-cowork-e2e-v1'))
);

// HKDF key derivation (with PSK-derived salt)
const baseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
const sessionKey = await crypto.subtle.deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: salt,
    info: encoder.encode(sortedKeyInfo) },
  baseKey,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt']
);

// Encrypt
const nonce = crypto.getRandomValues(new Uint8Array(12));
const aad = encoder.encode(`cowork:${seq}`);
const ciphertext = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: nonce, additionalData: aad },
  sessionKey,
  encoder.encode(JSON.stringify(plainMessage))
);

// Decrypt
const plaintext = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: nonce, additionalData: aad },
  sessionKey,
  ciphertext
);
```

##### Daemon-Side Crypto (Node.js `crypto`)

```typescript
import { generateKeyPairSync, diffieHellman, hkdfSync,
         randomBytes, createCipheriv, createDecipheriv,
         createPublicKey, createPrivateKey, createHmac } from 'node:crypto';

// Key generation
const { publicKey, privateKey } = generateKeyPairSync('x25519');

// ECDH shared secret
const shared = diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey });

// PSK-authenticated HKDF salt derivation
const pskBuffer = Buffer.from(pskHex, 'hex');
const salt = createHmac('sha256', pskBuffer).update('kkit-cowork-e2e-v1').digest();

// HKDF key derivation (with PSK-derived salt)
const sessionKey = Buffer.from(
  hkdfSync('sha256', shared, salt, sortedKeyInfo, 32)
);

// Encrypt
const nonce = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
cipher.setAAD(Buffer.from(`cowork:${seq}`));
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

// Decrypt
const decipher = createDecipheriv('aes-256-gcm', sessionKey, nonce);
decipher.setAAD(Buffer.from(`cowork:${seq}`));
const tag = ciphertext.subarray(ciphertext.length - 16);
const data = ciphertext.subarray(0, ciphertext.length - 16);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
```

##### Key Encoding on the Wire

| Data | Encoding |
|------|----------|
| X25519 public keys | Base64 of raw 32-byte key |
| Ciphertext | Base64 of AES-256-GCM output (ciphertext + 16-byte auth tag) |
| Nonces | Base64 of 12 random bytes |
| Sequence numbers | Integer, starting at 1, incrementing per message per direction |
| PSK | **Never on the wire** — hex-encoded 256-bit value, configured locally only |

##### Error Handling

- If token auth fails → close WebSocket with code 4000 ("Authentication failed")
- If key exchange messages arrive out of order → close WebSocket with code 4001 ("Key exchange failed")
- If decryption fails (bad auth tag — including PSK mismatch / MITM) → close WebSocket with code 4002 ("Decryption failed") — do NOT retry or fall back to plaintext
- If sequence number validation fails (replay, reorder, or gap) → close WebSocket with code 4003 ("Sequence violation")
- All encryption errors are logged on both sides but **never include plaintext content in logs**

##### Session Key Lifecycle

1. **Created**: On WebSocket connect, after token auth succeeds
2. **Active**: For the duration of the WebSocket connection
3. **Destroyed**: On WebSocket close — both sides zero out the key material from memory

> **Note**: Session key rotation (rekey) is deferred to v2. See [Deferred: Rekey Protocol](#deferred-rekey-protocol-v2).

##### Deferred: Rekey Protocol (v2)

Session key rotation was originally a should-have for v1 but is deferred because the protocol details are non-trivial:
- Who initiates the rekey? (Daemon? Extension? Either?)
- What happens to in-flight messages encrypted with the old key during the transition?
- Is there a window where both old and new keys are valid? (Necessary for in-flight messages, but opens a replay window)
- Does rekey require a new ECDH exchange or just HKDF with a new salt?

For v1, session key lifetime equals connection lifetime. If a session exceeds 1 hour, the user can reconnect to get fresh keys. This is acceptable for the cowork use case (interactive sessions, not long-running automation).

### MV3 Service Worker Keepalive Strategy

Chrome suspends MV3 service workers after **30 seconds** of inactivity. A WebSocket connection alone is NOT considered activity by Chrome. Without a keepalive strategy, the service worker dies and the WebSocket drops.

**Strategy (layered — use all three):**

1. **Offscreen document** (primary): Create an offscreen document with reason `"WORKERS"`. The offscreen document runs a `setInterval` that posts a message to the service worker every 25 seconds. This is the most reliable keepalive — offscreen documents are not subject to the 30-second suspension.

2. **`chrome.alarms`** (backup): Set a recurring alarm with `periodInMinutes: 0.5` (30 seconds — minimum allowed is actually ~1 minute in practice, Chrome may throttle). This catches the case where the offscreen document is killed.

3. **WebSocket incoming messages** (natural): Every incoming WebSocket message resets the service worker's suspension timer. During active CDP sessions, traffic alone may keep the worker alive. This is not sufficient on its own (idle periods between commands), but helps.

**Offscreen document lifecycle:**
- Created when WebSocket connects, destroyed when WebSocket disconnects
- Uses `chrome.offscreen.createDocument({ url: 'keepalive.html', reasons: ['WORKERS'], justification: 'Keeping service worker alive for active WebSocket session' })`
- `keepalive.html` contains a minimal script: `setInterval(() => chrome.runtime.sendMessage({ type: 'keepalive' }), 25000)`
- Service worker handles `chrome.runtime.onMessage` for keepalive pings (no-op, but receipt resets suspension timer)

> **Known limitation**: `chrome.alarms` minimum interval may be throttled to 1 minute. The offscreen document is the reliable path. If Chrome restricts offscreen documents in future MV3 updates, this strategy will need revision.

### chrome.debugger API Constraints

**Yellow infobar**: `chrome.debugger.attach()` causes Chrome to display a persistent yellow infobar: _"[Extension name] started debugging this browser"_. This **cannot be suppressed or hidden**. Dave should expect to see this bar whenever a cowork session is active. It disappears when the debugger detaches.

**Single-tab debugging**: `chrome.debugger` attaches to a specific target (tab). To switch tabs:
1. Detach from current tab (`chrome.debugger.detach(currentTarget)`)
2. Attach to new tab (`chrome.debugger.attach(newTarget, '1.3')`)
3. There is a brief gap where no debugger is attached — CDP events from either tab may be lost during the switch

**Detach events**: The extension MUST handle `chrome.debugger.onDetach`:
- User closed the debugged tab → notify daemon, update badge
- User opened DevTools on the debugged tab → DevTools takes over the debugger, extension loses it → notify daemon
- Another extension attached → same as above

### Performance

- Key exchange adds ~5ms latency to connection setup (one round-trip)
- AES-256-GCM encryption/decryption adds <1ms per message on modern hardware
- WebCrypto operations are async but non-blocking in the service worker
- No noticeable impact on CDP command latency

### Compatibility

- Chrome 114+ (WebCrypto X25519 support landed in Chrome 113)
- Node.js 20+ (X25519 support in `node:crypto`)
- Manifest V3 required (Chrome is deprecating MV2)
- Works through Cloudflare Tunnel / any TLS-terminating reverse proxy
- **Verify**: X25519 WebCrypto in service worker context specifically (not just page context — service workers have restricted API surfaces)

## Success Criteria

1. Extension installs in Chrome, shows toolbar icon with connect/disconnect popup
2. WebSocket connects to daemon with token auth, completes PSK-authenticated X25519 key exchange within 100ms
3. All CDP commands and events are encrypted — Wireshark/Cloudflare proxy logs show only opaque base64 blobs
4. Decryption failure terminates the session immediately (no plaintext fallback)
5. MITM key substitution is detected at hello/hello-ack (PSK mismatch causes GCM auth failure)
6. New session = new ephemeral keys (forward secrecy verified by inspecting key material)
7. Tab switching, tab listing, and CDP relay work identically to the unencrypted version (encryption is transparent to the protocol layer)
8. Service worker stays alive via offscreen document keepalive during active session
9. Popup recovers session state after close/reopen via `chrome.storage.session`

## User Stories / Scenarios

### Scenario 1: Dave connects for a cowork session through Cloudflare

- **Given**: Dave has the extension installed with PSK configured, daemon is running behind Cloudflare Tunnel
- **When**: Dave clicks Connect, enters the daemon host and auth token
- **Then**: Extension authenticates with token, performs PSK-authenticated X25519 key exchange, and all subsequent CDP traffic is E2E encrypted. Cloudflare logs show only encrypted blobs. Badge shows "ON" with encryption indicator. Yellow infobar appears in Chrome (expected).

### Scenario 2: Encryption handshake fails (MITM detected)

- **Given**: Extension connects through a proxy that attempts MITM key substitution
- **When**: Key exchange completes but hello message decryption fails (PSK mismatch)
- **Then**: Extension closes the WebSocket with code 4002, shows "Encryption handshake failed — possible MITM. Verify PSK matches daemon." in popup, does NOT fall back to plaintext. Badge clears.

### Scenario 3: Encryption handshake fails (incompatible daemon)

- **Given**: Extension connects to a daemon that doesn't support E2E encryption (older version)
- **When**: Key exchange response is not received within 5 seconds
- **Then**: Extension closes the WebSocket, shows "Encryption handshake failed — daemon may not support E2E" error in popup, does NOT fall back to plaintext. Badge clears.

### Scenario 4: Mid-session decryption failure

- **Given**: Encrypted session is active, CDP commands are flowing
- **When**: A message arrives with an invalid auth tag (tampered or corrupted)
- **Then**: Extension immediately closes the WebSocket with code 4002, clears session keys from memory, shows "Connection lost — decryption error" in popup.

### Scenario 5: Service worker survives idle period

- **Given**: Encrypted cowork session is active, no CDP commands for 2 minutes
- **When**: Offscreen document keepalive pings every 25 seconds
- **Then**: Service worker stays alive, WebSocket remains connected. When Dave resumes interaction, CDP commands flow immediately without reconnection.

### Scenario 6: Debugger detached by user

- **Given**: Cowork session is active, debugger attached to a tab
- **When**: Dave opens Chrome DevTools on the debugged tab
- **Then**: `chrome.debugger.onDetach` fires, extension notifies daemon that debugger was lost, badge updates to show "connected but not debugging". Dave can reattach by switching tabs in the popup.

## Technical Considerations

- **A2A pattern reuse**: The encryption pattern (X25519 + HKDF + AES-256-GCM) is directly borrowed from the A2A agent-comms SDK (`packages/sdk/src/crypto.ts`). Key differences: (1) A2A uses Ed25519 identity keys converted to X25519 for ECDH, while cowork uses ephemeral X25519 keys directly; (2) cowork adds PSK to the HKDF salt for MITM resistance (A2A relies on pre-exchanged identity keys instead).
- **WebCrypto X25519**: Chrome 113+ supports `X25519` as a key exchange algorithm in `crypto.subtle.generateKey()` and `crypto.subtle.deriveBits()`. This is a relatively recent addition — the extension's `manifest.json` should specify `minimum_chrome_version: "114"`.
- **No external dependencies**: Both sides use platform-native crypto only (WebCrypto in Chrome, `node:crypto` in Node.js). Zero NPM dependencies for crypto.
- **Service worker crypto**: All WebCrypto operations are async/Promise-based and compatible with MV3 service workers. Keys are stored in module-scoped variables (not IndexedDB) and lost on service worker termination — which is correct behavior (new connection = new keys).
- **Daemon-side integration**: The cowork-bridge (`daemon/src/extensions/cowork-bridge.ts`) currently handles raw JSON frames. The encryption layer wraps/unwraps at the frame level — `handleFrame` and `sendFrame` gain encrypt/decrypt steps, but the message handling logic above is unchanged.
- **Message ordering**: WebSocket guarantees in-order delivery, so sequence numbers serve as gap/tampering detection, not ordering. Each direction maintains its own independent sequence counter. Validation is strict: `seq === lastSeen + 1`.

## Review Notes

### Bob Review (Devil's Advocate) — 2026-02-24

**Overengineering concern**: E2E encryption is 60% of the spec by volume. However, the threat model (Cloudflare TLS termination) is real and the PSK fix addresses the MITM hole. E2E stays as a must-have, but rekey protocol is deferred to v2 to reduce v1 scope.

**Simpler alternatives considered and rejected**:
- SSH tunnel: Already shipped (`5ee71be`), but fragile — requires Dave to manage tunnel lifecycle, breaks if SSH drops, Chrome 145 ignores `--remote-debugging-address`
- mTLS via Cloudflare: Doesn't protect against Cloudflare itself seeing traffic, only protects transit
- `chrome.debugger` to tunneled localhost:9222: Still requires the tunnel, doesn't solve the core problem

**Key risks identified and addressed**:
1. MV3 service worker 30s suspension → offscreen document keepalive strategy added
2. `chrome.debugger` yellow infobar → documented as expected behavior
3. Token auth was undefined → token format, storage, rotation now specified
4. Sequence counter validation was ambiguous → strict gap-detection rule added
5. Rekey protocol was hand-waved → explicitly deferred to v2 with open questions listed
6. Popup state loss in MV3 → `chrome.storage.session` requirement added
7. `chrome.debugger.onDetach` handling was missing → added as should-have with scenario

**Remaining risks accepted for v1**:
- No auto-reconnect (manual reconnect is acceptable for interactive cowork sessions)
- No channel binding between token auth and ECDH (PSK provides sufficient authentication; channel binding is a v2 hardening)
- WebCrypto X25519 in service worker context is untested (needs verification during implementation)
- Corporate firewall WebSocket blocking (not relevant for Dave's home network)

### R2 Peer Review — 2026-02-24

**BLOCKING**: Unauthenticated ECDH vulnerable to MITM by Cloudflare → **Fixed**: PSK mixed into HKDF salt derivation. PSK configured locally, never transmitted.

**Important**: MV3 service worker 30s suspension → **Fixed**: Offscreen document keepalive strategy added.

**Important**: `chrome.debugger` yellow infobar → **Fixed**: Documented as expected behavior with user-facing note.

**Minor**: Sequence counter validation needs clarity → **Fixed**: Strict `seq === lastSeen + 1` rule with gap detection.

**Minor**: Rekey protocol needs detail → **Fixed**: Explicitly deferred to v2 with open questions captured.

## Documentation Impact

- [ ] `extensions/kkit-chrome-connect/README.md` — document E2E encryption, PSK setup, key exchange protocol, minimum Chrome version, yellow infobar
- [ ] `CLAUDE.md` — no changes needed (cowork skill already documented)
- [ ] `daemon/src/extensions/cowork-bridge.ts` — inline code documentation for encryption layer

## Open Questions

- [x] ~~Should re-keying (session key rotation) be a must-have for v1?~~ → **No, deferred to v2.**
- [ ] Should the extension show the daemon's public key fingerprint in the popup for manual verification (like SSH "trust on first use")? Low priority — PSK already provides authentication.
- [ ] What minimum Chrome version should the manifest enforce? WebCrypto X25519 landed in Chrome 113, but Chrome 114+ is safer for stability.
- [ ] Does X25519 via WebCrypto work in MV3 service worker context? Needs empirical verification.
- [ ] Should the PSK be derivable from a human-readable passphrase (PBKDF2) instead of raw hex? Better UX for Dave but slightly weaker if passphrase is short.
