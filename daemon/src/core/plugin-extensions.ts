/**
 * Plugin Extensions — hot-loadable extension modules, no daemon restart.
 *
 * The main extension (extensions/index.ts) is compiled into the daemon's ESM
 * module graph: its static imports are cached by Node and cannot be reloaded
 * in-process. Plugins are the hot path: self-contained `.js` files in a
 * watched directory (default `.kithkit/extensions/`) that the daemon can
 * load, reload, and unload at runtime — the same proven pattern JobsWatcher
 * uses for scheduled jobs, generalized to full extension capabilities.
 *
 * Plugin contract (default export):
 *
 *   export default {
 *     name: 'my-plugin',                          // required, unique
 *     routes: {                                   // optional HTTP routes
 *       // Patterns MUST start with /api/ext/ — keeps plugins out of
 *       // framework route space. Handler returns true if it handled.
 *       '/api/ext/my-plugin/hello': async (req, res) => {
 *         res.writeHead(200, {'Content-Type': 'application/json'});
 *         res.end(JSON.stringify({ ok: true }));
 *         return true;
 *       },
 *     },
 *     tasks: [{                                   // optional scheduler tasks
 *       name: 'my-plugin-tick',
 *       schedule: { type: 'interval', ms: 60_000 },   // or {type:'cron', expression}
 *       run: async (ctx) => { ... },
 *     }],
 *     async onInit(ctx)  { ... },                 // optional; ctx below
 *     async onShutdown() { ... },                 // optional; called on reload/unload
 *   };
 *
 * onInit context: { config, projectDir, log, db: { query, exec } } — framework
 * services handed in so a plugin file needs no imports from the daemon tree.
 *
 * TRUST MODEL (explicit): plugins are OPERATOR-TRUSTED local files behind an
 * authenticated management gate. An in-process JS module has full daemon
 * capability by construction (fs, child_process, network, DB, keychain) —
 * in-process code CANNOT be sandboxed. The protections here are therefore
 * load-authorization and hygiene, NOT capability restriction:
 *   - the manager only loads files from its one configured directory; no API
 *     accepts file paths or content
 *   - mutating /api/extensions endpoints require a comms/daemon-role token
 *     (api/extensions.ts) — localhost reachability alone cannot trigger a load
 *   - the /api/ext/ route namespace + error containment below are robustness
 *     hygiene, not a security boundary
 * Do not load plugin files you would not run as the daemon user.
 *
 * Guarantees:
 *   - A broken plugin never crashes the daemon (load error → status 'error').
 *   - Loads are transactional: if route/task registration or onInit fails,
 *     everything already registered for that plugin is rolled back.
 *   - Reload is cache-busted (mtime + monotonic counter), so edits to the
 *     file always take effect.
 *   - Old module instances stay in Node's module cache (unavoidable with ESM)
 *     — a small, bounded leak per reload, acceptable for interactive use.
 *
 * Caveats (documented, by design):
 *   - A plugin's own static imports of OTHER files are cached by Node and do
 *     NOT reload — keep a plugin self-contained in one file, or have it
 *     dynamically import its helpers with its own cache-busting.
 *   - Teardown of plugin-created timers/listeners is the plugin's onShutdown
 *     contract — the manager unregisters routes/tasks it registered, but it
 *     cannot reach into a module to cancel intervals the plugin started.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createLogger } from './logger.js';

type Logger = ReturnType<typeof createLogger>;
import { registerRoute, unregisterRoute, type RouteHandler } from './route-registry.js';
import { registerCheck, unregisterCheck, type HealthCheckFn } from './extended-status.js';
import { registerAdapter, unregisterAdapter } from '../comms/channel-router.js';
import type { ChannelAdapter } from '../comms/adapter.js';
import { query, exec } from './db.js';
import { getProjectDir, type KithkitConfig } from './config.js';
import type { Scheduler } from '../automation/scheduler.js';

const log = createLogger('plugin-extensions');

// ── Types ───────────────────────────────────────────────────

export interface PluginTask {
  name: string;
  schedule: { type: 'cron'; expression: string } | { type: 'interval'; ms: number };
  run: (ctx: { taskName: string; config: Record<string, unknown> }) => Promise<void> | void;
}

export interface PluginContext {
  config: KithkitConfig;
  projectDir: string;
  log: Logger;
  db: { query: typeof query; exec: typeof exec };
  /** The live scheduler, or null before the main extension wires it. */
  scheduler: Scheduler | null;
  /**
   * Cache-busted dynamic import of a compiled daemon module, by path relative
   * to the daemon dist root (e.g. 'extensions/granola/index.js'). This is the
   * decomposition unlock: a plugin that wires a compiled component through
   * ctx.import() gets FRESH component code on plugin reload after a rebuild —
   * a static import would pin the boot-time module forever.
   */
  import(distRelativePath: string): Promise<Record<string, unknown>>;
  /** Register a channel adapter; auto-unregistered when the plugin unloads/reloads. */
  registerAdapter(adapter: ChannelAdapter): void;
  /** Register a health check; auto-unregistered when the plugin unloads/reloads. */
  registerCheck(name: string, checkFn: HealthCheckFn): void;
}

export interface PluginExtension {
  name: string;
  routes?: Record<string, RouteHandler>;
  tasks?: PluginTask[];
  onInit?(ctx: PluginContext): Promise<void> | void;
  onShutdown?(): Promise<void> | void;
}

export interface PluginRecord {
  name: string;
  file: string;
  status: 'loaded' | 'error';
  error: string | null;
  routes: string[];
  tasks: string[];
  /** Channel adapters registered via ctx.registerAdapter (auto-torn-down). */
  adapters: string[];
  /** Health checks registered via ctx.registerCheck (auto-torn-down). */
  checks: string[];
  loadedAt: string | null;
  reloads: number;
}

interface LoadedPlugin {
  record: PluginRecord;
  instance: PluginExtension | null;
}

/** Plugin route patterns must live under this namespace. */
export const PLUGIN_ROUTE_PREFIX = '/api/ext/';

// ── Validation ──────────────────────────────────────────────

function validatePlugin(mod: unknown, file: string): { plugin?: PluginExtension; error?: string } {
  const def = (mod as { default?: unknown } | null)?.default;
  if (!def || typeof def !== 'object') {
    return { error: 'No default export (expected a plugin object)' };
  }
  const p = def as PluginExtension;
  if (typeof p.name !== 'string' || p.name.length === 0) {
    return { error: 'Plugin must have a non-empty string `name`' };
  }
  if (p.routes != null) {
    if (typeof p.routes !== 'object') return { error: '`routes` must be an object of pattern → handler' };
    for (const [pattern, handler] of Object.entries(p.routes)) {
      if (typeof handler !== 'function') {
        return { error: `Route "${pattern}" handler is not a function` };
      }
      if (!pattern.startsWith(PLUGIN_ROUTE_PREFIX)) {
        return { error: `Route "${pattern}" outside plugin namespace — patterns must start with ${PLUGIN_ROUTE_PREFIX}` };
      }
    }
  }
  if (p.tasks != null) {
    if (!Array.isArray(p.tasks)) return { error: '`tasks` must be an array' };
    for (const t of p.tasks) {
      if (!t || typeof t.name !== 'string' || t.name.length === 0 || typeof t.run !== 'function' ||
          !t.schedule || typeof t.schedule !== 'object') {
        return { error: `Invalid task in "${file}" — each task needs { name, schedule, run }` };
      }
    }
  }
  return { plugin: p };
}

function msToIntervalString(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

// ── PluginManager ───────────────────────────────────────────

export class PluginManager {
  private readonly _dir: string;
  private readonly _config: KithkitConfig;
  private readonly _getScheduler: () => Scheduler | null;
  private readonly _debounceMs: number;
  private _plugins = new Map<string, LoadedPlugin>(); // key: plugin name
  private _byFile = new Map<string, string>();        // file path → plugin name
  private _watcher: fs.FSWatcher | null = null;
  private _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _seq = 0; // monotonic cache-bust counter

  constructor(opts: {
    dir: string;
    config: KithkitConfig;
    /** Scheduler accessor — resolved lazily because the scheduler is created by the extension after boot. */
    getScheduler: () => Scheduler | null;
    debounceMs?: number;
  }) {
    this._dir = path.isAbsolute(opts.dir) ? opts.dir : path.resolve(getProjectDir(), opts.dir);
    this._config = opts.config;
    this._getScheduler = opts.getScheduler;
    this._debounceMs = opts.debounceMs ?? 300;
  }

  get dir(): string {
    return this._dir;
  }

  list(): PluginRecord[] {
    return [...this._plugins.values()].map(p => ({ ...p.record }));
  }

  /** Scan the plugins directory: load new files, reload known ones, unload removed ones. */
  async scan(): Promise<PluginRecord[]> {
    if (!fs.existsSync(this._dir) || !fs.statSync(this._dir).isDirectory()) {
      log.debug('Plugins directory not found — nothing to scan', { dir: this._dir });
      return this.list();
    }
    const files = fs.readdirSync(this._dir).filter(f => f.endsWith('.js')).map(f => path.join(this._dir, f));

    // Unload plugins whose file disappeared
    for (const [file, name] of [...this._byFile.entries()]) {
      if (!files.includes(file)) {
        await this.unload(name);
      }
    }
    // Load/reload every present file
    for (const file of files) {
      await this.loadFile(file);
    }
    return this.list();
  }

  /**
   * Load (or reload) one plugin file. Transactional: on any failure the
   * plugin's partial registrations are rolled back and the error recorded.
   */
  async loadFile(file: string): Promise<PluginRecord> {
    const absFile = path.resolve(file);

    // If this file previously produced a plugin, tear that instance down first.
    const priorName = this._byFile.get(absFile);
    if (priorName) {
      await this._teardown(priorName, /* keepRecord */ true);
    }

    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(absFile).mtimeMs;
    } catch {
      const rec = this._errorRecord(priorName ?? path.basename(absFile, '.js'), absFile, `Cannot stat file: ${absFile}`);
      return rec;
    }

    let mod: unknown;
    try {
      mod = await import(`${pathToFileURL(absFile).href}?v=${mtimeMs}-${++this._seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Plugin import failed', { file: absFile, error: msg });
      return this._errorRecord(priorName ?? path.basename(absFile, '.js'), absFile, `Import failed: ${msg}`);
    }

    const { plugin, error } = validatePlugin(mod, absFile);
    if (!plugin) {
      log.error('Plugin validation failed', { file: absFile, error });
      return this._errorRecord(priorName ?? path.basename(absFile, '.js'), absFile, error!);
    }

    // Name collision with a DIFFERENT file's plugin
    const existing = this._plugins.get(plugin.name);
    if (existing && existing.record.file !== absFile && existing.record.status === 'loaded') {
      const msg = `Plugin name "${plugin.name}" already loaded from ${existing.record.file}`;
      log.error(msg, { file: absFile });
      return this._errorRecord(plugin.name + ':' + path.basename(absFile, '.js'), absFile, msg);
    }

    // Register routes (rollback on partial failure)
    const registeredRoutes: string[] = [];
    for (const [pattern, handler] of Object.entries(plugin.routes ?? {})) {
      try {
        registerRoute(pattern, this._wrapHandler(plugin.name, handler));
        registeredRoutes.push(pattern);
      } catch (err) {
        for (const p of registeredRoutes) unregisterRoute(p);
        const msg = `Route registration failed for "${pattern}": ${err instanceof Error ? err.message : String(err)}`;
        log.error(msg, { plugin: plugin.name });
        return this._errorRecord(plugin.name, absFile, msg);
      }
    }

    // Register scheduler tasks (rollback on conflict/failure)
    const registeredTasks: string[] = [];
    const scheduler = this._getScheduler();
    for (const t of plugin.tasks ?? []) {
      if (!scheduler) {
        for (const p of registeredRoutes) unregisterRoute(p);
        return this._errorRecord(plugin.name, absFile, `Task "${t.name}" declared but no scheduler is available`);
      }
      if (scheduler.hasHandler(t.name)) {
        for (const p of registeredRoutes) unregisterRoute(p);
        for (const name of registeredTasks) scheduler.removeTask(name);
        const msg = `Task name "${t.name}" already registered with the scheduler`;
        log.error(msg, { plugin: plugin.name });
        return this._errorRecord(plugin.name, absFile, msg);
      }
      const taskConfig = t.schedule.type === 'cron'
        ? { name: t.name, enabled: true, cron: t.schedule.expression, config: {} }
        : { name: t.name, enabled: true, interval: msToIntervalString(t.schedule.ms), config: {} };
      scheduler.addTask(taskConfig);
      scheduler.registerHandler(t.name, ctx => Promise.resolve(t.run(ctx)));
      registeredTasks.push(t.name);
    }

    // onInit — rollback everything if it throws. The context tracks what the
    // plugin registers through it (adapters, checks) so teardown can remove
    // them when the plugin unloads or reloads.
    const ctxAdapters: string[] = [];
    const ctxChecks: string[] = [];
    if (plugin.onInit) {
      try {
        await plugin.onInit({
          config: this._config,
          projectDir: getProjectDir(),
          log: createLogger(`plugin:${plugin.name}`),
          db: { query, exec },
          scheduler: this._getScheduler(),
          import: (distRelativePath: string) => this._importFrameworkModule(distRelativePath),
          registerAdapter: (adapter: ChannelAdapter) => {
            registerAdapter(adapter);
            ctxAdapters.push(adapter.name);
          },
          registerCheck: (name: string, checkFn: HealthCheckFn) => {
            registerCheck(name, checkFn);
            ctxChecks.push(name);
          },
        });
      } catch (err) {
        for (const p of registeredRoutes) unregisterRoute(p);
        if (scheduler) for (const name of registeredTasks) scheduler.removeTask(name);
        for (const name of ctxAdapters) unregisterAdapter(name);
        for (const name of ctxChecks) unregisterCheck(name);
        const msg = `onInit failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error(msg, { plugin: plugin.name });
        return this._errorRecord(plugin.name, absFile, msg);
      }
    }

    const prior = priorName ? this._plugins.get(priorName) : undefined;
    const record: PluginRecord = {
      name: plugin.name,
      file: absFile,
      status: 'loaded',
      error: null,
      routes: registeredRoutes,
      tasks: registeredTasks,
      adapters: ctxAdapters,
      checks: ctxChecks,
      loadedAt: new Date().toISOString(),
      reloads: prior ? prior.record.reloads + 1 : 0,
    };
    // If the file's plugin was renamed, drop the stale name entry.
    if (priorName && priorName !== plugin.name) this._plugins.delete(priorName);
    this._plugins.set(plugin.name, { record, instance: plugin });
    this._byFile.set(absFile, plugin.name);
    log.info(prior ? 'Plugin reloaded' : 'Plugin loaded', {
      plugin: plugin.name,
      routes: registeredRoutes.length,
      tasks: registeredTasks.length,
      reloads: record.reloads,
    });
    return { ...record };
  }

  /** Reload a plugin by name (re-imports its file). */
  async reload(name: string): Promise<PluginRecord | null> {
    const p = this._plugins.get(name);
    if (!p) return null;
    return this.loadFile(p.record.file);
  }

  /** Unload a plugin: onShutdown + unregister routes/tasks + forget it. */
  async unload(name: string): Promise<boolean> {
    const p = this._plugins.get(name);
    if (!p) return false;
    await this._teardown(name, false);
    log.info('Plugin unloaded', { plugin: name });
    return true;
  }

  /** Watch the plugins directory for changes (JobsWatcher debounce pattern). */
  startWatching(): void {
    if (this._watcher) return;
    if (!fs.existsSync(this._dir) || !fs.statSync(this._dir).isDirectory()) {
      log.debug('Plugins directory not found — watch disabled', { dir: this._dir });
      return;
    }
    try {
      this._watcher = fs.watch(this._dir, (_event, filename) => {
        if (!filename || !filename.endsWith('.js')) return;
        const existing = this._debounceTimers.get(filename);
        if (existing) clearTimeout(existing);
        this._debounceTimers.set(filename, setTimeout(() => {
          this._debounceTimers.delete(filename);
          const filePath = path.join(this._dir, filename);
          if (fs.existsSync(filePath)) {
            void this.loadFile(filePath);
          } else {
            const name = this._byFile.get(path.resolve(filePath));
            if (name) void this.unload(name);
          }
        }, this._debounceMs));
      });
      log.info('Plugin watcher started', { dir: this._dir });
    } catch (err) {
      log.error('Failed to start plugin watcher', { dir: this._dir, error: String(err) });
    }
  }

  /** Stop watching and shut down every loaded plugin (daemon shutdown path). */
  async stop(): Promise<void> {
    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    for (const name of [...this._plugins.keys()]) {
      await this._teardown(name, true);
    }
    log.debug('Plugin manager stopped');
  }

  // ── Private ───────────────────────────────────────────────

  /**
   * Cache-busted import of a compiled daemon module by dist-relative path.
   * Resolved against the daemon dist root (this module lives in dist/core/).
   * Path-traversal is rejected: plugins may only import modules under dist.
   */
  private async _importFrameworkModule(distRelativePath: string): Promise<Record<string, unknown>> {
    const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const resolved = path.resolve(distRoot, distRelativePath);
    if (!resolved.startsWith(distRoot + path.sep)) {
      throw new Error(`ctx.import: path escapes the daemon dist root: ${distRelativePath}`);
    }
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(resolved).mtimeMs;
    } catch {
      throw new Error(`ctx.import: module not found: ${distRelativePath}`);
    }
    return await import(`${pathToFileURL(resolved).href}?v=${mtimeMs}-${++this._seq}`) as Record<string, unknown>;
  }

  /** Per-request containment: a throwing plugin handler must not 500 the daemon loop unhandled. */
  private _wrapHandler(pluginName: string, handler: RouteHandler): RouteHandler {
    return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, searchParams: URLSearchParams) => {
      try {
        return await handler(req, res, pathname, searchParams);
      } catch (err) {
        log.error('Plugin route handler threw', { plugin: pluginName, path: pathname, error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Plugin "${pluginName}" handler error` }));
        }
        return true;
      }
    };
  }

  private async _teardown(name: string, keepRecord: boolean): Promise<void> {
    const p = this._plugins.get(name);
    if (!p) return;
    if (p.instance?.onShutdown) {
      try {
        await p.instance.onShutdown();
      } catch (err) {
        log.warn('Plugin onShutdown threw (continuing teardown)', { plugin: name, error: String(err) });
      }
    }
    for (const pattern of p.record.routes) unregisterRoute(pattern);
    const scheduler = this._getScheduler();
    if (scheduler) {
      for (const taskName of p.record.tasks) {
        try { scheduler.removeTask(taskName); } catch { /* already gone */ }
      }
    }
    for (const adapterName of p.record.adapters) {
      try { unregisterAdapter(adapterName); } catch { /* already gone */ }
    }
    for (const checkName of p.record.checks) unregisterCheck(checkName);
    p.instance = null;
    p.record.routes = [];
    p.record.tasks = [];
    p.record.adapters = [];
    p.record.checks = [];
    if (!keepRecord) {
      this._plugins.delete(name);
      this._byFile.delete(p.record.file);
    }
  }

  private _errorRecord(name: string, file: string, error: string): PluginRecord {
    const prior = this._plugins.get(name);
    const record: PluginRecord = {
      name,
      file,
      status: 'error',
      error,
      routes: [],
      tasks: [],
      adapters: [],
      checks: [],
      loadedAt: prior?.record.loadedAt ?? null,
      reloads: prior?.record.reloads ?? 0,
    };
    this._plugins.set(name, { record, instance: null });
    this._byFile.set(path.resolve(file), name);
    return { ...record };
  }
}

// ── Singleton wiring (used by main.ts + api/extensions.ts) ──

let _manager: PluginManager | null = null;

export function initPluginManager(opts: ConstructorParameters<typeof PluginManager>[0]): PluginManager {
  _manager = new PluginManager(opts);
  return _manager;
}

export function getPluginManager(): PluginManager | null {
  return _manager;
}

export function _resetPluginManagerForTesting(): void {
  _manager = null;
}
