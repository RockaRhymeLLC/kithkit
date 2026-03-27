/**
 * Daemon Bootstrap — registers the agent extension, then starts the daemon.
 *
 * This is the entry point for the daemon (instead of main.ts directly).
 * It registers the agent extension before the daemon's top-level code runs,
 * ensuring the extension is available when the server starts listening.
 *
 * Usage: node dist/bootstrap.js [projectDir]
 */

import { registerExtension } from './core/extensions.js';
import { agentExtension } from './extensions/index.js';

// Register agent extension before daemon starts
registerExtension(agentExtension);

// Import main.ts — this triggers the daemon bootstrap
// (config load, DB open, server start, extension init hook)
await import('./main.js');
