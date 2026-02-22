# Writing Kithkit Extensions

Extensions let agent repos add custom HTTP routes, scheduler tasks, and health checks to the daemon — without modifying the framework. The extension system uses three lifecycle hooks and two registration APIs.

## Overview

An extension is a single TypeScript module that exports an object implementing the `Extension` interface. Kithkit supports **one extension per daemon instance**; that extension aggregates all sub-modules internally.

Extensions are registered in your project's daemon entry point (`daemon/src/main.ts` or equivalent), before the daemon starts listening.

## The Extension Interface

```typescript
// From kithkit/daemon/core/extensions.ts
export interface Extension {
  /** Human-readable name for logging. */
  name: string;

  /** Called after the server starts listening. Register routes, tasks, adapters here. */
  onInit?(config: KithkitConfig, server: http.Server): Promise<void>;

  /**
   * Called for each incoming HTTP request, before the 404 fallback.
   * Return true if you handled the request, false to pass to the next handler.
   */
  onRoute?(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    searchParams: URLSearchParams,
  ): Promise<boolean>;

  /** Called during graceful shutdown, before server.close(). */
  onShutdown?(): Promise<void>;
}
```

All three methods are optional. Implement only the ones you need.

## Minimal Example

```typescript
// extensions/my-agent/index.ts
import type { Extension } from 'kithkit/daemon';

export default {
  name: 'my-agent',

  async onInit(config, server) {
    console.log(`[my-agent] Initialized for agent: ${config.agent.name}`);
  },
} satisfies Extension;
```

## Registering Custom Routes

Use `registerRoute(pattern, handler)` from `kithkit/daemon/core/route-registry` to add HTTP endpoints. Routes are checked in registration order; the first match wins.

**Pattern types:**
- Exact path: `'/my-ext/status'` — matches only that path
- Prefix wildcard: `'/my-ext/*'` — matches `/my-ext/` and all sub-paths

**Handler signature:**

```typescript
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
) => Promise<boolean>; // return true if handled
```

**Example — status endpoint:**

```typescript
import { registerRoute } from 'kithkit/daemon/core/route-registry';

registerRoute('/my-ext/status', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  return true; // handled
});
```

**Example — prefix route with method dispatch:**

```typescript
registerRoute('/my-ext/*', async (req, res, pathname) => {
  const method = req.method ?? 'GET';

  if (pathname === '/my-ext/items' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [], timestamp: new Date().toISOString() }));
    return true;
  }

  if (pathname === '/my-ext/items' && method === 'POST') {
    // Parse body, create item...
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 1, timestamp: new Date().toISOString() }));
    return true;
  }

  return false; // not handled — fall through to 404
});
```

**Note:** Each pattern must be unique. Registering the same pattern twice throws an error.

## Registering Scheduler Tasks

Custom tasks must exist in `kithkit.config.yaml` before you can register a handler for them. The scheduler reads task definitions from config; `registerHandler` associates an in-process function with a named task.

**Step 1 — Add the task to config:**

```yaml
# kithkit.config.yaml
scheduler:
  tasks:
    - name: my-custom-task
      interval: "1h"
      enabled: true
      config:
        requires_session: false
```

**Step 2 — Register a handler in your extension's `onInit`:**

```typescript
import type { Scheduler, TaskHandler } from '../../automation/scheduler.js';

const myTaskHandler: TaskHandler = async ({ taskName, config }) => {
  console.log(`[${taskName}] Running with config:`, config);
  // Your task logic here — fetch data, update DB, send notifications, etc.
};

// In your extension's register function:
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('my-custom-task', myTaskHandler);
}
```

Call your `register(scheduler)` function from within the extension's `onInit` hook. The scheduler instance is available via the daemon's module-level export. See `daemon/src/automation/tasks/` for examples of built-in task handlers.

**`TaskHandlerContext` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `taskName` | `string` | The task's name from config |
| `config` | `Record<string, unknown>` | The task's `config` block from YAML |

Tasks with `requires_session: true` are skipped when no tmux session exists. Tasks with `idle_only: true` are skipped when the agent is actively in conversation (last human activity within `idle_after_ms`, default 5 minutes).

**Manual trigger** (for testing):

```bash
curl -X POST http://localhost:3847/api/tasks/my-custom-task/run
```

## Registering Health Checks

Extensions can add custom health checks that appear in `GET /status/extended`.

```typescript
import { registerCheck } from 'kithkit/daemon/core/extended-status';

registerCheck('my-service', async () => {
  try {
    // Check your service...
    const ok = await pingMyService();
    return { ok, message: ok ? 'Service reachable' : 'Service unreachable' };
  } catch (err) {
    return { ok: false, message: `Check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
});
```

The return type is `CheckResult`:

```typescript
interface CheckResult {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
}
```

All checks run when `GET /status/extended` is called. If any check returns `ok: false`, the overall status becomes `"degraded"`.

## Full Extension Example

```typescript
// extensions/my-agent/index.ts
import http from 'node:http';
import type { Extension, KithkitConfig } from 'kithkit/daemon';
import { registerRoute } from 'kithkit/daemon/core/route-registry';
import { registerCheck } from 'kithkit/daemon/core/extended-status';

// Internal state
let _initialized = false;
let _config: KithkitConfig | null = null;

export default {
  name: 'my-agent',

  async onInit(config: KithkitConfig, server: http.Server): Promise<void> {
    _config = config;
    _initialized = true;

    console.log(`[my-agent] Initializing for: ${config.agent.name}`);

    // Register custom routes
    registerRoute('/my-agent/status', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        agent: config.agent.name,
        timestamp: new Date().toISOString(),
      }));
      return true;
    });

    registerRoute('/my-agent/webhook/*', async (req, res, pathname) => {
      const event = pathname.slice('/my-agent/webhook/'.length);
      // Handle webhook events...
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: event, timestamp: new Date().toISOString() }));
      return true;
    });

    // Register health checks
    registerCheck('my-agent-init', async () => ({
      ok: _initialized,
      message: _initialized ? 'Extension initialized' : 'Extension not initialized',
    }));

    console.log('[my-agent] Ready');
  },

  async onRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    searchParams: URLSearchParams,
  ): Promise<boolean> {
    // onRoute is called for every request before the 404 fallback.
    // If you used registerRoute() in onInit, you can skip this method —
    // the route registry is checked automatically.
    // Only implement onRoute if you need dynamic dispatch logic.
    return false; // not handled
  },

  async onShutdown(): Promise<void> {
    console.log('[my-agent] Shutting down');
    // Close connections, flush buffers, etc.
    _initialized = false;
  },
} satisfies Extension;
```

## Extending Config Types

If your extension reads custom config keys, use TypeScript module augmentation to get type safety:

```typescript
// extensions/my-agent/config-ext.ts

// Augment the KithkitConfig interface to include your extension's config
declare module 'kithkit/daemon/core/config' {
  interface KithkitConfig {
    my_agent?: {
      api_url: string;
      timeout_ms?: number;
    };
  }
}
```

Then in your extension:

```typescript
import type { KithkitConfig } from 'kithkit/daemon';
import './config-ext.js'; // import to apply augmentation

async onInit(config: KithkitConfig) {
  const apiUrl = config.my_agent?.api_url ?? 'https://api.example.com';
  const timeout = config.my_agent?.timeout_ms ?? 5000;
  // ...
}
```

And in `kithkit.config.yaml`:

```yaml
my_agent:
  api_url: "https://api.example.com"
  timeout_ms: 3000
```

## Registering the Extension

In your project's daemon entry point, register before the daemon starts listening:

```typescript
// my-project/daemon/main.ts
import { registerExtension } from 'kithkit/daemon';
import myExtension from '../extensions/my-agent/index.js';

registerExtension(myExtension);

// Start the daemon (framework handles the rest)
import 'kithkit/daemon/main.js';
```

**Important**: Only one extension can be registered per daemon instance. If you have multiple sub-modules, aggregate them in a single extension object:

```typescript
// extensions/index.ts
import type { Extension } from 'kithkit/daemon';
import { initEmailModule } from './email.js';
import { initCalendarModule } from './calendar.js';
import { initWebhookModule } from './webhook.js';

export default {
  name: 'my-agent',

  async onInit(config, server) {
    await initEmailModule(config);
    await initCalendarModule(config);
    await initWebhookModule(config, server);
  },

  async onShutdown() {
    // Each module cleans up its own resources
  },
} satisfies Extension;
```

## Degraded Mode

If `onInit` throws an error, the daemon continues running in **degraded mode** — the extension is disabled, but the core daemon API remains available. This allows the daemon to start even if an extension dependency is unavailable.

Check degraded state:

```bash
curl http://localhost:3847/status/extended
# { "status": "degraded", "checks": { ... } }
```

Or via the health script:

```bash
./scripts/health.sh
```

## Testing Extensions

Test your extension against a running daemon using the smoke test script:

```bash
./scripts/daemon-smoke-test.sh
```

For unit testing, the extension system provides reset helpers:

```typescript
import {
  registerExtension,
  _resetExtensionForTesting,
} from 'kithkit/daemon/core/extensions';
import {
  _resetRoutesForTesting,
} from 'kithkit/daemon/core/route-registry';
import {
  _resetForTesting as _resetExtendedStatus,
} from 'kithkit/daemon/core/extended-status';

beforeEach(() => {
  _resetExtensionForTesting();
  _resetRoutesForTesting();
  _resetExtendedStatus();
});

test('my extension registers routes', async () => {
  registerExtension(myExtension);
  await myExtension.onInit(mockConfig, mockServer);
  // assert routes, checks, etc.
});
```

## Reference

- [API Reference](api-reference.md) — all daemon HTTP endpoints your extension can call
- [Architecture](architecture.md) — how extensions fit into the three-tier system
- `daemon/src/core/extensions.ts` — `Extension` interface source
- `daemon/src/core/route-registry.ts` — `registerRoute` source
- `daemon/src/core/extended-status.ts` — `registerCheck` source
- `daemon/src/automation/scheduler.ts` — `registerHandler` and `TaskHandler` source
