/**
 * R2D2 Daemon Bootstrap — registers the R2 extension, then starts the daemon.
 *
 * This is the entry point for the R2 daemon (instead of main.ts directly).
 * It registers the R2 extension before the daemon's top-level code runs,
 * ensuring the extension is available when the server starts listening.
 *
 * Usage: node dist/bootstrap.js [projectDir]
 */

import { registerExtension } from './core/extensions.js';
import { r2Extension } from './extensions/index.js';

// Register R2 extension before daemon starts
registerExtension(r2Extension);

// Import main.ts — this triggers the daemon bootstrap
// (config load, DB open, server start, extension init hook)
await import('./main.js');
