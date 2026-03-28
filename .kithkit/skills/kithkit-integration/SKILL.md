# Kithkit Integration

Build integrations on the Kithkit agent framework. This skill covers the extension system, daemon API, scheduler, channel router, and memory system — everything needed to add new capabilities to a Kithkit-managed agent.

## Architecture

Kithkit uses a three-tier architecture:

```
Human <-> Comms Agent <-> Daemon <-> Workers
              |            |
          Identity      SQLite DB
```

- **Comms agent** — persistent Claude Code session, human-facing interface
- **Daemon** — Node.js server on localhost:3847, manages all state
- **Workers** — ephemeral Claude Code agents spawned for specific tasks

All persistent state (todos, calendar, memories, messages, config) lives in SQLite via the daemon API. Extensions add custom routes, scheduler tasks, and health checks without modifying the framework.

## Writing Extensions

An extension is a TypeScript module implementing the `Extension` interface:

```typescript
import type { Extension } from 'kithkit/daemon';

export default {
  name: 'my-extension',

  async onInit(config, server) {
    // Register routes, tasks, adapters
  },

  async onRoute(req, res, pathname, searchParams) {
    // Handle custom HTTP endpoints (optional)
    return false;
  },

  async onShutdown() {
    // Clean up resources
  },
} satisfies Extension;
```

Register in your daemon entry point before starting:

```typescript
import { registerExtension } from 'kithkit/daemon';
import myExtension from '../extensions/my-extension/index.js';
registerExtension(myExtension);
import 'kithkit/daemon/main.js';
```

Only one extension per daemon instance. Aggregate sub-modules internally.

### Custom Routes

```typescript
import { registerRoute } from 'kithkit/daemon/core/route-registry';

registerRoute('/my-ext/status', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
  return true;
});
```

Pattern types: exact path (`'/my-ext/status'`) or prefix wildcard (`'/my-ext/*'`).

### Scheduler Tasks

Step 1 — Add to `kithkit.config.yaml`:

```yaml
scheduler:
  tasks:
    - name: my-task
      interval: "1h"
      enabled: true
      config:
        requires_session: false
```

Step 2 — Register handler in `onInit`:

```typescript
const handler: TaskHandler = async ({ taskName, config }) => {
  // Task logic
};
scheduler.registerHandler('my-task', handler);
```

Task flags: `requires_session: true` (skip when no tmux session), `idle_only: true` (skip when agent is active).

Manual trigger: `curl -X POST http://localhost:3847/api/tasks/my-task/run`

### Health Checks

```typescript
import { registerCheck } from 'kithkit/daemon/core/extended-status';

registerCheck('my-service', async () => ({
  ok: true,
  message: 'Service reachable',
}));
```

Checks run on `GET /health/extended`. Any `ok: false` sets overall status to `"degraded"`.

### Config Type Augmentation

```typescript
declare module 'kithkit/daemon/core/config' {
  interface KithkitConfig {
    my_extension?: { api_url: string; timeout_ms?: number };
  }
}
```

### Degraded Mode

If `onInit` throws, the daemon continues with the extension disabled. Core API remains available.

## Daemon API Quick Reference

All endpoints are on `localhost:3847`. JSON responses include `timestamp` (ISO 8601).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/health/extended` | GET | All health checks + operational status |
| `/status` | GET | Quick status |
| `/api/agents/spawn` | POST | Spawn worker (`{profile, prompt}`) |
| `/api/agents` | GET | List agents |
| `/api/agents/:id/status` | GET | Agent/job status with token usage |
| `/api/agents/:id` | DELETE | Kill worker |
| `/api/todos` | GET/POST | List/create todos |
| `/api/todos/:id` | GET/PUT/DELETE | CRUD a todo |
| `/api/calendar` | GET/POST | List/create events |
| `/api/calendar/:id` | GET/PUT/DELETE | CRUD an event |
| `/api/messages` | GET/POST | Message history / send inter-agent message |
| `/api/send` | POST | Deliver via channel router (`{message, channels}`) |
| `/api/memory/store` | POST | Store memory (`{content, type, tags}`) |
| `/api/memory/search` | POST | Search (`{query, mode, tags}`) |
| `/api/config/:key` | GET/PUT | Config KV store |
| `/api/config/reload` | POST | Hot-reload config from disk |
| `/api/tasks` | GET | List scheduler tasks |
| `/api/tasks/:name/run` | POST | Manual trigger |
| `/api/usage` | GET | Token/cost stats |

See `reference.md` for full request/response details.

## Channel Router

Deliver messages to users through configured channels:

```bash
curl -X POST http://localhost:3847/api/send \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "channels": ["telegram"]}'
```

Omit `channels` to send to all active channels. Channel adapters are registered by extensions.

## Memory System

Three search modes — keyword (AND matching), vector (semantic similarity via embeddings), and hybrid:

```bash
# Store
curl -X POST http://localhost:3847/api/memory/store \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "type": "fact", "tags": ["preferences"]}'

# Search
curl -X POST http://localhost:3847/api/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query": "user preferences", "mode": "keyword"}'
```

Types: `fact`, `episodic`, `procedural`. Vector search requires sqlite-vec and ONNX embeddings.

## Recipes

This skill includes integration recipes as reference files in the `recipes/` directory:

| Recipe | File | What it covers |
|--------|------|---------------|
| Telegram Bot | `recipes/telegram.md` | Bot setup, webhook/polling, sender classification, media |
| Microsoft Graph Email | `recipes/graph-email.md` | Azure AD app, client credentials OAuth, full mailbox access |
| Outlook IMAP | `recipes/outlook-imap.md` | Separate Azure app, device code flow, Python IMAP adapter |
| Himalaya CLI Email | `recipes/himalaya-email.md` | CLI email client, Gmail/IMAP, multi-account |
| JMAP Email (Fastmail) | `recipes/jmap-email.md` | RFC 8620 JMAP protocol, batched method calls |
| Email Triage Task | `recipes/email-check-task.md` | Scheduled triage, pattern matching, sub-agent classification |
| Voice Overview | `recipes/voice-integration.md` | Architecture, setup checklist, component order |
| Voice Client | `recipes/voice-client.md` | macOS menu bar app, audio capture, wake word, playback |
| Voice STT | `recipes/voice-stt.md` | Whisper-cpp, on-device transcription |
| Voice TTS | `recipes/voice-tts.md` | Kokoro-ONNX, Python microservice, daemon lifecycle |
| Browserbase | `recipes/browserbase.md` | Cloud browser automation, sidecar, hand-off |
| GitHub Rate Limiting | `recipes/github-rate-limiting.md` | Claude Code hooks, write rate limits, ledger |

Each recipe includes prerequisites, setup steps, config snippets, reference code, and troubleshooting.
