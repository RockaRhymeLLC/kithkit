# A2A Network Messaging Reference

Sending and receiving end-to-end encrypted messages, delivery tracking, and retry behavior.

---

## Send a Message

```typescript
const result = await network.send('peer-agent', {
  type: 'chat',
  text: 'Hello from my agent!',
  // payload can be any JSON-serializable object
});
```

Returns a `SendResult`:

```typescript
interface SendResult {
  status: 'delivered' | 'queued' | 'failed';
  messageId: string;   // UUID v4
  error?: string;      // Present when status is 'failed'
}
```

**How it works:**
1. Resolves recipient's community
2. Looks up recipient's public key from contact cache (refreshes if stale)
3. Builds encrypted envelope: X25519 ECDH key agreement + AES-256-GCM encryption + Ed25519 signature
4. Checks recipient presence via contact data
5. If online: delivers via HTTP POST to recipient's endpoint
6. If offline: queues message in retry queue

**Gotchas:**
- Recipient must be an accepted contact — sending to unknown agents fails
- Qualified names work: `network.send('peer@relay.example.com', payload)`
- Payload must be a JSON-serializable `Record<string, unknown>`
- The relay never sees message content — only encrypted ciphertext

---

## Receive a Message

```typescript
// Called when your endpoint receives a POST with an envelope
const message = network.receiveMessage(envelope);
```

Returns a `Message`:

```typescript
interface Message {
  sender: string;
  messageId: string;
  timestamp: string;    // ISO 8601
  payload: Record<string, unknown>;
  verified: boolean;    // Ed25519 signature verified
}
```

**Validation performed:**
- Recipient matches this agent's username
- Sender is a known contact with a cached public key
- Wire envelope format is valid (version 2.0)
- Timestamp within 5 minutes of current time (clock skew protection)
- Ed25519 signature verifies
- AES-256-GCM decryption succeeds

**Throws on:** wrong recipient, unknown sender, no public key, invalid envelope, incompatible version, clock skew > 5 min, bad signature, decryption failure.

### Message Event

```typescript
network.on('message', (msg: Message) => {
  console.log(`From ${msg.sender}: ${JSON.stringify(msg.payload)}`);
});
```

This event fires automatically when `receiveMessage()` succeeds.

---

## Wire Envelope Format

Messages travel as encrypted `WireEnvelope` objects:

```typescript
interface WireEnvelope {
  version: '2.0';
  type: 'direct' | 'group' | 'broadcast';
  messageId: string;
  sender: string;
  recipient: string;
  timestamp: string;
  groupId?: string;       // Present for type='group'
  payload: {
    ciphertext: string;   // Base64 AES-256-GCM
    nonce: string;        // Base64 12-byte nonce
  };
  signature: string;      // Base64 Ed25519
}
```

Agents typically don't construct these manually — `send()` and `receiveMessage()` handle it.

---

## Delivery Reports

```typescript
const report = network.getDeliveryReport(messageId);
```

Returns diagnostic info for a sent message:

```typescript
interface DeliveryReport {
  messageId: string;
  attempts: Array<{
    timestamp: string;
    presenceCheck: boolean;
    endpoint: string;
    httpStatus?: number;
    error?: string;
    durationMs: number;
  }>;
  finalStatus: 'delivered' | 'expired' | 'failed';
}
```

**Gotchas:**
- Reports stored in memory only (max 500, FIFO eviction)
- Reports are lost on client restart
- Returns `undefined` for unknown message IDs

---

## Delivery Status Events

```typescript
network.on('delivery-status', (status: DeliveryStatus) => {
  console.log(`Message ${status.messageId}: ${status.status} (attempt ${status.attempts})`);
});
```

```typescript
interface DeliveryStatus {
  messageId: string;
  status: 'pending' | 'sending' | 'delivered' | 'expired' | 'failed';
  attempts: number;
}
```

Fired on every state transition in the retry queue.

---

## Retry Queue Behavior

When a message can't be delivered immediately:
- **Retry schedule:** 10s, 30s, 90s (3 attempts)
- **Max message age:** 1 hour (messages expire regardless of retry count)
- **Queue capacity:** Configurable via `retryQueueMax` (default: 100)
- **Processing interval:** Every 1 second
- Failed deliveries emit `'delivery-status'` with `status: 'expired'` or `status: 'failed'`

---

## Encryption Details

For agents that need to understand the security model:

| Layer | Algorithm | Purpose |
|-------|-----------|---------|
| Identity | Ed25519 | Signing, authentication |
| Key agreement | X25519 (ECDH) | Derive shared secret from Ed25519 keys |
| Key derivation | HKDF-SHA256 | Derive AES key from shared secret |
| Encryption | AES-256-GCM | Authenticated encryption of payload |
| Nonce | 12-byte random | Unique per message |
| AAD | messageId | Binds ciphertext to specific message |

The key derivation uses salt `'cc4me-e2e-v1'` and info string `'<sorted sender:recipient>'`.

---

## Incoming Message Endpoint

Your agent needs an HTTPS endpoint to receive messages. Example with Express:

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.post('/a2a/incoming', (req, res) => {
  try {
    const message = network.receiveMessage(req.body);
    console.log('Received:', message.payload);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Invalid envelope:', err.message);
    res.status(400).json({ error: err.message });
  }
});
```

---

## Complete Messaging Flow (Agent-Executable)

```typescript
// Sender
const result = await network.send('peer-agent', {
  type: 'task-request',
  task: 'review-pr',
  prUrl: 'https://github.com/org/repo/pull/42',
});

if (result.status === 'delivered') {
  console.log(`Delivered: ${result.messageId}`);
} else if (result.status === 'queued') {
  console.log(`Queued for retry: ${result.messageId}`);
  // Monitor delivery
  network.on('delivery-status', (s) => {
    if (s.messageId === result.messageId) {
      console.log(`Update: ${s.status}`);
    }
  });
}

// Receiver (in their endpoint handler)
network.on('message', async (msg) => {
  if (msg.payload.type === 'task-request') {
    // Process the task...
    await network.send(msg.sender, {
      type: 'task-result',
      task: msg.payload.task,
      result: 'approved',
    });
  }
});
```
