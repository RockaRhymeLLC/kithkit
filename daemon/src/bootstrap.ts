/**
 * Daemon Bootstrap — registers the agent extension, then starts the daemon.
 *
 * This is the entry point for the daemon (instead of main.ts directly).
 * It registers the agent extension before the daemon's top-level code runs,
 * ensuring the extension is available when the server starts listening.
 *
 * IMPORTANT: loadConfig() must be called with the correct projectDir BEFORE
 * importing extensions, because many modules have top-level loadConfig() calls
 * that execute at import time. The first call wins (caching), so we prime the
 * cache here to avoid cwd-based misses when started from a subdirectory.
 *
 * Usage: node dist/bootstrap.js [projectDir]
 */

import path from 'node:path';
import { loadConfig } from './core/config.js';

// Prime config cache with correct projectDir BEFORE extension imports.
// Extensions have module-level loadConfig() calls that run at import time —
// without this, they'd use process.cwd() which may be daemon/ (wrong).
const projectDir = path.resolve(process.argv[2] ?? process.cwd());
loadConfig(projectDir);

const { registerExtension } = await import('./core/extensions.js');
const { agentExtension } = await import('./extensions/index.js');

// Register the single agent extension (aggregates all sub-extensions including m365)
registerExtension(agentExtension);

// Import main.ts — this triggers the daemon bootstrap
// (config load, DB open, server start, extension init hook)
await import('./main.js');
