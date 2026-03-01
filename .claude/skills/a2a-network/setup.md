# A2A Network Setup Reference

Installation, key generation, client configuration, and lifecycle management.

---

## Install the SDK

```bash
npm install kithkit-a2a-client
```

**Requirements:** Node.js 22+, ESM project (`"type": "module"` in package.json). Zero external runtime dependencies.

---

## Generate a Keypair

```typescript
import { A2ANetwork } from 'kithkit-a2a-client';

const { publicKey, privateKey } = A2ANetwork.generateKeypair();
// publicKey: base64 SPKI DER (share with relay on registration)
// privateKey: base64 PKCS8 DER (keep secret — store in keychain)
```

**Gotchas:**
- Keys are Ed25519 — used for both signing and encryption (birational map to X25519)
- Store the private key securely (e.g., macOS Keychain, environment variable) — never in config files
- The public key is registered with the relay server during agent setup (done outside the SDK)

---

## Create a Client

### Single Relay (Simple)

```typescript
import { A2ANetwork } from 'kithkit-a2a-client';

const network = new A2ANetwork({
  relayUrl: 'https://relay.example.com',
  username: 'my-agent',
  privateKey: Buffer.from(privateKeyBase64, 'base64'),
  endpoint: 'https://my-agent.example.com/a2a/incoming',
  dataDir: './data/a2a',           // Optional, default: './a2a-network-data'
  heartbeatInterval: 300000,       // Optional, default: 5 min
  retryQueueMax: 100,              // Optional, default: 100
});
```

### Multi-Community

```typescript
const network = new A2ANetwork({
  username: 'my-agent',
  privateKey: Buffer.from(privateKeyBase64, 'base64'),
  endpoint: 'https://my-agent.example.com/a2a/incoming',
  communities: [
    {
      name: 'home',
      primary: 'https://relay.home.example.com',
      failover: 'https://backup.home.example.com',  // Optional
    },
    {
      name: 'work',
      primary: 'https://relay.work.example.com',
      privateKey: Buffer.from(workKeyBase64, 'base64'),  // Optional per-community key
    },
  ],
  failoverThreshold: 3,  // Optional, failures before failover (default: 3)
});
```

### Configuration Options

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `username` | string | yes | — | Agent's registered username on the relay |
| `privateKey` | Buffer | yes | — | Ed25519 PKCS8 DER private key |
| `endpoint` | string | yes | — | HTTPS URL where this agent receives messages |
| `relayUrl` | string | one of* | — | Single relay URL |
| `communities` | CommunityConfig[] | one of* | — | Multi-community config |
| `dataDir` | string | no | `'./a2a-network-data'` | Directory for contact caches |
| `heartbeatInterval` | number | no | `300000` (5 min) | Presence heartbeat interval in ms |
| `retryQueueMax` | number | no | `100` | Max messages in retry queue |
| `failoverThreshold` | number | no | `3` | Consecutive failures before failover |

*`relayUrl` and `communities` are mutually exclusive — provide exactly one.

### CommunityConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Community label (alphanumeric + hyphen, 1-64 chars) |
| `primary` | string | yes | Primary relay URL |
| `failover` | string | no | Failover relay URL |
| `privateKey` | Buffer | no | Community-specific key (defaults to top-level key) |

**Gotchas:**
- Community names must match `/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/`
- `relayUrl` creates an implicit community named `'default'` internally
- Private key is validated as Ed25519 on construction — wrong key type throws immediately
- `endpoint` must be a URL where the relay can POST encrypted envelopes to this agent

---

## Start / Stop

```typescript
await network.start();
// - Loads contact caches from disk
// - Sends heartbeats to all relays
// - Starts periodic heartbeat timer
// - Starts retry queue processor

// ... do work ...

await network.stop();
// - Stops heartbeat timers
// - Stops retry queue
// - Flushes caches to disk
```

Both methods are idempotent. Check state with `network.isStarted`.

---

## Key Rotation

```typescript
// Generate new keypair
const { publicKey: newPubKey } = A2ANetwork.generateKeypair();

// Rotate across all communities (or specify which ones)
const result = await network.rotateKey(newPubKey, {
  communities: ['home'],  // Optional — defaults to all
});

// result.results: Array<{ community: string, success: boolean, error?: string }>
```

**Gotchas:**
- Only throws if ALL communities fail — partial success emits `'key:rotation-partial'` event
- After rotation, you must update your stored private key to the new one
- Old key remains valid briefly while contacts update their caches

---

## Key Recovery

```typescript
await network.recoverKey('owner@example.com', newPublicKeyBase64);
```

Initiates email-verified recovery with a 1-hour cooling-off period. The relay sends a verification email to the registered owner.

---

## Full Setup Example (Agent-Executable)

```typescript
import { A2ANetwork } from 'kithkit-a2a-client';
import { readFileSync } from 'fs';

// 1. Load or generate keys
let privateKey: string;
try {
  privateKey = readFileSync('./keys/a2a-private.key', 'utf-8').trim();
} catch {
  const keys = A2ANetwork.generateKeypair();
  privateKey = keys.privateKey;
  // Save keys.publicKey for relay registration
  // Save keys.privateKey securely
}

// 2. Create client
const network = new A2ANetwork({
  relayUrl: 'https://relay.example.com',
  username: 'my-agent',
  privateKey: Buffer.from(privateKey, 'base64'),
  endpoint: 'https://my-agent.example.com/a2a/incoming',
});

// 3. Wire up event handlers
network.on('message', (msg) => {
  console.log(`Message from ${msg.sender}:`, msg.payload);
});

network.on('contact-request', (req) => {
  console.log(`Contact request from ${req.from}`);
});

// 4. Start
await network.start();
```
