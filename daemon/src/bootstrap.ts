/**
 * BMO Daemon Bootstrap — registers the BMO extension, then starts the daemon.
 *
 * This is the entry point for the BMO daemon (instead of main.ts directly).
 * It registers the BMO extension before the daemon's top-level code runs,
 * ensuring the extension is available when the server starts listening.
 *
 * Usage: node dist/bootstrap.js [projectDir]
 */

import { registerExtension } from './core/extensions.js';
import { bmoExtension } from './extensions/index.js';

// Register BMO extension before daemon starts
registerExtension(bmoExtension);

// Import main.ts — this triggers the daemon bootstrap
// (config load, DB open, server start, extension init hook)
await import('./main.js');
